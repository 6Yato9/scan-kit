package expo.modules.visionocr

import expo.modules.visionocr.QuadMath.Pt
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Finds the page outline in an upright grey image: the Android stand-in for
 * Apple Vision's rectangle detection (DocumentGeometry.detect). Pure Kotlin,
 * no OpenCV (nothing added to the APK) and no android.*, so it is tested on
 * the JVM against the same photos as iOS.
 *
 * The page is the region the page's edges enclose:
 *  1. Edges: Gaussian blur, Sobel, non-maximum suppression and hysteresis
 *     (Canny), then a small dilation to close hairline gaps.
 *  2. Regions: connected areas without edges. The page's inside is one such
 *     area (text only punches holes in it), the table around it another.
 *     A second pass with a bigger dilation closes wider gaps in a faint edge,
 *     and a third takes the bright regions (Otsu), for a page whose edge
 *     against a pale table is too weak for an edge detector.
 *  3. Quad: the region's convex hull, then the largest quadrilateral on the
 *     hull's corners (holes and a thumb over a corner don't change a hull).
 *  4. Refinement: each side is moved onto the strongest edge across it (sub-
 *     pixel, robust line fit), corners re-intersected. A side lying on the
 *     frame's border (the page runs out of the picture) stays there.
 *  5. Judgement: plausible as a page (PageGeometry.plausible, like iOS), the
 *     region quad-shaped, and real edges along the sides; the largest such
 *     outline wins (iOS keeps the larger of its detectors' outlines too).
 */
object PageDetector {
  /** Long edge the image is analysed at (pixels). Live frames use less. */
  const val STILL_WORK_EDGE = 640
  const val LIVE_WORK_EDGE = 400

  /** Gradient magnitude (Sobel on 0..255 after the blur) of a weak and a strong edge. */
  private const val LOW = 10f
  private const val HIGH = 26f

  /** Narrowest sheet accepted (short side / long side): a long receipt passes, a plank doesn't. */
  private const val MIN_ASPECT = 0.2
  /** cos 45 degrees: corners may lean that far from square (strong perspective). */
  private const val MAX_CORNER_COS = 0.7072

  class Result(val quad: List<Pt>, val support: Double, val source: String)

  /** Tests and tuning: told why each candidate region was turned down. */
  @Volatile var trace: ((String) -> Unit)? = null

  /**
   * Page outline (normalised, TL, TR, BR, BL, top-left origin) or null, with
   * NO inset (callers apply PageGeometry.inset like iOS does).
   */
  fun detect(image: GrayImage, minArea: Double = 0.15, maxArea: Double = 0.985,
             workEdge: Int = STILL_WORK_EDGE): List<Pt>? = detectDetailed(image, minArea, maxArea, workEdge)?.quad

  fun detectDetailed(image: GrayImage, minArea: Double = 0.15, maxArea: Double = 0.985,
                     workEdge: Int = STILL_WORK_EDGE): Result? {
    val img = image.scaledTo(workEdge)
    val w = img.width
    val h = img.height
    if (w < 16 || h < 16) return null
    val ctx = Work(img)
    val candidates = ArrayList<Result>()
    val edges = ctx.canny()
    for ((name, dilation) in listOf("edges" to 1, "edges2" to 2)) {
      val closed = dilate(edges, w, h, dilation)
      // Regions are the pixels that are NOT edges.
      for (b in closed.indices) closed[b] = if (closed[b].toInt() == 0) 1 else 0
      candidates += ctx.regionQuads(closed, minArea, maxArea, name)
    }
    candidates += ctx.regionQuads(ctx.brightMask(), minArea, maxArea, "bright")
    return candidates.maxByOrNull { QuadMath.area(it.quad) }
  }

  // ── Work image ────────────────────────────────────────────────────────────

  private class Work(val img: GrayImage) {
    val w = img.width
    val h = img.height
    val blur: FloatArray = gaussian(img)
    val gx = FloatArray(w * h)
    val gy = FloatArray(w * h)
    val mag = FloatArray(w * h)

    init {
      for (y in 1 until h - 1) {
        for (x in 1 until w - 1) {
          val i = y * w + x
          val a = blur[i - w - 1]; val b = blur[i - w]; val c = blur[i - w + 1]
          val d = blur[i - 1]; val f = blur[i + 1]
          val g = blur[i + w - 1]; val hh = blur[i + w]; val k = blur[i + w + 1]
          val sx = (c + 2 * f + k) - (a + 2 * d + g)
          val sy = (g + 2 * hh + k) - (a + 2 * b + c)
          gx[i] = sx
          gy[i] = sy
          mag[i] = sqrt(sx * sx + sy * sy)
        }
      }
    }

    /** Canny edge map (1 = edge). */
    fun canny(): ByteArray {
      val nms = FloatArray(w * h)
      for (y in 1 until h - 1) {
        for (x in 1 until w - 1) {
          val i = y * w + x
          val m = mag[i]
          if (m < LOW) continue
          val ax = abs(gx[i])
          val ay = abs(gy[i])
          // Neighbours across the edge (along the gradient), 4 directions.
          val (n1, n2) = when {
            ay <= ax * 0.4142f -> i - 1 to i + 1
            ay >= ax * 2.4142f -> i - w to i + w
            (gx[i] > 0) == (gy[i] > 0) -> i - w - 1 to i + w + 1
            else -> i - w + 1 to i + w - 1
          }
          if (m >= mag[n1] && m > mag[n2]) nms[i] = m
        }
      }
      val out = ByteArray(w * h)
      val stack = IntArray(w * h)
      var sp = 0
      for (i in nms.indices) {
        if (nms[i] >= HIGH && out[i].toInt() == 0) {
          out[i] = 1
          stack[sp++] = i
          while (sp > 0) {
            val p = stack[--sp]
            val px = p % w
            val py = p / w
            for (dy in -1..1) {
              val yy = py + dy
              if (yy < 0 || yy >= h) continue
              for (dx in -1..1) {
                val xx = px + dx
                if (xx < 0 || xx >= w) continue
                val q = yy * w + xx
                if (out[q].toInt() == 0 && nms[q] >= LOW) {
                  out[q] = 1
                  stack[sp++] = q
                }
              }
            }
          }
        }
      }
      return out
    }

    /** 1 where the blurred image is brighter than its Otsu threshold. */
    fun brightMask(): ByteArray {
      val hist = IntArray(256)
      for (v in blur) hist[min(255, max(0, v.toInt()))]++
      val total = blur.size.toDouble()
      var sumAll = 0.0
      for (i in 0 until 256) sumAll += i * hist[i].toDouble()
      var sumB = 0.0
      var wB = 0.0
      var best = 0.0
      var threshold = 128
      for (t in 0 until 256) {
        wB += hist[t]
        if (wB == 0.0) continue
        val wF = total - wB
        if (wF == 0.0) break
        sumB += t * hist[t].toDouble()
        val mB = sumB / wB
        val mF = (sumAll - sumB) / wF
        val between = wB * wF * (mB - mF) * (mB - mF)
        if (between > best) {
          best = between
          threshold = t
        }
      }
      val out = ByteArray(w * h)
      for (i in blur.indices) out[i] = if (blur[i] > threshold) 1 else 0
      // Erode once: a hairline of bright table touching the page no longer joins it.
      return erode(out, w, h)
    }

    /** Quads of the large connected regions (value 1) of `mask`. */
    fun regionQuads(mask: ByteArray, minArea: Double, maxArea: Double, source: String): List<Result> {
      val labels = IntArray(w * h)
      val stack = IntArray(w * h)
      val counts = ArrayList<Int>()
      counts += 0
      var next = 1
      for (start in mask.indices) {
        if (mask[start].toInt() == 0 || labels[start] != 0) continue
        val label = next++
        var count = 0
        var sp = 0
        stack[sp++] = start
        labels[start] = label
        while (sp > 0) {
          val p = stack[--sp]
          count++
          val px = p % w
          if (px > 0 && mask[p - 1].toInt() != 0 && labels[p - 1] == 0) { labels[p - 1] = label; stack[sp++] = p - 1 }
          if (px < w - 1 && mask[p + 1].toInt() != 0 && labels[p + 1] == 0) { labels[p + 1] = label; stack[sp++] = p + 1 }
          if (p >= w && mask[p - w].toInt() != 0 && labels[p - w] == 0) { labels[p - w] = label; stack[sp++] = p - w }
          if (p < w * (h - 1) && mask[p + w].toInt() != 0 && labels[p + w] == 0) { labels[p + w] = label; stack[sp++] = p + w }
        }
        counts += count
      }
      // A page's inside keeps well over a third of its area once text is cut out.
      val minPixels = (minArea * 0.3 * w * h).toInt()
      val chosen = HashMap<Int, Int>()
      for (l in 1 until counts.size) if (counts[l] >= minPixels) chosen[l] = chosen.size
      if (chosen.isEmpty()) return emptyList()
      val n = chosen.size
      val rowMin = Array(n) { IntArray(h) { Int.MAX_VALUE } }
      val rowMax = Array(n) { IntArray(h) { -1 } }
      for (y in 0 until h) {
        for (x in 0 until w) {
          val k = chosen[labels[y * w + x]] ?: continue
          if (x < rowMin[k][y]) rowMin[k][y] = x
          if (x > rowMax[k][y]) rowMax[k][y] = x
        }
      }
      val out = ArrayList<Result>()
      for (k in 0 until n) {
        val pts = ArrayList<DoubleArray>()
        for (y in 0 until h) {
          if (rowMax[k][y] < 0) continue
          // Pixel edges, not centres: the region's outer outline.
          pts += doubleArrayOf(rowMin[k][y].toDouble(), y.toDouble())
          pts += doubleArrayOf(rowMin[k][y].toDouble(), y + 1.0)
          pts += doubleArrayOf(rowMax[k][y] + 1.0, y.toDouble())
          pts += doubleArrayOf(rowMax[k][y] + 1.0, y + 1.0)
        }
        val hull = convexHull(pts)
        if (hull.size < 4) continue
        val hullArea = polygonArea(hull)
        val simple = simplify(hull, 1.0)
        // Two readings of the hull: its largest inscribed quad (exact when
        // all four corners are visible), and its four longest sides extended
        // until they meet (restores a corner hidden under a thumb or cut by
        // a fold). Each is refined and judged; the better-backed one stays.
        var best: Result? = null
        for (quad in listOfNotNull(maxAreaQuad(simple), sidesQuad(simple, w, h))) {
          val quadArea = polygonArea(quad)
          // A region that leaked into the table is not quad-shaped.
          if (quadArea < hullArea * 0.9) {
            trace?.invoke("$source: not quad-shaped (%.2f)".format(quadArea / hullArea))
            continue
          }
          val judged = judge(quad, minArea, maxArea, source) ?: continue
          val b = best
          if (b == null || judged.support > b.support + 0.02 ||
            (judged.support > b.support - 0.02 && QuadMath.area(judged.quad) > QuadMath.area(b.quad))) best = judged
        }
        best?.let { out += it }
      }
      return out
    }

    /** Refines `px` (pixel corners), checks it and returns it normalised, or null. */
    private fun judge(px: List<DoubleArray>, minArea: Double, maxArea: Double, source: String): Result? {
      val ordered = PageGeometry.orderUpright(px.map { Pt(it[0] / w, it[1] / h) })
      if (!QuadMath.isConvexClockwise(ordered)) return null
      // Refine every side on the image gradient; sides along the frame stay.
      val corners = ordered.map { Pt(it.x * w, it.y * h) }
      val lines = arrayOfNulls<Line>(4)
      var supportSum = 0.0
      var minSupport = 1.0
      var borderSides = 0
      for (i in 0 until 4) {
        val a = corners[i]
        val b = corners[(i + 1) % 4]
        if (onSameBorder(a, b)) {
          lines[i] = Line.through(a, b)
          borderSides++
          supportSum += 1.0
          continue
        }
        val fit = refineSide(a, b)
        lines[i] = fit.line ?: Line.through(a, b)
        supportSum += fit.support
        minSupport = min(minSupport, fit.support)
      }
      val mean = supportSum / 4
      if (borderSides >= 3) return null
      // Real paper edges along (nearly) every side.
      if (minSupport < 0.45 || mean < 0.65) {
        trace?.invoke("$source: weak edges (min %.2f, mean %.2f)".format(minSupport, mean))
        return null
      }
      val refined = ArrayList<Pt>(4)
      for (i in 0 until 4) {
        val p = lines[(i + 3) % 4]!!.intersect(lines[i]!!) ?: return null
        refined += p
      }
      // Refinement only nudges: a corner flying off means a bad fit.
      val diag = hypot(w.toDouble(), h.toDouble())
      val moved = (0 until 4).maxOf { hypot(refined[it].x - corners[it].x, refined[it].y - corners[it].y) }
      val chosen = if (moved > diag * 0.03) corners else refined
      // Shaped like a sheet seen by a camera (as Vision's rectangle detector
      // demands): not a sliver (a plank, a door frame), no corner far from
      // square even in perspective.
      if (!sheetShaped(chosen)) {
        trace?.invoke("$source: not sheet-shaped ${describe(chosen.map { Pt(it.x / w, it.y / h) })}")
        return null
      }
      val norm = PageGeometry.clamp(chosen.map { Pt(it.x / w, it.y / h) })
      if (!PageGeometry.isFinite(norm) || !PageGeometry.plausible(norm, minArea, maxArea)) {
        trace?.invoke("$source: implausible ${describe(norm)} area %.3f".format(QuadMath.area(norm)))
        return null
      }
      return Result(norm, mean, source)
    }

    /** Short / long side at least MIN_ASPECT, every corner within 45 degrees of square (pixel space). */
    private fun sheetShaped(q: List<Pt>): Boolean {
      fun len(i: Int) = hypot(q[(i + 1) % 4].x - q[i].x, q[(i + 1) % 4].y - q[i].y)
      val across = (len(0) + len(2)) / 2
      val down = (len(1) + len(3)) / 2
      if (min(across, down) < max(across, down) * MIN_ASPECT) return false
      for (i in 0 until 4) {
        val p = q[(i + 3) % 4]
        val c = q[i]
        val n = q[(i + 1) % 4]
        val ax = p.x - c.x
        val ay = p.y - c.y
        val bx = n.x - c.x
        val by = n.y - c.y
        val la = hypot(ax, ay)
        val lb = hypot(bx, by)
        if (la <= 0 || lb <= 0) return false
        val cos = (ax * bx + ay * by) / (la * lb)
        if (abs(cos) > MAX_CORNER_COS) return false
      }
      return true
    }

    private fun onSameBorder(a: Pt, b: Pt): Boolean {
      val t = 2.5
      return (a.x < t && b.x < t) || (a.y < t && b.y < t) ||
        (a.x > w - t && b.x > w - t) || (a.y > h - t && b.y > h - t)
    }

    class SideFit(val line: Line?, val support: Double)

    /**
     * Moves the side a -> b onto the paper edge: along the side, the strongest
     * gradient across it within a few pixels (pointing the same way as the
     * side's normal), then a robust least-squares line through those points.
     * `support` is the share of the side backed by such an edge.
     */
    private fun refineSide(a: Pt, b: Pt): SideFit {
      val len = hypot(b.x - a.x, b.y - a.y)
      if (len < 8) return SideFit(null, 0.0)
      val tx = (b.x - a.x) / len
      val ty = (b.y - a.y) / len
      val nx = -ty
      val ny = tx
      val samples = max(12, (len / 2).toInt())
      val reach = max(3.0, min(w, h) * 0.012)
      val xs = ArrayList<Double>(samples)
      val ys = ArrayList<Double>(samples)
      for (k in 0 until samples) {
        val t = 0.06 + 0.88 * (k + 0.5) / samples
        val cx = a.x + (b.x - a.x) * t
        val cy = a.y + (b.y - a.y) * t
        var bestS = Double.NaN
        var bestM = 0.0
        var s = -reach
        val stepS = 0.5
        val mags = ArrayList<Double>()
        val offs = ArrayList<Double>()
        while (s <= reach + 1e-9) {
          // Gradient arrays are indexed by pixel; pixel i's centre is at i + 0.5.
          val m = sampleAligned(cx - 0.5 + nx * s, cy - 0.5 + ny * s, nx, ny)
          mags += m
          offs += s
          if (m > bestM) {
            bestM = m
            bestS = s
          }
          s += stepS
        }
        if (bestS.isNaN() || bestM < HIGH * 0.75) continue
        // Sub-pixel: parabola through the peak and its neighbours.
        val idx = offs.indexOf(bestS)
        var off = bestS
        if (idx > 0 && idx < mags.size - 1) {
          val m0 = mags[idx - 1]
          val m2 = mags[idx + 1]
          val den = m0 - 2 * bestM + m2
          if (den < 0) off += stepS * 0.5 * (m0 - m2) / den
        }
        xs += cx + nx * off
        ys += cy + ny * off
      }
      if (xs.size < samples * 0.25) return SideFit(null, xs.size.toDouble() / samples)
      var line = Line.fit(xs, ys, null) ?: return SideFit(null, 0.0)
      var inliers = xs.size
      repeat(2) {
        val keep = BooleanArray(xs.size) { line.distance(xs[it], ys[it]) <= 1.25 }
        inliers = keep.count { it }
        if (inliers >= 3) line = Line.fit(xs, ys, keep) ?: line
      }
      return SideFit(line, inliers.toDouble() / samples)
    }

    /** Gradient magnitude at (x, y) (bilinear) when it points across the side, else 0. */
    private fun sampleAligned(x: Double, y: Double, nx: Double, ny: Double): Double {
      if (x < 1 || y < 1 || x >= w - 2 || y >= h - 2) return 0.0
      val x0 = x.toInt()
      val y0 = y.toInt()
      val fx = x - x0
      val fy = y - y0
      fun bil(arr: FloatArray): Double {
        val i = y0 * w + x0
        return (arr[i] * (1 - fx) + arr[i + 1] * fx) * (1 - fy) + (arr[i + w] * (1 - fx) + arr[i + w + 1] * fx) * fy
      }
      val m = bil(mag)
      if (m <= 0) return 0.0
      val dot = (bil(gx) * nx + bil(gy) * ny) / m
      // Within ~35 degrees of the normal (either way: dark or light page).
      return if (abs(dot) >= 0.82) m else 0.0
    }
  }

  // ── Small pieces ──────────────────────────────────────────────────────────

  class Line(val a: Double, val b: Double, val c: Double) {
    // a*x + b*y = c with a^2 + b^2 = 1.
    fun distance(x: Double, y: Double) = abs(a * x + b * y - c)

    fun intersect(o: Line): Pt? {
      val det = a * o.b - b * o.a
      if (abs(det) < 1e-9) return null
      return Pt((c * o.b - b * o.c) / det, (a * o.c - c * o.a) / det)
    }

    companion object {
      fun through(p: Pt, q: Pt): Line {
        val dx = q.x - p.x
        val dy = q.y - p.y
        val len = hypot(dx, dy).takeIf { it > 0 } ?: 1.0
        val a = -dy / len
        val b = dx / len
        return Line(a, b, a * p.x + b * p.y)
      }

      /** Total least squares through the points (those `keep` marks). */
      fun fit(xs: List<Double>, ys: List<Double>, keep: BooleanArray?): Line? {
        var n = 0
        var mx = 0.0
        var my = 0.0
        for (i in xs.indices) if (keep == null || keep[i]) { mx += xs[i]; my += ys[i]; n++ }
        if (n < 2) return null
        mx /= n
        my /= n
        var sxx = 0.0
        var syy = 0.0
        var sxy = 0.0
        for (i in xs.indices) if (keep == null || keep[i]) {
          val dx = xs[i] - mx
          val dy = ys[i] - my
          sxx += dx * dx
          syy += dy * dy
          sxy += dx * dy
        }
        // Direction of largest spread; the normal is perpendicular to it.
        val theta = 0.5 * atan2(2 * sxy, sxx - syy)
        val a = -sin(theta)
        val b = cos(theta)
        return Line(a, b, a * mx + b * my)
      }
    }
  }

  private fun gaussian(img: GrayImage): FloatArray {
    // Separable 5-tap binomial (sigma ~1).
    val w = img.width
    val h = img.height
    val tmp = FloatArray(w * h)
    val out = FloatArray(w * h)
    for (y in 0 until h) {
      val row = y * w
      for (x in 0 until w) {
        fun p(xx: Int) = img.at(min(w - 1, max(0, xx)), y).toFloat()
        tmp[row + x] = (p(x - 2) + 4 * p(x - 1) + 6 * p(x) + 4 * p(x + 1) + p(x + 2)) / 16f
      }
    }
    for (y in 0 until h) {
      for (x in 0 until w) {
        fun p(yy: Int) = tmp[min(h - 1, max(0, yy)) * w + x]
        out[y * w + x] = (p(y - 2) + 4 * p(y - 1) + 6 * p(y) + 4 * p(y + 1) + p(y + 2)) / 16f
      }
    }
    return out
  }

  private fun dilate(src: ByteArray, w: Int, h: Int, times: Int): ByteArray {
    var cur = src.copyOf()
    repeat(times) {
      val next = ByteArray(w * h)
      for (y in 0 until h) {
        for (x in 0 until w) {
          var on = false
          loop@ for (dy in -1..1) {
            val yy = y + dy
            if (yy < 0 || yy >= h) continue
            for (dx in -1..1) {
              val xx = x + dx
              if (xx < 0 || xx >= w) continue
              if (cur[yy * w + xx].toInt() != 0) { on = true; break@loop }
            }
          }
          if (on) next[y * w + x] = 1
        }
      }
      cur = next
    }
    return cur
  }

  private fun erode(src: ByteArray, w: Int, h: Int): ByteArray {
    val out = ByteArray(w * h)
    for (y in 1 until h - 1) {
      for (x in 1 until w - 1) {
        val i = y * w + x
        if (src[i].toInt() != 0 && src[i - 1].toInt() != 0 && src[i + 1].toInt() != 0 &&
          src[i - w].toInt() != 0 && src[i + w].toInt() != 0) out[i] = 1
      }
    }
    // Keep the frame's border rows: a page running out of the picture stays whole.
    for (x in 0 until w) {
      out[x] = if (src[x].toInt() != 0 && src[x + w].toInt() != 0) 1 else 0
      out[(h - 1) * w + x] = if (src[(h - 1) * w + x].toInt() != 0 && src[(h - 2) * w + x].toInt() != 0) 1 else 0
    }
    for (y in 0 until h) {
      out[y * w] = if (src[y * w].toInt() != 0 && src[y * w + 1].toInt() != 0) 1 else 0
      out[y * w + w - 1] = if (src[y * w + w - 1].toInt() != 0 && src[y * w + w - 2].toInt() != 0) 1 else 0
    }
    return out
  }

  /** Andrew's monotone chain; counter-clockwise in y-up terms (any consistent order is fine). */
  fun convexHull(points: List<DoubleArray>): List<DoubleArray> {
    val pts = points.sortedWith(compareBy<DoubleArray>({ it[0] }, { it[1] }))
    if (pts.size < 3) return pts
    fun cross(o: DoubleArray, a: DoubleArray, b: DoubleArray) = (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    val lower = ArrayList<DoubleArray>()
    for (p in pts) {
      while (lower.size >= 2 && cross(lower[lower.size - 2], lower[lower.size - 1], p) <= 0) lower.removeAt(lower.size - 1)
      lower += p
    }
    val upper = ArrayList<DoubleArray>()
    for (p in pts.asReversed()) {
      while (upper.size >= 2 && cross(upper[upper.size - 2], upper[upper.size - 1], p) <= 0) upper.removeAt(upper.size - 1)
      upper += p
    }
    lower.removeAt(lower.size - 1)
    upper.removeAt(upper.size - 1)
    return lower + upper
  }

  fun polygonArea(p: List<DoubleArray>): Double {
    var s = 0.0
    for (i in p.indices) {
      val a = p[i]
      val b = p[(i + 1) % p.size]
      s += a[0] * b[1] - b[0] * a[1]
    }
    return abs(s) / 2
  }

  /** Drops hull vertices closer than `eps` to the line through their neighbours (keeps a closed convex polygon). */
  private fun simplify(hull: List<DoubleArray>, eps: Double): List<DoubleArray> {
    var cur = hull
    var changed = true
    while (changed && cur.size > 4) {
      changed = false
      var bestI = -1
      var bestD = eps
      for (i in cur.indices) {
        val p = cur[(i + cur.size - 1) % cur.size]
        val q = cur[i]
        val r = cur[(i + 1) % cur.size]
        val len = hypot(r[0] - p[0], r[1] - p[1])
        if (len <= 0) { bestI = i; bestD = 0.0; break }
        val d = abs((r[0] - p[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (r[1] - p[1])) / len
        if (d < bestD) { bestD = d; bestI = i }
      }
      if (bestI >= 0) {
        cur = cur.filterIndexed { i, _ -> i != bestI }
        changed = true
      }
    }
    // Still many: thin out evenly-ish by keeping the most significant corners.
    while (cur.size > 64) {
      var bestI = 0
      var bestD = Double.MAX_VALUE
      for (i in cur.indices) {
        val p = cur[(i + cur.size - 1) % cur.size]
        val q = cur[i]
        val r = cur[(i + 1) % cur.size]
        val d = abs((r[0] - p[0]) * (q[1] - p[1]) - (q[0] - p[0]) * (r[1] - p[1]))
        if (d < bestD) { bestD = d; bestI = i }
      }
      cur = cur.filterIndexed { i, _ -> i != bestI }
    }
    return cur
  }

  /**
   * The quad whose sides are the four longest straight runs of the convex
   * polygon `p` (consecutive edges turning less than ~12 degrees merged),
   * extended to meet. Null when that doesn't make a sensible quad.
   */
  private fun sidesQuad(p: List<DoubleArray>, w: Int, h: Int): List<DoubleArray>? {
    val n = p.size
    if (n < 4) return null
    class Run(val start: Int, var end: Int, var length: Double)
    fun angle(i: Int): Double {
      val a = p[i]; val b = p[(i + 1) % n]
      return atan2(b[1] - a[1], b[0] - a[0])
    }
    fun len(i: Int): Double {
      val a = p[i]; val b = p[(i + 1) % n]
      return hypot(b[0] - a[0], b[1] - a[1])
    }
    fun turn(a: Double, b: Double): Double {
      var d = b - a
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      return abs(d)
    }
    // Start the walk at the sharpest turn so no run wraps around the start.
    var start = 0
    var sharpest = -1.0
    for (i in 0 until n) {
      val t = turn(angle((i + n - 1) % n), angle(i))
      if (t > sharpest) { sharpest = t; start = i }
    }
    val runs = ArrayList<Run>()
    val limit = 12.0 * Math.PI / 180
    for (k in 0 until n) {
      val i = (start + k) % n
      val last = runs.lastOrNull()
      if (last != null) {
        val a = p[last.start]
        val b = p[i]
        val runAngle = atan2(b[1] - a[1], b[0] - a[0])
        if (turn(runAngle, angle(i)) < limit && turn(angle((i + n - 1) % n), angle(i)) < limit) {
          last.end = (i + 1) % n
          last.length += len(i)
          continue
        }
      }
      runs += Run(i, (i + 1) % n, len(i))
    }
    if (runs.size < 4) return null
    val top = runs.sortedByDescending { it.length }.take(4).sortedBy { (it.start - start + n) % n }
    val lines = top.map { Line.through(Pt(p[it.start][0], p[it.start][1]), Pt(p[it.end][0], p[it.end][1])) }
    val out = ArrayList<DoubleArray>(4)
    for (i in 0 until 4) {
      val c = lines[(i + 3) % 4].intersect(lines[i]) ?: return null
      // A corner may be hidden or out of the picture, not far away.
      if (c.x < -0.25 * w || c.y < -0.25 * h || c.x > 1.25 * w || c.y > 1.25 * h) return null
      out += doubleArrayOf(c.x, c.y)
    }
    return out
  }

  /** The largest-area quadrilateral whose corners are vertices of the convex polygon `p`. */
  private fun maxAreaQuad(p: List<DoubleArray>): List<DoubleArray>? {
    val n = p.size
    if (n < 4) return null
    if (n == 4) return p
    fun tri(i: Int, j: Int, k: Int): Double {
      val a = p[i % n]; val b = p[j % n]; val c = p[k % n]
      return abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2
    }
    var best = -1.0
    var bi = 0; var bj = 0; var bk = 0; var bl = 0
    for (i in 0 until n) {
      for (k in i + 2 until i + n - 1) {
        var mj = -1.0
        var jj = -1
        for (j in i + 1 until k) {
          val t = tri(i, j, k)
          if (t > mj) { mj = t; jj = j }
        }
        var ml = -1.0
        var ll = -1
        for (l in k + 1 until i + n) {
          val t = tri(k, l, i)
          if (t > ml) { ml = t; ll = l }
        }
        if (jj < 0 || ll < 0) continue
        if (mj + ml > best) {
          best = mj + ml
          bi = i; bj = jj; bk = k; bl = ll
        }
      }
    }
    if (best <= 0) return null
    return listOf(p[bi % n], p[bj % n], p[bk % n], p[bl % n])
  }

  /** Rounds a quad's coordinates (normalised) for logs and tests. */
  fun describe(q: List<Pt>?): String =
    q?.joinToString(" ") { "%.4f %.4f".format(it.x, it.y) } ?: "nil"

  @Suppress("unused")
  private fun Double.r() = (this * 1e4).roundToInt() / 1e4
}
