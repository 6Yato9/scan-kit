package expo.modules.visionocr

/**
 * PDF permissions in the layout JS stores and passes back: PDFKit's
 * PDFAccessPermissions bits (PdfUnrestrict.swift `permissions`,
 * PdfProtector.swift `PdfPasswordCheck.permissionBits`). Pure, so the
 * mapping from a file's raw /P value is unit-tested against the iOS rules.
 */
object PdfPermissionBits {
  const val PRINT_LOW = 1 shl 0
  const val PRINT_HIGH = 1 shl 1
  const val CHANGE_CONTENT = 1 shl 2
  const val ASSEMBLE = 1 shl 3
  const val COPY = 1 shl 4
  const val ACCESSIBILITY = 1 shl 5
  const val COMMENT = 1 shl 6
  const val FILL_FORMS = 1 shl 7
  const val ALL = 0xff

  /** The JS names of the eight bits, in bit order. */
  val NAMES = listOf("printLow", "printHigh", "changeContent", "assemblePages", "copy", "accessibility", "comment", "fillForms")

  /**
   * What a file's /P allows (ISO 32000 table 22; bit 1 is the lowest), as
   * PDFAccessPermissions bits: the exact port of PdfPasswordCheck.permissionBits.
   * Revision 3+ splits form filling (bit 9), assembly (bit 11) and
   * full-quality printing (bit 12) out of the coarser bits.
   */
  fun fromP(p: Int, revision: Int): Int {
    fun on(bit: Int) = p and (1 shl (bit - 1)) != 0
    val print = on(3)
    val modify = on(4)
    val copy = on(5)
    val annotate = on(6)
    val r3 = revision >= 3
    var bits = 0
    if (print) bits = bits or PRINT_LOW
    if (print && (!r3 || on(12))) bits = bits or PRINT_HIGH
    if (modify) bits = bits or CHANGE_CONTENT
    if (modify || (r3 && on(11))) bits = bits or ASSEMBLE
    if (copy) bits = bits or COPY
    if (copy || (r3 && on(10))) bits = bits or ACCESSIBILITY
    if (annotate) bits = bits or COMMENT
    if (annotate || (r3 && on(9))) bits = bits or FILL_FORMS
    return bits
  }

  /** { printLow: …, …, fillForms: … } for JS. */
  fun toMap(bits: Int): Map<String, Boolean> =
    NAMES.withIndex().associate { (i, name) -> name to (bits and (1 shl i) != 0) }
}
