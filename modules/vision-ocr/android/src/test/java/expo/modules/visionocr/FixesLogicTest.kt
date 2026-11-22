package expo.modules.visionocr

import com.tom_roush.pdfbox.multipdf.PDFMergerUtility
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDCheckBox
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDRadioButton
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDTerminalField
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDTextField
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream

/** Review fixes: memory-bounded decoding plans, and merged forms keeping radio groups and hierarchy. */
class DecodePlanTest {
  @Test fun sampleKeepsTheDecodeAtOrAboveTheTarget() {
    assertEquals(1, DecodePlan.sample(4032, 4096))
    assertEquals(1, DecodePlan.sample(8160, 4096)) // 50 MP: half is 4080 < 4096 → the strips take it
    assertEquals(2, DecodePlan.sample(8192, 4096))
    assertEquals(2, DecodePlan.sample(12000, 4096)) // 108 MP
    assertEquals(2, DecodePlan.sample(16320, 4096)) // 200 MP: 8160 px, then strips
    assertEquals(2, DecodePlan.sample(8160, 2048))
    assertEquals(4, DecodePlan.sample(8192, 2048))
  }

  @Test fun largePhotosAreDecodedInStripsThatCoverEveryRow() {
    // 50 MP at sample 1 would be ~200 MB: over the threshold.
    assertTrue(DecodePlan.sampledBytes(8160, 6120, 1) > DecodePlan.STRIP_THRESHOLD_BYTES)
    assertTrue(DecodePlan.sampledBytes(5184, 3888, 1) > DecodePlan.STRIP_THRESHOLD_BYTES) // 20 MP
    // A 12 MP camera frame (and a 16 MP one) is decoded in one go.
    assertTrue(DecodePlan.sampledBytes(4032, 3024, 1) <= DecodePlan.STRIP_THRESHOLD_BYTES)
    assertTrue(DecodePlan.sampledBytes(4608, 3456, 1) <= DecodePlan.STRIP_THRESHOLD_BYTES)
    for ((w, h, s) in listOf(Triple(8160, 6120, 1), Triple(12000, 9000, 2), Triple(16320, 12240, 4), Triple(100, 7, 1))) {
      val strips = DecodePlan.strips(w, h, s)
      assertEquals(0, strips.first()[0])
      assertEquals(h, strips.last()[1])
      for (i in 1 until strips.size) assertEquals(strips[i - 1][1], strips[i][0])
      for (st in strips.dropLast(1)) assertEquals(0, (st[1] - st[0]) % s)
      // Each strip stays near the strip budget once subsampled.
      val rows = (strips.first()[1] - strips.first()[0]) / s
      assertTrue(rows.toLong() * (w / s) * 4 <= DecodePlan.STRIP_BYTES + (w / s) * 4L * 16)
    }
  }

  private fun map(o: Int, w: Float, h: Float, x: Float, y: Float): Pair<Float, Float> {
    val m = DecodePlan.orientation(o, w, h)
    return (m[0] * x + m[1] * y + m[2]) to (m[3] * x + m[4] * y + m[5])
  }

  @Test fun orientationMapsTheStoredCornersWhereExifSays() {
    val w = 40f
    val h = 30f
    // Top-left of the stored image goes to: 1 TL, 3 BR, 6 TR (turned clockwise), 8 BL.
    assertEquals(0f to 0f, map(1, w, h, 0f, 0f))
    assertEquals(w to h, map(3, w, h, 0f, 0f))
    assertEquals(h to 0f, map(6, w, h, 0f, 0f))
    assertEquals(0f to w, map(8, w, h, 0f, 0f))
    assertEquals(w to 0f, map(2, w, h, 0f, 0f))
    assertEquals(0f to h, map(4, w, h, 0f, 0f))
    assertEquals(0f to 0f, map(5, w, h, 0f, 0f))
    assertEquals(h to w, map(7, w, h, 0f, 0f))
    // Every map lands the stored rectangle exactly on the upright one.
    for (o in 1..8) {
      val (uw, uh) = DecodePlan.uprightSize(w.toInt(), h.toInt(), o)
      val xs = listOf(0f to 0f, w to 0f, w to h, 0f to h).map { (x, y) -> map(o, w, h, x, y) }
      assertEquals(0f, xs.minOf { it.first })
      assertEquals(0f, xs.minOf { it.second })
      assertEquals(uw.toFloat(), xs.maxOf { it.first })
      assertEquals(uh.toFloat(), xs.maxOf { it.second })
    }
    assertArrayEquals(intArrayOf(1, 6, 3, 8, 6), intArrayOf(0, 90, 180, 270, -270).map { DecodePlan.orientationForRotation(it) }.toIntArray())
  }
}

class MergedFormFieldsTest {
  private fun load(name: String): PDDocument = PDDocument.load(javaClass.getResourceAsStream("/merge/$name"))

  /** form-a: name=Alice, radio choice=B (its second button), a.b=inner, c=twice (two widgets), agree on. form-b: Bob, A, other, two. */
  @Test fun renamedPartsKeepRadioGroupsHierarchyAndValues() {
    val dest = PDDocument()
    val used = HashSet<String>()
    val merger = PDFMergerUtility()
    val parts = listOf("form-a.pdf", "form-b.pdf", "form-a.pdf").map { load(it) }
    for (part in parts) {
      PdfMergeNames.renameClashing(part, used)
      merger.appendDocument(dest, part)
    }
    val bytes = ByteArrayOutputStream().also { dest.save(it) }.toByteArray()
    parts.forEach { it.close() }
    dest.close()
    PDDocument.load(bytes).use { back ->
      val fields = back.documentCatalog.acroForm.fieldTree.filterIsInstance<PDTerminalField>().associateBy { it.fullyQualifiedName }
      assertEquals(
        setOf("name", "choice", "a.b", "c", "agree", "name_2", "choice_2", "a_2.b", "c_2", "agree_2", "name_3", "choice_3", "a_3.b", "c_3", "agree_3"),
        fields.keys,
      )
      for ((suffix, radio, text, twice, name) in listOf(
        listOf("", "B", "inner", "twice", "Alice"), listOf("_2", "A", "other", "two", "Bob"), listOf("_3", "B", "inner", "twice", "Alice"),
      )) {
        val group = fields["choice$suffix"] as PDRadioButton
        assertEquals(2, group.widgets.size) // still one group of two buttons
        assertEquals(radio, group.value)
        assertEquals(listOf("Off", radio).sorted(), group.widgets.map { it.appearanceState.name }.sorted())
        assertEquals(text, (fields["a$suffix.b"] as PDTextField).value)
        assertEquals("b", fields["a$suffix.b"]!!.partialName) // the child keeps its own name
        val c = fields["c$suffix"] as PDTextField
        assertEquals(2, c.widgets.size)
        assertEquals(twice, c.value)
        assertEquals(name, (fields["name$suffix"] as PDTextField).value)
        assertTrue((fields["agree$suffix"] as PDCheckBox).isChecked)
      }
      assertEquals(21, back.pages.sumOf { it.annotations.size })
    }
  }
}
