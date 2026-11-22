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

  // ── Writing permissions back (port phase 4) ──────────────────────────────

  /** The eight /P bits that mean something (ISO 32000 table 22: 3, 4, 5, 6, 9, 10, 11, 12; 1-based). */
  const val P_MEANINGFUL = (1 shl 2) or (1 shl 3) or (1 shl 4) or (1 shl 5) or (1 shl 8) or (1 shl 9) or (1 shl 10) or (1 shl 11)

  private fun pBit(n: Int) = 1 shl (n - 1)

  /**
   * PDFAccessPermissions bits → the /P bits of a revision 3+ file, each
   * permission on its own bit (full-quality printing only with printing).
   * fromP(toP(b), 6) == b for every `b` that fromP can produce (it adds
   * accessibility to copying, form filling to commenting, assembly to
   * changing content).
   */
  fun toP(bits: Int): Int {
    var p = 0
    if (bits and PRINT_LOW != 0) p = p or pBit(3)
    if (bits and PRINT_LOW != 0 && bits and PRINT_HIGH != 0) p = p or pBit(12)
    if (bits and CHANGE_CONTENT != 0) p = p or pBit(4)
    if (bits and COPY != 0) p = p or pBit(5)
    if (bits and COMMENT != 0) p = p or pBit(6)
    if (bits and FILL_FORMS != 0) p = p or pBit(9)
    if (bits and ACCESSIBILITY != 0) p = p or pBit(10)
    if (bits and ASSEMBLE != 0) p = p or pBit(11)
    return p
  }

  /**
   * A file's permissions as revision 3+ /P bits: the meaningful bits as they
   * are for revision 3 and later (exact), and for revision 2, whose bits 9-12
   * are reserved, what its coarse bits allow spelled out.
   */
  fun effectiveP(p: Int, revision: Int): Int =
    if (revision >= 3) p and P_MEANINGFUL else toP(fromP(p, revision))

  /**
   * null when a written file (`writtenP`, `writtenR`) allows nothing a source
   * (`sourceP`, `sourceR`) didn't; else what widened, for the log. Compared
   * both ways: as PDFKit bits (what readers derive) and as the raw /P bits.
   */
  fun widened(sourceP: Int, sourceR: Int, writtenP: Int, writtenR: Int): String? {
    val was = fromP(sourceP, sourceR)
    val now = fromP(writtenP, writtenR)
    if (now and was.inv() != 0) return "permission bits $was -> $now"
    val rawWas = effectiveP(sourceP, sourceR)
    val rawNow = effectiveP(writtenP, writtenR)
    if (rawNow and rawWas.inv() != 0) return "/P bits ${Integer.toBinaryString(rawWas)} -> ${Integer.toBinaryString(rawNow)}"
    return null
  }

  /** The ISO bit numbers (3…12) set in `p`, for AccessPermission setters. */
  fun isSet(p: Int, isoBit: Int): Boolean = p and pBit(isoBit) != 0
}

