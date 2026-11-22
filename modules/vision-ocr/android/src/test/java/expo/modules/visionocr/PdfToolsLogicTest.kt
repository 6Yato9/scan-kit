package expo.modules.visionocr

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Phase 4 (PDF tools): permissions written back, page plans, appearances, text layout, Arabic joining. */
class PdfPermissionWriteTest {
  private fun p(vararg bits: Int): Int {
    var v = 0xFFFFF000.toInt() or 0b11000000
    for (b in bits) v = v or (1 shl (b - 1))
    return v
  }

  @Test fun toPRoundTripsEveryBitSetFromPCanProduce() {
    // Every /P a revision 3+ file can have: PDFKit bits → /P → PDFKit bits is the identity.
    for (mask in 0 until 256) {
      val iso = intArrayOf(3, 4, 5, 6, 9, 10, 11, 12)
      val raw = iso.withIndex().filter { (i, _) -> mask and (1 shl i) != 0 }.map { it.value }.toIntArray()
      val bits = PdfPermissionBits.fromP(p(*raw), 6)
      assertEquals(bits, PdfPermissionBits.fromP(PdfPermissionBits.toP(bits), 6))
    }
  }

  @Test fun toPSpellsEachPermissionOnItsOwnBit() {
    val all = PdfPermissionBits.toP(PdfPermissionBits.ALL)
    assertEquals(PdfPermissionBits.P_MEANINGFUL, all)
    // Full-quality printing only with printing.
    assertEquals(0, PdfPermissionBits.toP(PdfPermissionBits.PRINT_HIGH))
    assertEquals(1 shl 2, PdfPermissionBits.toP(PdfPermissionBits.PRINT_LOW))
  }

  @Test fun effectivePKeepsRevision3BitsExactlyAndSpellsOutRevision2() {
    // qpdf --modify=assembly (R3, P = -300): exactly bits 3, 5, 10, 11, 12.
    assertEquals((1 shl 2) or (1 shl 4) or (1 shl 9) or (1 shl 10) or (1 shl 11), PdfPermissionBits.effectiveP(-300, 3))
    // A revision 2 file's reserved bits 9-12 don't count; its annotate bit allows forms too.
    val r2 = PdfPermissionBits.effectiveP(p(3, 6, 9, 10, 11, 12), 2)
    assertEquals(PdfPermissionBits.toP(PdfPermissionBits.PRINT_LOW or PdfPermissionBits.PRINT_HIGH or PdfPermissionBits.COMMENT or PdfPermissionBits.FILL_FORMS), r2)
  }

  @Test fun widenedCatchesAnyPermissionTurnedOn() {
    assertNull(PdfPermissionBits.widened(-2056, 6, -2056, 6))
    assertNull(PdfPermissionBits.widened(-300, 3, -300, 6)) // RC4 → AES-256, same bits
    assertNotNull(PdfPermissionBits.widened(p(3), 6, p(3, 5), 6)) // copying turned on
    assertNotNull(PdfPermissionBits.widened(p(5), 6, p(5, 10), 6)) // raw accessibility bit turned on
    assertNull(PdfPermissionBits.widened(p(3, 5, 10), 6, p(3), 6)) // narrower is fine
  }
}

class PdfPlanTest {
  @Test fun planChecksAsIos() {
    assertNull(PdfPlan.check(listOf(2, 0, -2), listOf(0, 90, -90), 3))
    assertEquals("The PDF has no pages", PdfPlan.check(listOf(0), listOf(0), 0))
    assertEquals("Bad page plan", PdfPlan.check(emptyList(), emptyList(), 3))
    assertEquals("Bad page plan", PdfPlan.check(listOf(0, 0), listOf(0, 0), 3)) // a page twice
    assertEquals("Bad page plan", PdfPlan.check(listOf(3), listOf(0), 3))
    assertEquals("Bad page plan", PdfPlan.check(listOf(-4), listOf(0), 3))
    assertEquals("Bad page plan", PdfPlan.check(listOf(0), listOf(0, 0), 3))
    assertEquals("Bad rotation", PdfPlan.check(listOf(0), listOf(45), 3))
    // A page may be blank-copied and kept.
    assertNull(PdfPlan.check(listOf(0, -1, -1), listOf(0, 0, 0), 1))
  }

  @Test fun normalized() {
    assertEquals(270, PdfPlan.normalized(-90))
    assertEquals(0, PdfPlan.normalized(720))
  }

  @Test fun appearanceTransformFitsTheBoxToTheRect() {
    // Identity matrix: scale and translate the BBox onto the Rect.
    val t = PdfPlan.appearanceTransform(floatArrayOf(0f, 0f, 100f, 20f), floatArrayOf(1f, 0f, 0f, 1f, 0f, 0f), floatArrayOf(50f, 700f, 250f, 740f))!!
    assertArrayEquals(floatArrayOf(2f, 0f, 0f, 2f, 50f, 700f), t, 1e-4f)
    // A 90° matrix: the turned box (-20..0 × 0..100) is fitted.
    val r = PdfPlan.appearanceTransform(floatArrayOf(0f, 0f, 100f, 20f), floatArrayOf(0f, 1f, -1f, 0f, 0f, 0f), floatArrayOf(10f, 10f, 30f, 110f))!!
    assertArrayEquals(floatArrayOf(1f, 0f, 0f, 1f, 30f, 10f), r, 1e-4f)
    // Reversed Rect corners are normalised; an empty box is refused.
    assertNotNull(PdfPlan.appearanceTransform(floatArrayOf(0f, 0f, 10f, 10f), floatArrayOf(1f, 0f, 0f, 1f, 0f, 0f), floatArrayOf(20f, 20f, 10f, 10f)))
    assertNull(PdfPlan.appearanceTransform(floatArrayOf(0f, 0f, 0f, 10f), floatArrayOf(1f, 0f, 0f, 1f, 0f, 0f), floatArrayOf(0f, 0f, 10f, 10f)))
  }

  @Test fun defaultAppearanceStrings() {
    assertEquals(12f, PdfPlan.daFontSize("/Helv 12 Tf 0 g"), 0f)
    assertEquals(0f, PdfPlan.daFontSize("/Helv 0 Tf 0 g"), 0f)
    assertEquals(0f, PdfPlan.daFontSize(null), 0f)
    assertEquals(9.5f, PdfPlan.daFontSize("0 0 1 rg /F1 9.5 Tf"), 0f)
    assertEquals("Helv", PdfPlan.daFontName("/Helv 12 Tf 0 g"))
    assertArrayEquals(floatArrayOf(0f, 0f, 1f), PdfPlan.daColor("/Helv 12 Tf 0 0 1 rg"), 0f)
    assertArrayEquals(floatArrayOf(0.5f, 0.5f, 0.5f), PdfPlan.daColor("0.5 g /Helv 12 Tf"), 0f)
    assertArrayEquals(floatArrayOf(0f, 1f, 1f), PdfPlan.daColor("1 0 0 0 k"), 1e-6f)
    assertArrayEquals(floatArrayOf(0f, 0f, 0f), PdfPlan.daColor("/Helv 12 Tf"), 0f)
  }

  @Test fun hexColors() {
    assertArrayEquals(floatArrayOf(1f, 0f, 0f), PdfPlan.hexColor("#ff0000"), 1e-6f)
    assertArrayEquals(floatArrayOf(0.07f, 0.07f, 0.07f), PdfPlan.hexColor("nope"), 1e-6f)
  }

  @Test fun wrapBreaksAtSpacesAndInsideLongWords() {
    val width = { s: String -> s.length.toFloat() }
    assertEquals(listOf("one two", "three"), PdfPlan.wrap("one two three", 8f, width))
    assertEquals(listOf("abcd", "efgh", "ij"), PdfPlan.wrap("abcdefghij", 4f, width))
    assertEquals(listOf(""), PdfPlan.wrap("", 4f, width))
    assertEquals(listOf("a", "bcde", "f"), PdfPlan.wrap("a bcdef", 4f, width))
  }

  @Test fun scriptRuns() {
    val runs = PdfPlan.runs("Hi مرحبا 12 שלום!")
    assertEquals(listOf(PdfPlan.Script.LATIN, PdfPlan.Script.ARABIC, PdfPlan.Script.HEBREW), runs.map { it.first })
    assertEquals("Hi مرحبا 12 שלום!", runs.joinToString("") { it.second })
    assertTrue(PdfPlan.hasRtl("abc ש"))
    assertEquals(listOf(PdfPlan.Script.NEUTRAL to "123"), PdfPlan.runs("123"))
  }

  @Test fun combCells() {
    assertEquals(listOf("7", "5", "0"), PdfPlan.combCells("75008", 3))
  }

  @Test fun meanDifference() {
    assertEquals(0.0, PdfPlan.meanDifference(intArrayOf(1, 2), intArrayOf(1, 2)), 0.0)
    assertEquals(255.0, PdfPlan.meanDifference(intArrayOf(1), intArrayOf(1, 2)), 0.0)
  }
}

class ArabicShaperTest {
  private fun cps(s: String) = s.codePoints().toArray().map { Integer.toHexString(it) }

  @Test fun joinsLettersByPosition() {
    // بيت: beh initial, yeh medial, teh final.
    assertEquals(listOf("fe91", "fef4", "fe96"), cps(ArabicShaper.shape("بيت")))
    // دار: dal (right-joining) isolated, alef final? No: dal doesn't join forward, so alef is isolated; reh isolated.
    assertEquals(listOf("fea9", "fe8d", "fead"), cps(ArabicShaper.shape("دار")))
    // A single letter is isolated.
    assertEquals(listOf("fe8f"), cps(ArabicShaper.shape("ب")))
  }

  @Test fun lamAlefLigatures() {
    // لا alone: isolated ligature; سلام: seen initial, lam-alef final, meem isolated.
    assertEquals(listOf("fefb"), cps(ArabicShaper.shape("لا")))
    assertEquals(listOf("feb3", "fefc", "fee1"), cps(ArabicShaper.shape("سلام")))
  }

  @Test fun vowelMarksAreTransparent() {
    // بَت: the fatha doesn't break the joining.
    assertEquals(listOf("fe91", "64e", "fe96"), cps(ArabicShaper.shape("بَت")))
  }

  @Test fun persianLettersAndOtherTextUntouched() {
    // پی: peh initial, farsi yeh final.
    assertEquals(listOf("fb58", "fbfd"), cps(ArabicShaper.shape("پی")))
    assertEquals("Hello 123", ArabicShaper.shape("Hello 123"))
    // Spaces end words.
    assertEquals(listOf("fe8f", "20", "fe8f"), cps(ArabicShaper.shape("ب ب")))
  }
}
