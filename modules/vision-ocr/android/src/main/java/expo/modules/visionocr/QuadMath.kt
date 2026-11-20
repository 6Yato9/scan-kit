package expo.modules.visionocr

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Quad maths shared with iOS (DocumentGeometry.swift) and JS (lib/quad.ts).
 * A quad is 4 points TL, TR, BR, BL, normalised 0..1 with a TOP-LEFT origin,
 * in the image's UPRIGHT orientation. Pure Kotlin (no android.*), so it is
 * covered by JVM unit tests (src/test).
 */
object QuadMath {
  data class Pt(val x: Double, val y: Double)

  /** Corners may sit a hair outside the image (a handle dragged to the edge), never further. */
  const val INPUT_SLACK = 0.01

  fun area(q: List<Pt>): Double {
    var a = 0.0
    for (i in 0 until 4) {
      val p = q[i]
      val n = q[(i + 1) % 4]
      a += p.x * n.y - n.x * p.y
    }
    return abs(a) / 2
  }

  /**
   * TL -> TR -> BR -> BL turns clockwise on screen (y down): every cross
   * product of consecutive edges is positive. Rejects self-intersecting,
   * concave, mirrored and degenerate quads.
   */
  fun isConvexClockwise(q: List<Pt>): Boolean {
    if (q.size != 4) return false
    for (i in 0 until 4) {
      val a = q[i]
      val b = q[(i + 1) % 4]
      val c = q[(i + 2) % 4]
      val cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
      if (!(cross > 1e-6)) return false
    }
    return true
  }

  class BadQuad(message: String) : Exception(message)

  /**
   * Validates JS input exactly like DocumentGeometry.parseQuad: 8 finite
   * numbers within -0.01..1.01 forming a non-degenerate convex quad in TL,
   * TR, BR, BL order. Returns the points clamped into the image.
   */
  fun parse(values: List<Double>): List<Pt> {
    if (values.size != 8) throw BadQuad("A quad needs 8 numbers, got ${values.size}")
    val lo = -INPUT_SLACK
    val hi = 1 + INPUT_SLACK
    for (v in values) {
      if (!v.isFinite() || v < lo || v > hi) throw BadQuad("Quad values must be finite and within 0...1")
    }
    val pts = (0 until 8 step 2).map { Pt(min(1.0, max(0.0, values[it])), min(1.0, max(0.0, values[it + 1]))) }
    if (!isConvexClockwise(pts) || area(pts) < 0.0005) {
      throw BadQuad("Quad must be convex, non-degenerate, ordered top-left, top-right, bottom-right, bottom-left")
    }
    return pts
  }

  /** Integer crop rectangle [left, top, right, bottom) for an upright axis-aligned quad in pixels, or null. */
  fun axisAlignedCrop(px: List<Pt>, width: Int, height: Int, tol: Double = 0.75): IntArray? {
    val aligned = abs(px[0].y - px[1].y) < tol && abs(px[3].y - px[2].y) < tol &&
      abs(px[0].x - px[3].x) < tol && abs(px[1].x - px[2].x) < tol &&
      px[0].x < px[1].x && px[0].y < px[3].y
    if (!aligned) return null
    val minX = (px[0].x + px[3].x) / 2
    val maxX = (px[1].x + px[2].x) / 2
    val minY = (px[0].y + px[1].y) / 2
    val maxY = (px[3].y + px[2].y) / 2
    // CGRect.integral, then intersected with the image.
    val l = max(0, kotlin.math.floor(minX).toInt())
    val t = max(0, kotlin.math.floor(minY).toInt())
    val r = min(width, kotlin.math.ceil(maxX).toInt())
    val b = min(height, kotlin.math.ceil(maxY).toInt())
    return intArrayOf(l, t, r, b)
  }

  fun dist(a: Pt, b: Pt, w: Double, h: Double): Double = Math.hypot((a.x - b.x) * w, (a.y - b.y) * h)

  /** Output size of the corrected page: the longer of each pair of opposite edges, in pixels of a w x h image. */
  fun outputSize(q: List<Pt>, w: Double, h: Double): Pair<Double, Double> {
    val outW = max(dist(q[0], q[1], w, h), dist(q[3], q[2], w, h))
    val outH = max(dist(q[0], q[3], w, h), dist(q[1], q[2], w, h))
    return outW to outH
  }

  /** Long edge, never upscaled: the size a w x h image is drawn at with its long edge capped at `cap`. */
  fun capped(w: Int, h: Int, cap: Int): Pair<Int, Int> {
    val long = max(w, h)
    if (long <= cap) return w to h
    val s = cap.toDouble() / long
    return max(1, Math.round(w * s).toInt()) to max(1, Math.round(h * s).toInt())
  }
}
