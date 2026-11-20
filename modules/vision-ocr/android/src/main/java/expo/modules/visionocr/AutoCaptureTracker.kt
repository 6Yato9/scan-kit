package expo.modules.visionocr

import expo.modules.visionocr.QuadMath.Pt
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Decides when the document camera may auto-capture: a line-for-line port of
 * AutoCaptureTracker.swift (keep them in step). Pure logic, unit-tested on
 * the JVM.
 *
 * Holding still: a hand-held phone never gives a perfectly still outline, so
 * the hold is a budget, not a streak. Each steady frame adds its duration; an
 * unsteady frame (device motion, blur, refocusing, or an outline far off the
 * recent average) takes `decayRate` times its duration back instead of
 * restarting from zero, and a missed detection or two just pauses it. Only a
 * real move (the smoothed outline leaving `tolerance` of where the page has
 * been resting) or losing the page restarts it. Distances are relative to the
 * page's own size.
 *
 * One page, one shot: after a capture it stays disarmed until the page
 * changes — it leaves the frame, a corner moves by `changeDistance`, or its
 * CONTENT changes (PageSignature clearly different from the captured one).
 * Before it fires again it checks that the page isn't the one just captured:
 * a hand passing over the page, or the same sheet lifted and put back, re-arms
 * it but doesn't shoot it twice.
 */
class AutoCaptureTracker(
  /** Seconds of steadiness needed before firing. */
  val holdDuration: Double = 1.0,
  /** How far (relative to the page's size) the smoothed outline may stray from where the page rests. */
  val tolerance: Double = 0.03,
  /** A raw outline jumping this far (relative) in one frame is a move: the smoothing snaps to it. */
  val jumpTolerance: Double = 0.12,
  /** Hold seconds lost per second of unsteady frames. */
  val decayRate: Double = 2.0,
  /** A frame never counts for more than this (dropped frames, a stall). */
  val maxStep: Double = 0.2,
  /** The outline may vanish this long (a detector miss) before the hold is lost. */
  val missingGrace: Double = 0.25,
  /** Smallest outline (fraction of the frame) worth auto-capturing. */
  val minArea: Double = 0.18,
  /** How long the outline must be gone to re-arm after a capture. */
  val rearmMissing: Double = 0.25,
  /** Minimum time after a capture before a changed page can re-arm. */
  val cooldown: Double = 1.0,
  /** Corner movement (normalised) that counts as a different page / position. */
  val changeDistance: Double = 0.08,
  /** Signature similarity at or above which two views show the same page. */
  val sameContent: Double = PageSignature.SAME_THRESHOLD,
  /** Signature similarity below which two views show different pages. */
  val differentContent: Double = PageSignature.DIFFERENT_THRESHOLD,
  /** Smoothing of the outline (0: frozen, 1: raw). */
  val smoothing: Double = 0.5,
  /** How fast the resting position follows the outline (per frame). */
  val anchorFollow: Double = 0.1,
) {
  class Update(val stability: Double, val fire: Boolean)

  var smoothed: List<Pt>? = null
    private set
  var anchor: List<Pt>? = null
    private set
  var hold = 0.0
    private set
  var armed = true
    private set
  private var lastTime: Double? = null
  private var missingSince: Double? = null
  private var capturedQuad: List<Pt>? = null
  private var capturedSignature: PageSignature? = null
  private var capturedAt = Double.NEGATIVE_INFINITY
  /** The content at the start of the current hold. */
  private var holdSignature: PageSignature? = null

  /**
   * Feed one analysed frame. `signature` is the page content in this frame
   * (null when unknown). Returns progress toward auto-capture (0..1) and
   * whether to fire now. The caller must call `didCapture` when it actually
   * takes the shot (auto or manual).
   */
  fun update(quad: List<Pt>?, now: Double, steady: Boolean, signature: PageSignature? = null): Update {
    val dt = lastTime?.let { min(max(0.0, now - it), maxStep) } ?: 0.0
    lastTime = now

    if (quad == null) {
      val since = missingSince ?: now
      missingSince = since
      // A missed detection or two only pauses the hold.
      if (now - since >= missingGrace) {
        smoothed = null
        anchor = null
        hold = 0.0
      }
      if (!armed && now - since >= rearmMissing) armed = true
      return Update(if (armed) hold / holdDuration else 0.0, false)
    }
    missingSince = null
    val raw = quad

    val scale = max(0.05, sqrt(QuadMath.area(raw)))
    // This frame's outline far from the recent average: the detector is
    // unsure (or the page shook), so the frame doesn't count as steady.
    var frameSteady = steady
    val prev = smoothed
    if (prev != null && PageGeometry.maxCornerDistance(prev, raw) / scale > tolerance * 1.5) frameSteady = false
    if (prev != null && PageGeometry.maxCornerDistance(prev, raw) / scale <= jumpTolerance) {
      smoothed = List(4) { Pt(prev[it].x + (raw[it].x - prev[it].x) * smoothing, prev[it].y + (raw[it].y - prev[it].y) * smoothing) }
    } else {
      smoothed = raw
      anchor = null
      hold = 0.0
    }
    val s = smoothed ?: raw
    // Content is only compared on steady frames (a blurred frame of the same
    // page can look like another page).
    val content = if (frameSteady) signature else null

    if (!armed && now - capturedAt >= cooldown && isNewPage(s, content)) {
      armed = true
      // The new page earns its own full hold.
      anchor = null
      hold = 0.0
    }

    val a = anchor
    if (a != null) {
      if (PageGeometry.maxCornerDistance(s, a) / scale > tolerance) {
        // Moved (or creeping) away from where it has been resting: start over.
        anchor = s
        hold = 0.0
      } else {
        // Where the page rests: a slow average, so noise doesn't push the
        // outline out of tolerance but a page that keeps sliding does.
        anchor = List(4) { Pt(a[it].x + (s[it].x - a[it].x) * anchorFollow, a[it].y + (s[it].y - a[it].y) * anchorFollow) }
        hold = if (frameSteady) min(holdDuration, hold + dt) else max(0.0, hold - dt * decayRate)
      }
    } else {
      anchor = s
    }

    if (armed && isCapturedPage(content)) {
      // The page just captured, back after a hand passed over it, or put
      // down again elsewhere: wait for a different one (from here).
      armed = false
      capturedQuad = s
      hold = 0.0
      anchor = null
    }
    if (content != null) {
      // Different content under a steady outline (a sheet slid in): the new
      // page earns its own full hold.
      val held = holdSignature
      if (held != null && PageSignature.similarity(content, held) < differentContent) hold = 0.0
      if (hold == 0.0) holdSignature = content
    }

    if (!armed || QuadMath.area(s) < minArea) return Update(0.0, false)
    val progress = min(1.0, max(0.0, hold / holdDuration))
    return Update(progress, progress >= 1)
  }

  /** Record a capture of `quad` (null when the page wasn't detected) showing `signature` (null when unknown). */
  fun didCapture(quad: List<Pt>?, now: Double, signature: PageSignature? = null) {
    armed = false
    capturedQuad = quad ?: smoothed
    capturedSignature = signature
    capturedAt = now
    anchor = null
    hold = 0.0
    missingSince = null
    // A manual shot with nothing detected: re-arm on the next outline that
    // appears after the cooldown (there is nothing to compare it with).
    if (capturedQuad == null) capturedQuad = List(4) { Pt(-1.0, -1.0) }
  }

  /**
   * The same tracker starting afresh on a new stream of frames (the camera
   * paused for the review, the app was in the background, an interruption):
   * it forgets the outline and the hold but remembers the last capture, so
   * the page still under the camera isn't shot again while a new sheet is.
   */
  fun restarted(): AutoCaptureTracker {
    val t = AutoCaptureTracker(
      holdDuration, tolerance, jumpTolerance, decayRate, maxStep, missingGrace, minArea, rearmMissing,
      cooldown, changeDistance, sameContent, differentContent, smoothing, anchorFollow,
    )
    t.armed = armed
    t.capturedQuad = capturedQuad
    t.capturedSignature = capturedSignature
    t.capturedAt = capturedAt
    return t
  }

  /** Restarts the hold after the shot settles (the photo arrived or failed), keeping what was captured. */
  fun captureFinished(now: Double) {
    capturedAt = max(capturedAt, now)
    anchor = null
    hold = 0.0
  }

  /** A different page than the last capture: moved, or showing other content. */
  private fun isNewPage(quad: List<Pt>, signature: PageSignature?): Boolean {
    val previous = capturedQuad ?: return true
    if (PageGeometry.maxCornerDistance(quad, previous) > changeDistance) return true
    val b = capturedSignature
    if (signature != null && b != null) return PageSignature.similarity(signature, b) < differentContent
    return false
  }

  /** The same content as the last capture (unknown content: not the same). */
  private fun isCapturedPage(signature: PageSignature?): Boolean {
    val b = capturedSignature ?: return false
    if (signature == null) return false
    return PageSignature.similarity(signature, b) >= sameContent
  }
}

/**
 * A coarse picture of a page's content (port of PageSignature in
 * AutoCaptureTracker.swift): mean luminance of a grid of cells laid out in the
 * PAGE's own (perspective-corrected) space, high-passed and normalised to zero
 * mean and unit variance. Independent of where the page sits in the frame,
 * its size, exposure and contrast; different text, a different layout or a
 * hand over the page change it. Thresholds as calibrated for iOS.
 */
class PageSignature(val values: FloatArray) {
  companion object {
    const val COLUMNS = 24
    const val ROWS = 32
    const val SAME_THRESHOLD = 0.85
    const val DIFFERENT_THRESHOLD = 0.5
    /** Cells skipped at each edge (fraction of the page): the outline may include a sliver of background. */
    const val MARGIN = 0.05
    /** A page this uniform (standard deviation of cell means, 0-255) carries no content to compare. */
    const val MIN_CONTRAST = 2.5f
    /** Each cell is the mean of this many x this many samples (a box filter). */
    const val SAMPLES_PER_SIDE = 6
    /** Neighbourhood (in cells) of the high-pass filter. */
    const val SMOOTH_RADIUS = 3

    /** `luma`: brightness 0-255 at a normalised point of the upright frame (top-left origin). */
    fun make(quad: List<Pt>, luma: LumaSource): PageSignature? {
      if (quad.size != 4) return null
      val map = Homography.unitSquareTo(quad) ?: return null
      val values = FloatArray(COLUMNS * ROWS)
      val span = 1 - 2 * MARGIN
      val cw = span / COLUMNS
      val ch = span / ROWS
      for (r in 0 until ROWS) {
        for (c in 0 until COLUMNS) {
          val u0 = MARGIN + c * cw
          val v0 = MARGIN + r * ch
          var sum = 0f
          for (j in 0 until SAMPLES_PER_SIDE) {
            for (i in 0 until SAMPLES_PER_SIDE) {
              val p = map.apply(u0 + (i + 0.5) / SAMPLES_PER_SIDE * cw, v0 + (j + 0.5) / SAMPLES_PER_SIDE * ch)
              sum += luma.luma(min(1.0, max(0.0, p.x)), min(1.0, max(0.0, p.y)))
            }
          }
          values[r * COLUMNS + c] = sum / (SAMPLES_PER_SIDE * SAMPLES_PER_SIDE)
        }
      }
      // High-pass: each cell minus the mean of its neighbourhood, so lighting
      // gradients and soft shadows don't dominate; text blocks, lines and
      // their ends do.
      if (SMOOTH_RADIUS > 0) {
        val local = FloatArray(values.size)
        for (r in 0 until ROWS) {
          for (c in 0 until COLUMNS) {
            var sum = 0f
            var k = 0f
            for (rr in max(0, r - SMOOTH_RADIUS)..min(ROWS - 1, r + SMOOTH_RADIUS)) {
              for (cc in max(0, c - SMOOTH_RADIUS)..min(COLUMNS - 1, c + SMOOTH_RADIUS)) {
                sum += values[rr * COLUMNS + cc]
                k += 1
              }
            }
            local[r * COLUMNS + c] = sum / k
          }
        }
        for (i in values.indices) values[i] -= local[i]
      }
      val n = values.size.toFloat()
      val mean = values.sum() / n
      var variance = 0f
      for (v in values) variance += (v - mean) * (v - mean)
      variance /= n
      val sd = sqrt(variance)
      if (sd < MIN_CONTRAST) return null
      return PageSignature(FloatArray(values.size) { (values[it] - mean) / sd })
    }

    /** Best normalised cross-correlation of `a` and `b` over shifts of up to one cell: 1 = same picture, ~0 = unrelated. */
    fun similarity(a: PageSignature, b: PageSignature): Double {
      if (a.values.size != COLUMNS * ROWS || b.values.size != COLUMNS * ROWS) return 0.0
      var best = -1.0
      for (dy in -1..1) {
        for (dx in -1..1) {
          var sa = 0.0; var sb = 0.0; var saa = 0.0; var sbb = 0.0; var sab = 0.0; var n = 0.0
          for (r in max(0, -dy) until min(ROWS, ROWS - dy)) {
            for (c in max(0, -dx) until min(COLUMNS, COLUMNS - dx)) {
              val x = a.values[r * COLUMNS + c].toDouble()
              val y = b.values[(r + dy) * COLUMNS + (c + dx)].toDouble()
              sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y; n += 1
            }
          }
          if (n <= 1) continue
          val cov = sab / n - (sa / n) * (sb / n)
          val va = saa / n - (sa / n) * (sa / n)
          val vb = sbb / n - (sb / n) * (sb / n)
          if (va <= 1e-9 || vb <= 1e-9) continue
          best = max(best, cov / sqrt(va * vb))
        }
      }
      return best
    }
  }
}
