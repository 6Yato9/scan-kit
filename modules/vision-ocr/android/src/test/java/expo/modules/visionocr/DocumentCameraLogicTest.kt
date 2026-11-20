package expo.modules.visionocr

import expo.modules.visionocr.QuadMath.Pt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.util.Locale
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin

/*
 * Phase 2 (docs/android-port-plan.md): the pure parts of the document camera
 * — auto-capture tracker, page signature, page geometry, the page detector
 * and the camera-frame rotation — checked on the JVM.
 */

class AutoCaptureParityTest {
  private fun sig(f: (Int) -> Double) = PageSignature(FloatArray(PageSignature.COLUMNS * PageSignature.ROWS) { f(it).toFloat() })
  private fun quad(dx: Double, dy: Double, j: Double) = listOf(
    Pt(0.1 + dx + j, 0.1 + dy), Pt(0.9 + dx, 0.12 + dy - j), Pt(0.88 + dx - j, 0.9 + dy), Pt(0.12 + dx, 0.88 + dy + j),
  )

  /**
   * The same 260-frame script run through AutoCaptureTracker.swift (a macOS
   * harness compiled from the iOS sources) gave EXPECTED: a page held and
   * captured, kept (no second shot), removed and put back (not shot twice),
   * new content in the same spot (shot), moved with the captured content (not
   * shot), unsteady frames, a restart.
   */
  @Test fun matchesTheSwiftTrackerFrameForFrame() {
    val sigA = sig { sin(it * 0.37) }
    val sigB = sig { cos(it * 0.91 + 1) }
    var t = AutoCaptureTracker()
    val out = ArrayList<String>()
    for (i in 0 until 260) {
      val now = i / 15.0
      val j = 0.002 * sin(i * 1.3)
      var q: List<Pt>? = quad(0.0, 0.0, j)
      var steady = true
      var s: PageSignature? = sigA
      if (i in 60 until 70) { q = null; s = null }
      if (i in 100 until 140) s = sigB
      if (i in 140 until 200) { q = quad(0.1, 0.02, j); s = sigB; steady = i % 3 != 0 }
      if (i in 200 until 210) { q = null; s = null }
      if (i >= 210) { q = quad(0.1, 0.02, j * 8); s = null; steady = i % 4 != 0 }
      if (i == 230) t = t.restarted()
      val r = t.update(q, now, steady, s)
      if (r.fire) {
        t.didCapture(q, now, s)
        t.captureFinished(now + 0.25)
      }
      out += String.format(Locale.ROOT, "%d:%.3f%s", i, r.stability, if (r.fire) "F" else "")
    }
    assertEquals(ParityFixture.SWIFT, out.joinToString(" "))
  }

  @Test fun manualShotWithoutOutlineRearmsOnTheNextPage() {
    val t = AutoCaptureTracker()
    t.didCapture(null, 0.0, null)
    var fired = false
    for (i in 1..60) {
      if (t.update(quad(0.0, 0.0, 0.0), i / 15.0, true, null).fire) {
        fired = true
        break
      }
    }
    assertTrue(fired)
  }

  @Test fun smallOutlinesNeverFire() {
    val t = AutoCaptureTracker()
    val small = listOf(Pt(0.4, 0.4), Pt(0.6, 0.4), Pt(0.6, 0.6), Pt(0.4, 0.6))
    for (i in 0..60) assertFalse(t.update(small, i / 15.0, true, null).fire)
  }

  @Test fun restartKeepsTheLastCaptureAFreshTrackerForgetsIt() {
    val t = AutoCaptureTracker()
    t.didCapture(quad(0.0, 0.0, 0.0), 0.0, sig { sin(it * 0.37) })
    assertFalse(t.restarted().armed)
    assertTrue(AutoCaptureTracker().armed)
  }
}

class PageSignatureTest {
  /** A synthetic page: dark text bars on paper inside `q`, background around it. */
  private fun page(q: List<Pt>, seed: Int, w: Int = 300, h: Int = 400): GrayImage {
    val px = ByteArray(w * h) { 70 }
    val map = Homography.unitSquareTo(q)!!
    val rnd = java.util.Random(seed.toLong())
    val bars = (0 until 14).map { doubleArrayOf(0.15 + it * 0.05, 0.1, 0.1 + rnd.nextDouble() * 0.8) }
    for (yy in 0 until 800) for (xx in 0 until 600) {
      val u = (xx + 0.5) / 600
      val v = (yy + 0.5) / 800
      val dark = bars.any { v >= it[0] && v < it[0] + 0.02 && u >= it[1] && u < it[2] }
      val p = map.apply(u, v)
      val x = (p.x * w).toInt()
      val y = (p.y * h).toInt()
      if (x in 0 until w && y in 0 until h) px[y * w + x] = (if (dark) 40 else 245).toByte()
    }
    return GrayImage(w, h, px)
  }

  @Test fun samePageIsSameDifferentPageIsNot() {
    val q = listOf(Pt(0.1, 0.1), Pt(0.9, 0.12), Pt(0.88, 0.9), Pt(0.12, 0.88))
    val image = page(q, 1)
    val a = PageSignature.make(q, image)!!
    val a2 = PageSignature.make(q.map { Pt(it.x + 0.002, it.y - 0.002) }, image)!!
    val b = PageSignature.make(q, page(q, 7))!!
    assertTrue(PageSignature.similarity(a, a2) >= PageSignature.SAME_THRESHOLD)
    assertTrue(PageSignature.similarity(a, b) < PageSignature.SAME_THRESHOLD)
  }

  @Test fun blankPageHasNoSignature() {
    val q = listOf(Pt(0.1, 0.1), Pt(0.9, 0.1), Pt(0.9, 0.9), Pt(0.1, 0.9))
    assertNull(PageSignature.make(q, GrayImage(100, 100, ByteArray(100 * 100) { 200.toByte() })))
  }
}

class PageGeometryTest {
  private val upright = listOf(Pt(0.1, 0.1), Pt(0.9, 0.1), Pt(0.9, 0.9), Pt(0.1, 0.9))

  @Test fun homographyMapsTheCorners() {
    val q = listOf(Pt(0.2, 0.1), Pt(0.8, 0.15), Pt(0.9, 0.9), Pt(0.1, 0.85))
    val m = Homography.unitSquareTo(q)!!
    listOf(0.0 to 0.0, 1.0 to 0.0, 1.0 to 1.0, 0.0 to 1.0).forEachIndexed { i, (u, v) ->
      val p = m.apply(u, v)
      assertEquals(q[i].x, p.x, 1e-9)
      assertEquals(q[i].y, p.y, 1e-9)
    }
  }

  @Test fun insetPullsCornersInByHalfAPercentOfThePage() {
    val r = PageGeometry.inset(upright)
    assertEquals(0.104, r[0].x, 1e-9)
    assertEquals(0.104, r[0].y, 1e-9)
    assertEquals(0.896, r[2].x, 1e-9)
    assertTrue(QuadMath.isConvexClockwise(r))
  }

  @Test fun plausibleLikeIos() {
    assertTrue(PageGeometry.plausible(upright, 0.15))
    assertFalse(PageGeometry.plausible(upright, 0.7)) // smaller than minArea
    // A band along the bottom edge: three corners on the border.
    assertFalse(PageGeometry.plausible(listOf(Pt(0.0, 0.7), Pt(1.0, 0.7), Pt(1.0, 1.0), Pt(0.0, 1.0)), 0.15))
    // A page nearly filling the frame may touch it.
    assertTrue(PageGeometry.plausible(listOf(Pt(0.0, 0.0), Pt(1.0, 0.0), Pt(1.0, 0.9), Pt(0.0, 0.9)), 0.15))
    // The whole frame is not a page.
    assertFalse(PageGeometry.plausible(listOf(Pt(0.0, 0.0), Pt(1.0, 0.0), Pt(1.0, 1.0), Pt(0.0, 1.0)), 0.15))
  }

  @Test fun orderUprightStartsTopLeftClockwise() {
    val ccw = listOf(Pt(0.9, 0.9), Pt(0.9, 0.1), Pt(0.1, 0.1), Pt(0.1, 0.9))
    assertEquals(upright, PageGeometry.orderUpright(ccw))
    // A page turned 30 degrees keeps its own top edge first.
    val a = Math.toRadians(30.0)
    fun rot(p: Pt) = Pt(0.5 + (p.x - 0.5) * cos(a) - (p.y - 0.5) * sin(a), 0.5 + (p.x - 0.5) * sin(a) + (p.y - 0.5) * cos(a))
    val turned = upright.map(::rot)
    val o = PageGeometry.orderUpright(listOf(turned[2], turned[3], turned[0], turned[1]))
    assertEquals(turned, o)
  }

  @Test fun aspectFillMappingMatchesCameraLayout() {
    // A 3:4 frame in a 1080 x 2400 view: scaled to cover (1800 x 2400), centred.
    val pts = OutlineOverlay.layerPoints(listOf(Pt(0.0, 0.0), Pt(1.0, 1.0), Pt(0.5, 0.5), Pt(0.0, 1.0)), 3.0, 4.0, 1080.0, 2400.0)
    assertEquals(-360.0, pts[0].x, 1e-9)
    assertEquals(0.0, pts[0].y, 1e-9)
    assertEquals(1440.0, pts[1].x, 1e-9)
    assertEquals(2400.0, pts[1].y, 1e-9)
    assertEquals(540.0, pts[2].x, 1e-9)
  }
}

class CameraFrameTest {
  /** A 4 x 2 sensor image whose pixel value is its index. */
  private fun plane(rotation: Int) = YPlane(ByteBuffer.wrap(ByteArray(8) { it.toByte() }), 4, 1, 4, 2, rotation)

  @Test fun uprightGrayTurnsTheSensorImage() {
    // 90: upright 2 wide, 4 tall; its top-left is the sensor's bottom-left.
    val g = plane(90).uprightGray(100)
    assertEquals(2, g.width)
    assertEquals(4, g.height)
    assertEquals(4, g.at(0, 0))
    assertEquals(0, g.at(1, 0))
    assertEquals(7, g.at(0, 3))
    assertEquals(7, plane(180).uprightGray(100).at(0, 0))
    assertEquals(3, plane(270).uprightGray(100).at(0, 0))
    assertEquals(0, plane(0).uprightGray(100).at(0, 0))
  }

  @Test fun lumaAndToSensorAgreeWithTheUprightImage() {
    for (r in listOf(0, 90, 180, 270)) {
      val y = plane(r)
      val g = y.uprightGray(100)
      for (yy in 0 until g.height) for (xx in 0 until g.width) {
        val u = (xx + 0.5) / g.width
        val v = (yy + 0.5) / g.height
        assertEquals("rotation $r", g.at(xx, yy).toFloat(), y.luma(u, v))
        val s = y.toSensor(u, v)
        assertEquals("rotation $r", g.at(xx, yy), (s.y * 2).toInt() * 4 + (s.x * 4).toInt())
      }
    }
  }

  @Test fun splitMixIsDeterministic() {
    val a = SplitMix(0x5CA7)
    val b = SplitMix(0x5CA7)
    repeat(10) { assertEquals(a.next(), b.next(), 0.0) }
    assertTrue(SplitMix(1).next() in 0.0..1.0)
  }
}

class PageDetectorTest {
  /** Paper with text bars at `q` on a background, 4 x 4 supersampled. */
  private fun scene(q: List<Pt>, w: Int = 480, h: Int = 640, paper: Int = 245, background: Int = 80, occlude: Pt? = null): GrayImage {
    fun inside(x: Double, y: Double): Boolean {
      for (i in 0 until 4) {
        val a = q[i]
        val b = q[(i + 1) % 4]
        if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0) return false
      }
      return true
    }
    val top = (q[0].y + q[1].y) / 2
    val bottom = (q[2].y + q[3].y) / 2
    val left = (q[0].x + q[3].x) / 2
    val right = (q[1].x + q[2].x) / 2
    val px = ByteArray(w * h)
    for (yy in 0 until h) for (xx in 0 until w) {
      var sum = 0
      for (j in 0 until 4) for (i in 0 until 4) {
        val x = (xx + (i + 0.5) / 4) / w
        val y = (yy + (j + 0.5) / 4) / h
        val v = (y - top) / (bottom - top)
        sum += when {
          occlude != null && hypot((x - occlude.x) * w, (y - occlude.y) * h) < 40 -> 170
          inside(x, y) -> if (v > 0.2 && v < 0.8 && (v * 40).toInt() % 3 == 0 && x > left + 0.1 && x < right - 0.1) 40 else paper
          else -> background
        }
      }
      px[yy * w + xx] = (sum / 16).toByte()
    }
    return GrayImage(w, h, px)
  }

  private fun err(a: List<Pt>, b: List<Pt>) = (0 until 4).maxOf { hypot(a[it].x - b[it].x, a[it].y - b[it].y) }

  @Test fun findsAPageInPerspective() {
    val q = listOf(Pt(0.22, 0.12), Pt(0.80, 0.15), Pt(0.88, 0.86), Pt(0.12, 0.82))
    val found = PageDetector.detect(scene(q), 0.15)
    assertNotNull(found)
    assertTrue("error ${err(found!!, q)}", err(found, q) < 0.006)
  }

  @Test fun findsALowContrastPage() {
    val q = listOf(Pt(0.15, 0.1), Pt(0.85, 0.1), Pt(0.85, 0.9), Pt(0.15, 0.9))
    val found = PageDetector.detect(scene(q, paper = 240, background = 212), 0.15)
    assertNotNull(found)
    assertTrue("error ${err(found!!, q)}", err(found, q) < 0.008)
  }

  @Test fun restoresACornerUnderAThumb() {
    val q = listOf(Pt(0.15, 0.1), Pt(0.85, 0.1), Pt(0.85, 0.9), Pt(0.15, 0.9))
    val found = PageDetector.detect(scene(q, occlude = Pt(0.85, 0.9)), 0.15)
    assertNotNull(found)
    assertTrue("error ${err(found!!, q)}", err(found, q) < 0.01)
  }

  @Test fun nothingOnAnEmptyTableOrForASmallCard() {
    assertNull(PageDetector.detect(GrayImage(240, 320, ByteArray(240 * 320) { 90 }), 0.15))
    val small = listOf(Pt(0.4, 0.4), Pt(0.6, 0.4), Pt(0.6, 0.6), Pt(0.4, 0.6))
    assertNull(PageDetector.detect(scene(small), 0.15))
  }

  @Test fun noSliversLikePlanksOrDoorFrames() {
    val plank = listOf(Pt(0.45, 0.05), Pt(0.55, 0.05), Pt(0.55, 0.95), Pt(0.45, 0.95))
    assertNull(PageDetector.detect(scene(plank), 0.05))
  }

  @Test fun aTurnedPageKeepsItsTopLeftFirst() {
    val q = listOf(Pt(0.35, 0.08), Pt(0.95, 0.38), Pt(0.62, 0.95), Pt(0.05, 0.62))
    val found = PageDetector.detect(scene(q), 0.15)
    assertNotNull(found)
    assertTrue("error ${err(found!!, q)}", err(found, q) < 0.01)
    assertTrue(abs(found[0].x - 0.35) < 0.02)
  }
}
