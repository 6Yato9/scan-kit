package expo.modules.visionocr

import expo.modules.visionocr.QuadMath.Pt
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Page-outline geometry shared by detection, the camera and auto-capture: the
 * Kotlin port of the quad helpers in DocumentGeometry.swift (inset,
 * plausibility, corner distance) and its Homography. Same conventions as
 * QuadMath: TL, TR, BR, BL, normalised 0..1, top-left origin, upright.
 * Pure Kotlin (no android.*), covered by JVM unit tests.
 */
object PageGeometry {
  /**
   * Detected outlines are pulled in by this fraction of the page's width and
   * height on every side (DocumentGeometry.detectionInset): about 1 mm of an
   * A4 page, so no sliver of table stays along the page. Only automatic
   * outlines get it; corners a user placed are used as they are.
   */
  const val DETECTION_INSET = 0.005

  fun maxCornerDistance(a: List<Pt>, b: List<Pt>): Double {
    var d = 0.0
    for (i in 0 until 4) d = max(d, hypot(a[i].x - b[i].x, a[i].y - b[i].y))
    return d
  }

  /**
   * `quad` shrunk by `fraction` of the page's own width and height on each
   * side, in the page's perspective (edges stay straight and parallel to the
   * originals as the page sees them). Unchanged when that would break it.
   */
  fun inset(quad: List<Pt>, fraction: Double = DETECTION_INSET): List<Pt> {
    if (fraction <= 0) return quad
    val map = Homography.unitSquareTo(quad) ?: return quad
    val lo = fraction
    val hi = 1 - fraction
    val pts = listOf(map.apply(lo, lo), map.apply(hi, lo), map.apply(hi, hi), map.apply(lo, hi))
    return if (QuadMath.isConvexClockwise(pts)) pts else quad
  }

  /**
   * DocumentGeometry.detect's `plausible`: area within [minArea, maxArea],
   * convex and clockwise, and not a band of background cut off by the frame
   * (three or four corners on the image border) unless the page nearly fills
   * the frame.
   */
  fun plausible(q: List<Pt>, minArea: Double, maxArea: Double = 0.985): Boolean {
    val a = QuadMath.area(q)
    if (a < minArea || a > maxArea || !QuadMath.isConvexClockwise(q)) return false
    val onBorder = q.count { min(min(it.x, it.y), min(1 - it.x, 1 - it.y)) < 0.02 }
    return onBorder < 3 || a >= 0.8
  }

  /**
   * The same four corners, clockwise on screen (y down), starting with the
   * corner whose outgoing edge points most to the right: the page's top-left
   * as the image shows it, whatever order a detector produced them in.
   */
  fun orderUpright(corners: List<Pt>): List<Pt> {
    require(corners.size == 4)
    var pts = corners
    // Signed area (y down): positive = clockwise on screen.
    var s = 0.0
    for (i in 0 until 4) {
      val p = pts[i]
      val n = pts[(i + 1) % 4]
      s += p.x * n.y - n.x * p.y
    }
    if (s < 0) pts = pts.reversed()
    var best = 0
    var bestCos = -2.0
    for (i in 0 until 4) {
      val a = pts[i]
      val b = pts[(i + 1) % 4]
      val len = hypot(b.x - a.x, b.y - a.y)
      if (len <= 0) continue
      val c = (b.x - a.x) / len
      if (c > bestCos + 1e-9) {
        bestCos = c
        best = i
      }
    }
    return List(4) { pts[(best + it) % 4] }
  }

  fun flatten(q: List<Pt>): List<Double> = q.flatMap { listOf(it.x, it.y) }

  /** Corners within 0..1 (a refined edge may land a hair outside the frame). */
  fun clamp(q: List<Pt>): List<Pt> = q.map { Pt(min(1.0, max(0.0, it.x)), min(1.0, max(0.0, it.y))) }

  /** True when the two outlines are within `tol` (normalised) corner by corner. */
  fun near(a: List<Pt>, b: List<Pt>, tol: Double): Boolean = maxCornerDistance(a, b) < tol

  fun isFinite(q: List<Pt>): Boolean = q.all { it.x.isFinite() && it.y.isFinite() } && q.none { abs(it.x) > 1e6 || abs(it.y) > 1e6 }
}

/**
 * The projective map of the unit square onto a quad (corners TL, TR, BR, BL):
 * where the point (u, v) of the flattened page lies in the frame. Same maths as
 * Homography in DocumentGeometry.swift and lib/capture-session.ts quadPoint.
 */
class Homography private constructor(
  private val a: Double, private val b: Double, private val c: Double,
  private val d: Double, private val e: Double, private val f: Double,
  private val g: Double, private val h: Double,
) {
  fun apply(u: Double, v: Double): Pt {
    val w = g * u + h * v + 1
    return Pt((a * u + b * v + c) / w, (d * u + e * v + f) / w)
  }

  companion object {
    fun unitSquareTo(q: List<Pt>): Homography? {
      if (q.size != 4) return null
      val x0 = q[0].x; val y0 = q[0].y; val x1 = q[1].x; val y1 = q[1].y
      val x2 = q[2].x; val y2 = q[2].y; val x3 = q[3].x; val y3 = q[3].y
      val dx1 = x1 - x2; val dx2 = x3 - x2; val dx3 = x0 - x1 + x2 - x3
      val dy1 = y1 - y2; val dy2 = y3 - y2; val dy3 = y0 - y1 + y2 - y3
      var g = 0.0
      var h = 0.0
      val den = dx1 * dy2 - dx2 * dy1
      if (abs(dx3) > 1e-12 || abs(dy3) > 1e-12) {
        if (abs(den) <= 1e-12) return null
        g = (dx3 * dy2 - dx2 * dy3) / den
        h = (dx1 * dy3 - dx3 * dy1) / den
      }
      return Homography(
        x1 - x0 + g * x1, x3 - x0 + h * x3, x0,
        y1 - y0 + g * y1, y3 - y0 + h * y3, y0,
        g, h,
      )
    }
  }
}
