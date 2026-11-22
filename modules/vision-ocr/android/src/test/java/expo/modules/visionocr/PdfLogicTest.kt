package expo.modules.visionocr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Phase 3 (PDF reading): the pure parts of PdfEngine, PdfPermissionBits and the viewer's layout. */
class PdfPermissionBitsTest {
  // /P bits are 1-based in ISO 32000 (bit 3 = print, 4 = modify, 5 = copy,
  // 6 = annotate, 9 = fill forms, 10 = accessibility, 11 = assemble,
  // 12 = high-quality print); the high bits of /P are always set.
  private fun p(vararg bits: Int): Int {
    var v = 0xFFFFF000.toInt() or 0b11000000 // reserved bits 7, 8 and 13–32 set
    for (b in bits) v = v or (1 shl (b - 1))
    return v
  }

  @Test fun everythingAllowedIsAllBits() {
    assertEquals(PdfPermissionBits.ALL, PdfPermissionBits.fromP(-4, 4))
    assertEquals(PdfPermissionBits.ALL, PdfPermissionBits.fromP(p(3, 4, 5, 6, 9, 10, 11, 12), 6))
  }

  @Test fun nothingAllowed() {
    assertEquals(0, PdfPermissionBits.fromP(p(), 4))
  }

  @Test fun revision3SplitsFormsAssemblyAndHighQualityPrint() {
    // Print (low only), fill forms, assemble: a typical "fill in and print" form.
    val bits = PdfPermissionBits.fromP(p(3, 9, 11), 4)
    assertEquals(PdfPermissionBits.PRINT_LOW or PdfPermissionBits.FILL_FORMS or PdfPermissionBits.ASSEMBLE, bits)
    // Revision 2 has no separate high-quality bit: print means both.
    assertEquals(PdfPermissionBits.PRINT_LOW or PdfPermissionBits.PRINT_HIGH, PdfPermissionBits.fromP(p(3), 2))
    // Revision 2 ignores bits 9-12.
    assertEquals(0, PdfPermissionBits.fromP(p(9, 10, 11, 12), 2))
  }

  @Test fun coarseBitsImplyTheirFinerOnes() {
    // modify ⇒ assemble; copy ⇒ accessibility; annotate ⇒ fill forms (PDFKit's superset rule).
    assertEquals(PdfPermissionBits.CHANGE_CONTENT or PdfPermissionBits.ASSEMBLE, PdfPermissionBits.fromP(p(4), 3))
    assertEquals(PdfPermissionBits.COPY or PdfPermissionBits.ACCESSIBILITY, PdfPermissionBits.fromP(p(5), 3))
    assertEquals(PdfPermissionBits.COMMENT or PdfPermissionBits.FILL_FORMS, PdfPermissionBits.fromP(p(6), 3))
  }

  @Test fun mapsToTheJsNames() {
    val m = PdfPermissionBits.toMap(PdfPermissionBits.COPY or PdfPermissionBits.FILL_FORMS)
    assertEquals(8, m.size)
    assertTrue(m["copy"]!!)
    assertTrue(m["fillForms"]!!)
    assertFalse(m["printLow"]!!)
    assertFalse(m["assemblePages"]!!)
  }
}

class PdfPageLayoutTest {
  // Two A4 portrait pages and one landscape page, in points.
  private val sizes = floatArrayOf(595f, 842f, 595f, 842f, 842f, 595f)
  private fun layout(w: Float = 1080f, h: Float = 2000f) = PdfPageLayout(sizes, w, h, 48f)

  @Test fun fitsTheWidestPageToTheWidth() {
    val l = layout()
    assertEquals((1080f - 96f) / 842f, l.baseScale, 1e-4f)
    val landscape = l.pages[2]
    assertEquals(48f, landscape.left, 1e-3f)
    assertEquals(1080f - 48f, landscape.right, 1e-3f)
    // Narrower pages are centred.
    val p0 = l.pages[0]
    assertEquals(1080f - p0.right, p0.left, 1e-3f)
    // Margins above, between and below.
    assertEquals(48f, p0.top, 1e-3f)
    assertEquals(p0.bottom + 48f, l.pages[1].top, 1e-3f)
    assertEquals(l.pages[2].bottom + 48f, l.contentHeight, 1e-3f)
  }

  @Test fun pageAtCentreAndVisibleRange() {
    val l = layout(h = 800f)
    assertEquals(0, l.pageAtCenter(0f, 1f))
    val y = l.scrollYForPage(1, 1f)
    assertEquals((l.pages[1].top - 48f), y, 1e-3f)
    assertEquals(1, l.pageAtCenter(y, 1f))
    assertEquals(0..0, l.visibleRange(0f, 1f).let { it.first..it.first })
    val range = l.visibleRange(l.maxScrollY(1f), 1f)
    assertEquals(2, range.last)
  }

  @Test fun shortDocumentsAreCentredVertically() {
    val one = PdfPageLayout(floatArrayOf(595f, 842f), 1080f, 2400f, 48f)
    assertTrue(one.padTop(1f) > 0f)
    assertEquals(0f, one.maxScrollY(1f), 0f)
    val box = one.pageInView(0, 0f, 0f, 1f)
    assertEquals(2400f - box.bottom, box.top, 1f)
  }

  @Test fun zoomKeepsThePointUnderTheFingers() {
    val l = layout(h = 800f)
    val (x, y) = l.zoomAround(0f, 300f, 1f, 2f, 540f, 400f)
    // The content point under (540, 400) at zoom 1 …
    val cx = (0f + 540f) / 1f
    val cy = (300f + 400f) / 1f
    // … is still under it at zoom 2.
    assertEquals(cx * 2f - 540f, x, 1e-3f)
    assertEquals(cy * 2f - 400f, y, 1e-3f)
  }

  @Test fun zoomIsClampedAndScrollStaysInside() {
    val l = layout(h = 800f)
    assertEquals(0f, l.clampX(-50f, 2f), 0f)
    assertEquals(1080f, l.clampX(5000f, 2f), 0f)
    assertEquals(PdfPageLayout.MAX_ZOOM, PdfPageLayout.clampZoom(40f), 0f)
    assertEquals(PdfPageLayout.MIN_ZOOM, PdfPageLayout.clampZoom(0.2f), 0f)
  }

  @Test fun aUsersZoomSurvivesARelayoutAndAFittedPageStaysFitted() {
    assertEquals(1f, PdfPageLayout.zoomAfterResize(1f, 1.2f, 2.0f), 0f)
    // Same pixels per point after the width changed.
    assertEquals(3f, PdfPageLayout.zoomAfterResize(2f, 1.5f, 1.0f), 1e-4f)
    // Never below fit.
    assertEquals(1f, PdfPageLayout.zoomAfterResize(1.5f, 1.0f, 2.0f), 0f)
  }

  @Test fun anchorRestoresTheSamePlaceAfterAHeightChange() {
    val a = layout(h = 800f)
    val zoom = 2f
    val before = a.anchorOf(300f, 1500f, zoom)
    val b = layout(h = 700f) // a banner went away: same width, new height
    val (x, y) = b.scrollFor(before, zoom)
    assertEquals(300f, x, 0.5f)
    assertEquals(1500f, y, 0.5f)
  }

  @Test fun renderSizeCapsPixelsProportionally() {
    assertEquals(1000 to 1400, PdfPageLayout.renderSize(1000f, 1400f, 3_000_000))
    val (w, h) = PdfPageLayout.renderSize(1000f, 10_000f, 3_000_000)
    assertTrue(w.toLong() * h <= 3_000_000)
    assertEquals(10f, h.toFloat() / w, 0.05f)
  }
}

class PdfEngineTest {
  @Test fun rasterSizeIs200DpiCappedAtMaxEdge() {
    // A4 at 200 dpi.
    assertEquals(1653 to 2339, PdfEngine.rasterSize(595f, 842f, 4000.0))
    // Thumbnails: long edge 360.
    val (w, h) = PdfEngine.rasterSize(595f, 842f, 360.0)
    assertEquals(360, h)
    assertEquals(254, w)
    // Landscape.
    assertEquals(360, PdfEngine.rasterSize(842f, 595f, 360.0).first)
  }

  @Test fun cleansPdfiumText() {
    assertEquals("one\ntwo\nthree", PdfEngine.cleanText("one\r\ntwo\rthree\r\n"))
    assertEquals("hyphen-\nated", PdfEngine.cleanText("hyphen\u0002\r\nated"))
    assertEquals("a\tb", PdfEngine.cleanText("a\u0000\tb￾"))
  }

  @Test fun parsesBackgroundHex() {
    assertEquals(0xFF111111.toInt(), PdfDocumentView.parseHex("#111111"))
    assertEquals(0xFFFFFFFF.toInt(), PdfDocumentView.parseHex("ffffff"))
    assertNull(PdfDocumentView.parseHex("#fff"))
    assertNull(PdfDocumentView.parseHex("nope!!"))
    assertNull(PdfDocumentView.parseHex(null))
  }
}
