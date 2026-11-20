package expo.modules.visionocr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QuadMathTest {
  private val full = listOf(0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0)

  @Test fun parsesAndClampsLikeIos() {
    val q = QuadMath.parse(listOf(-0.005, 0.0, 1.005, 0.0, 1.0, 1.0, 0.0, 1.0))
    assertEquals(0.0, q[0].x, 0.0)
    assertEquals(1.0, q[1].x, 0.0)
  }

  @Test fun rejectsBadQuads() {
    val bad = listOf(
      listOf(0.0, 0.0, 1.0, 0.0, 1.0, 1.0), // 6 numbers
      listOf(0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.2), // out of range
      listOf(0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, Double.NaN),
      listOf(0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0), // counter-clockwise (mirrored)
      listOf(0.0, 0.0, 1.0, 1.0, 1.0, 0.0, 0.0, 1.0), // self-intersecting
      listOf(0.5, 0.5, 0.51, 0.5, 0.51, 0.51, 0.5, 0.51), // area < 0.0005
    )
    for (v in bad) {
      try {
        QuadMath.parse(v)
        throw AssertionError("accepted $v")
      } catch (_: QuadMath.BadQuad) {
      }
    }
  }

  @Test fun cyclicShiftStaysValid() {
    // TR, BR, BL, TL as TL..BL: the page turned 90 degrees, still clockwise.
    val turned = listOf(1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 0.0)
    assertEquals(4, QuadMath.parse(turned).size)
  }

  @Test fun axisAlignedCropIsIntegral() {
    val px = QuadMath.parse(listOf(0.1, 0.2, 0.9, 0.2, 0.9, 0.8, 0.1, 0.8)).map { QuadMath.Pt(it.x * 1000, it.y * 500) }
    val r = QuadMath.axisAlignedCrop(px, 1000, 500)!!
    assertEquals(listOf(100, 100, 900, 400), r.toList())
    val whole = QuadMath.parse(full).map { QuadMath.Pt(it.x * 640, it.y * 480) }
    assertEquals(listOf(0, 0, 640, 480), QuadMath.axisAlignedCrop(whole, 640, 480)!!.toList())
  }

  @Test fun turnedOrPerspectiveQuadIsNotACrop() {
    val turned = QuadMath.parse(listOf(1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 0.0)).map { QuadMath.Pt(it.x * 100, it.y * 100) }
    assertNull(QuadMath.axisAlignedCrop(turned, 100, 100))
    val persp = QuadMath.parse(listOf(0.1, 0.1, 0.9, 0.15, 0.95, 0.9, 0.05, 0.85)).map { QuadMath.Pt(it.x * 100, it.y * 100) }
    assertNull(QuadMath.axisAlignedCrop(persp, 100, 100))
  }

  @Test fun outputSizeUsesLongerOppositeEdges() {
    val q = QuadMath.parse(listOf(0.1, 0.1, 0.9, 0.1, 0.8, 0.9, 0.2, 0.9))
    val (w, h) = QuadMath.outputSize(q, 1000.0, 1000.0)
    assertEquals(800.0, w, 1e-9)
    assertEquals(Math.hypot(100.0, 800.0), h, 1e-9)
  }

  @Test fun cappedNeverUpscales() {
    assertEquals(1000 to 500, QuadMath.capped(1000, 500, 4096))
    assertEquals(4096 to 3072, QuadMath.capped(8000, 6000, 4096))
    assertEquals(1536 to 2048, QuadMath.capped(3000, 4000, 2048))
  }
}

class OcrLayoutTest {
  private fun line(t: String, l: Double, top: Double, w: Double, h: Double, c: Double = 0.9, e: OcrLayout.Engine = OcrLayout.Engine.LATIN) =
    OcrLayout.Line(t, l, top, w, h, c, e)

  @Test fun rowsTopToBottomCellsLeftToRight() {
    val (ordered, text) = OcrLayout.readingOrder(
      listOf(
        line("Total", 10.0, 102.0, 80.0, 20.0),
        line("Invoice", 10.0, 10.0, 100.0, 22.0),
        line("12.50", 300.0, 100.0, 60.0, 20.0),
      ),
    )
    assertEquals(listOf("Invoice", "Total", "12.50"), ordered.map { it.text })
    assertEquals("Invoice\nTotal  12.50", text)
  }

  @Test fun arabicRowReadsRightToLeft() {
    val (_, text) = OcrLayout.readingOrder(
      listOf(
        line("المبلغ", 600.0, 50.0, 120.0, 30.0),
        line("٤٥٠ دينار", 100.0, 52.0, 150.0, 30.0),
      ),
    )
    assertEquals("المبلغ  ٤٥٠ دينار", text)
  }

  @Test fun arabicDetection() {
    assertEquals(1.0, OcrLayout.arabicShare("شركة النور"), 1e-9)
    assertEquals(0.0, OcrLayout.arabicShare("Invoice 2026"), 1e-9)
    assertTrue(OcrLayout.isRtl("فاتورة ضريبية 2026"))
    assertFalse(OcrLayout.isRtl("Invoice فاتورة No. 2026"))
  }

  @Test fun suspectsArabicOnJunkOrUnreadInk() {
    val junk = listOf(line("JI ..", 0.0, 0.0, 300.0, 40.0, 0.3), line("ill", 0.0, 60.0, 300.0, 40.0, 0.4))
    assertTrue(OcrLayout.suspectsArabic(junk, null, false))
    val clean = listOf(line("Dear customer, our records show", 0.0, 0.0, 600.0, 30.0, 0.95), line("Total due: 1,284.50 EUR", 0.0, 50.0, 400.0, 30.0, 0.93))
    val total = 480 * 340
    // All the ink was read: Latin only.
    assertFalse(OcrLayout.suspectsArabic(clean, OcrLayout.Ink(4000, 50, total), false))
    // Lines ML Kit skipped (Arabic between English lines).
    assertTrue(OcrLayout.suspectsArabic(clean, OcrLayout.Ink(4000, 2500, total), false))
    // Nothing read, ink on the page: an all-Arabic page. A blank page: no.
    assertTrue(OcrLayout.suspectsArabic(emptyList(), OcrLayout.Ink(0, 3000, total), false))
    assertFalse(OcrLayout.suspectsArabic(emptyList(), OcrLayout.Ink(0, 10, total), false))
    // An Arabic device language lowers the bar.
    assertFalse(OcrLayout.suspectsArabic(clean, OcrLayout.Ink(4000, 600, total), false))
    assertTrue(OcrLayout.suspectsArabic(clean, OcrLayout.Ink(4000, 600, total), true))
  }

  @Test fun inkCountsGlyphSizedStrokesOutsideTheBoxes() {
    val w = 200
    val h = 120
    val gray = IntArray(w * h) { 235 }
    fun glyph(x0: Int, y0: Int) { for (y in y0 until y0 + 4) for (x in x0 until x0 + 4) gray[y * w + x] = 20 }
    for (i in 0 until 5) glyph(20 + i * 8, 20) // read by ML Kit
    for (i in 0 until 3) glyph(20 + i * 8, 80) // not read
    for (x in 10 until 190) gray[110 * w + x] = 20 // a table rule: not text
    val ink = OcrLayout.ink(gray, w, h, listOf(line("x", 18.0, 18.0, 42.0, 8.0)))
    assertEquals(80, ink.covered)
    assertEquals(48, ink.uncovered)
    // A dark desk around the page isn't paper: its texture doesn't count.
    val desk = IntArray(w * h) { if ((it / w + it % w) % 7 == 0) 30 else 80 }
    assertEquals(0, OcrLayout.ink(desk, w, h, emptyList()).uncovered)
  }

  @Test fun mergeKeepsArabicAndCleanLatin() {
    val latin = listOf(
      line("Invoice No. 2026-117", 100.0, 300.0, 400.0, 40.0, 0.95),
      line("ojl", 900.0, 200.0, 300.0, 50.0, 0.3), // the Latin model misreading the Arabic line
    )
    val tess = listOf(
      line("شركة النور للتجارة", 880.0, 195.0, 330.0, 60.0, 0.85, OcrLayout.Engine.ARABIC),
      line("Invoico No 2026", 100.0, 300.0, 400.0, 40.0, 0.4, OcrLayout.Engine.ARABIC), // Latin read by `ara`: ignored
    )
    val merged = OcrLayout.merge(latin, tess)
    assertEquals(setOf("Invoice No. 2026-117", "شركة النور للتجارة"), merged.map { it.text }.toSet())
    val (_, text) = OcrLayout.readingOrder(merged)
    assertEquals("شركة النور للتجارة\nInvoice No. 2026-117", text)
  }

  @Test fun latinPrintReadAsArabicIsDropped() {
    val latin = listOf(line("Invoice No. 2026-117", 100.0, 300.0, 400.0, 40.0, 0.95))
    val tess = listOf(line("2026-7 .هلظ ععام/اما", 100.0, 298.0, 420.0, 44.0, 0.93, OcrLayout.Engine.ARABIC))
    assertEquals(latin, OcrLayout.merge(latin, tess))
  }

  @Test fun mergeWithoutArabicKeepsLatin() {
    val latin = listOf(line("Hello", 0.0, 0.0, 100.0, 20.0, 0.5))
    assertEquals(latin, OcrLayout.merge(latin, emptyList()))
    assertNotNull(OcrLayout.merge(latin, listOf(line("Hello", 0.0, 0.0, 100.0, 20.0, 0.9, OcrLayout.Engine.ARABIC))))
  }
}
