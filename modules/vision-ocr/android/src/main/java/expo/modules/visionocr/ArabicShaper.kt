package expo.modules.visionocr

/**
 * Arabic joining for text drawn into PDFs (port phase 4). Android doesn't
 * expose ICU's ArabicShaping, and PdfBox draws characters one glyph each, so
 * the letters' contextual forms are chosen here: each letter takes its
 * isolated, final, initial or medial presentation form (Unicode Arabic
 * Presentation Forms-A/B, which the bundled Noto Naskh Arabic maps to its
 * joined glyphs) from its neighbours' joining types, vowel marks being
 * transparent; lam + alef become their ligature. Pure, in logical order (put
 * the result in visual order with Bidi afterwards).
 *
 * Covers the Arabic letters U+0621–U+064A and the Persian/Urdu letters with
 * presentation forms (پ چ ژ ک گ ی ٹ ڈ ڑ ھ ہ ے ٱ). Other letters stay as they
 * are (drawn unjoined).
 */
object ArabicShaper {
  private enum class Join { RIGHT, DUAL, CAUSING, TRANSPARENT, NONE }

  /** isolated, final, initial, medial (0 when the letter has no such form). */
  private val FORMS: Map<Int, IntArray> = HashMap<Int, IntArray>().apply {
    fun r(c: Int, iso: Int) { put(c, intArrayOf(iso, iso + 1, 0, 0)) }
    fun d(c: Int, iso: Int) { put(c, intArrayOf(iso, iso + 1, iso + 2, iso + 3)) }
    put(0x0621, intArrayOf(0xFE80, 0, 0, 0))
    r(0x0622, 0xFE81); r(0x0623, 0xFE83); r(0x0624, 0xFE85); r(0x0625, 0xFE87)
    d(0x0626, 0xFE89); r(0x0627, 0xFE8D); d(0x0628, 0xFE8F); r(0x0629, 0xFE93)
    d(0x062A, 0xFE95); d(0x062B, 0xFE99); d(0x062C, 0xFE9D); d(0x062D, 0xFEA1)
    d(0x062E, 0xFEA5); r(0x062F, 0xFEA9); r(0x0630, 0xFEAB); r(0x0631, 0xFEAD)
    r(0x0632, 0xFEAF); d(0x0633, 0xFEB1); d(0x0634, 0xFEB5); d(0x0635, 0xFEB9)
    d(0x0636, 0xFEBD); d(0x0637, 0xFEC1); d(0x0638, 0xFEC5); d(0x0639, 0xFEC9)
    d(0x063A, 0xFECD); d(0x0641, 0xFED1); d(0x0642, 0xFED5); d(0x0643, 0xFED9)
    d(0x0644, 0xFEDD); d(0x0645, 0xFEE1); d(0x0646, 0xFEE5); d(0x0647, 0xFEE9)
    r(0x0648, 0xFEED); r(0x0649, 0xFEEF); d(0x064A, 0xFEF1)
    // Presentation Forms-A: Persian and Urdu.
    r(0x0671, 0xFB50); d(0x0679, 0xFB66); d(0x067E, 0xFB56); d(0x0686, 0xFB7A)
    r(0x0688, 0xFB88); r(0x0691, 0xFB8C); r(0x0698, 0xFB8A); d(0x06A9, 0xFB8E)
    d(0x06AF, 0xFB92); d(0x06BE, 0xFBAA); d(0x06C1, 0xFBA6); r(0x06C0, 0xFBA4)
    d(0x06CC, 0xFBFC); r(0x06D2, 0xFBAE); r(0x06D3, 0xFBB0)
  }

  /** Lam + alef ligatures: alef → (isolated, final). */
  private val LAM_ALEF = mapOf(
    0x0622 to intArrayOf(0xFEF5, 0xFEF6), 0x0623 to intArrayOf(0xFEF7, 0xFEF8),
    0x0625 to intArrayOf(0xFEF9, 0xFEFA), 0x0627 to intArrayOf(0xFEFB, 0xFEFC),
  )

  private fun isTransparent(c: Int): Boolean =
    c in 0x064B..0x065F || c == 0x0670 || c in 0x06D6..0x06DC || c in 0x06DF..0x06E4 ||
      c == 0x06E7 || c == 0x06E8 || c in 0x06EA..0x06ED

  private fun join(c: Int): Join {
    if (isTransparent(c)) return Join.TRANSPARENT
    if (c == 0x0640 || c == 0x200D) return Join.CAUSING // tatweel, zero-width joiner
    val f = FORMS[c] ?: return Join.NONE
    return if (f[2] != 0) Join.DUAL else if (f[1] != 0) Join.RIGHT else Join.NONE
  }

  private fun joinsForward(j: Join) = j == Join.DUAL || j == Join.CAUSING
  private fun joinsBackward(j: Join) = j == Join.DUAL || j == Join.RIGHT || j == Join.CAUSING

  /** `text` with its Arabic letters in their joined presentation forms (logical order kept). */
  fun shape(text: String): String {
    val cps = text.codePoints().toArray()
    if (cps.none { FORMS.containsKey(it) }) return text
    val n = cps.size
    fun prevIndex(i: Int): Int {
      var k = i - 1
      while (k >= 0 && join(cps[k]) == Join.TRANSPARENT) k--
      return k
    }
    fun nextIndex(i: Int): Int {
      var k = i + 1
      while (k < n && join(cps[k]) == Join.TRANSPARENT) k++
      return k
    }
    val out = StringBuilder(text.length)
    val consumed = BooleanArray(n)
    for (i in 0 until n) {
      if (consumed[i]) continue
      val c = cps[i]
      val forms = FORMS[c]
      if (forms == null) {
        out.appendCodePoint(c)
        continue
      }
      val p = prevIndex(i)
      val q = nextIndex(i)
      val me = join(c)
      val joinsPrev = p >= 0 && joinsForward(join(cps[p])) && joinsBackward(me)
      // Lam followed by alef: one ligature glyph, final when the lam joins before it.
      if (c == 0x0644 && q < n && LAM_ALEF.containsKey(cps[q])) {
        val lig = LAM_ALEF.getValue(cps[q])
        out.appendCodePoint(if (joinsPrev) lig[1] else lig[0])
        // Marks between the lam and the alef follow the ligature.
        for (k in i + 1 until q) { out.appendCodePoint(cps[k]); consumed[k] = true }
        consumed[q] = true
        continue
      }
      val joinsNext = q < n && joinsForward(me) && joinsBackward(join(cps[q]))
      val form = when {
        joinsPrev && joinsNext && forms[3] != 0 -> forms[3]
        joinsPrev && forms[1] != 0 -> forms[1]
        joinsNext && forms[2] != 0 -> forms[2]
        else -> forms[0]
      }
      out.appendCodePoint(if (form != 0) form else c)
    }
    return out.toString()
  }
}
