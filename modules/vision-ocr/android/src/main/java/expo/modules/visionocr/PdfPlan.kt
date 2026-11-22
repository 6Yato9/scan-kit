package expo.modules.visionocr

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * The pure parts of the PDF tools (port phase 4), so they are unit-tested on
 * the JVM: page plans (PdfEditor.compose's checks), the transform that puts an
 * annotation's appearance on its page (flattening), form-field default
 * appearance strings, colours, line wrapping and the writing system of text.
 */
object PdfPlan {
  fun normalized(degrees: Int): Int = ((degrees % 360) + 360) % 360

  /**
   * null when `sources` / `rotations` are a valid plan for a document of
   * `pageCount` pages, else the message iOS rejects it with: each input page
   * at most once, a blank page -(k + 1) shaped like an existing page k, the
   * same number of rotations, each a multiple of 90.
   */
  fun check(sources: List<Int>, rotations: List<Int>, pageCount: Int): String? {
    if (pageCount <= 0) return "The PDF has no pages"
    if (sources.isEmpty() || rotations.size != sources.size) return "Bad page plan"
    val used = HashSet<Int>()
    for (s in sources) {
      val index = if (s >= 0) s else -s - 1
      if (index < 0 || index >= pageCount) return "Bad page plan"
      if (s >= 0 && !used.add(s)) return "Bad page plan"
    }
    if (rotations.any { it % 90 != 0 }) return "Bad rotation"
    return null
  }

  // ── Appearances on the page (ISO 32000-1 §12.5.5) ─────────────────────────

  /** [a b c d e f] applied to (x, y). */
  private fun apply(m: FloatArray, x: Float, y: Float): Pair<Float, Float> =
    (m[0] * x + m[2] * y + m[4]) to (m[1] * x + m[3] * y + m[5])

  /**
   * The matrix A that maps an appearance stream (its BBox [x0 y0 x1 y1]
   * transformed by its /Matrix) onto the annotation's Rect [x0 y0 x1 y1]: the
   * page content draws the form with `A cm /Fm Do`, and Do applies the form's
   * own Matrix. null for an empty box.
   */
  fun appearanceTransform(bbox: FloatArray, matrix: FloatArray, rect: FloatArray): FloatArray? {
    val corners = listOf(
      apply(matrix, bbox[0], bbox[1]), apply(matrix, bbox[2], bbox[1]),
      apply(matrix, bbox[2], bbox[3]), apply(matrix, bbox[0], bbox[3]),
    )
    val x0 = corners.minOf { it.first }
    val x1 = corners.maxOf { it.first }
    val y0 = corners.minOf { it.second }
    val y1 = corners.maxOf { it.second }
    val rx0 = min(rect[0], rect[2])
    val ry0 = min(rect[1], rect[3])
    val rw = abs(rect[2] - rect[0])
    val rh = abs(rect[3] - rect[1])
    val tw = x1 - x0
    val th = y1 - y0
    if (tw <= 1e-6f || th <= 1e-6f || rw <= 1e-6f || rh <= 1e-6f) return null
    val sx = rw / tw
    val sy = rh / th
    return floatArrayOf(sx, 0f, 0f, sy, rx0 - x0 * sx, ry0 - y0 * sy)
  }

  /** The /MK /R turn of a widget as an appearance /Matrix (a counter-clockwise rotation). */
  fun rotationMatrix(degrees: Int): FloatArray = when (normalized(degrees)) {
    90 -> floatArrayOf(0f, 1f, -1f, 0f, 0f, 0f)
    180 -> floatArrayOf(-1f, 0f, 0f, -1f, 0f, 0f)
    270 -> floatArrayOf(0f, -1f, 1f, 0f, 0f, 0f)
    else -> floatArrayOf(1f, 0f, 0f, 1f, 0f, 0f)
  }

  // ── Default appearance strings (/DA "/Helv 10 Tf 0 0 1 rg") ───────────────

  private fun tokens(da: String?): List<String> =
    (da ?: "").split(' ', '\n', '\r', '\t').filter { it.isNotEmpty() }

  /** The font size of a /DA (0 = automatic, also when there is none). */
  fun daFontSize(da: String?): Float {
    val t = tokens(da)
    val at = t.lastIndexOf("Tf")
    if (at < 2) return 0f
    val size = t[at - 1].toFloatOrNull() ?: return 0f
    return if (size.isFinite() && size > 0f) size else 0f
  }

  /** The font resource name of a /DA ("Helv"), or null. */
  fun daFontName(da: String?): String? {
    val t = tokens(da)
    val at = t.lastIndexOf("Tf")
    if (at < 2) return null
    return t[at - 2].takeIf { it.startsWith("/") && it.length > 1 }?.substring(1)
  }

  /** The non-stroking colour of a /DA as RGB 0..1 (g, rg or k), black when it has none. */
  fun daColor(da: String?): FloatArray {
    val t = tokens(da)
    fun nums(at: Int, n: Int): List<Float>? {
      if (at < n) return null
      val v = (at - n until at).map { t[it].toFloatOrNull() ?: return null }
      return v.map { it.coerceIn(0f, 1f) }
    }
    for (i in t.indices.reversed()) {
      when (t[i]) {
        "rg" -> nums(i, 3)?.let { return floatArrayOf(it[0], it[1], it[2]) }
        "g" -> nums(i, 1)?.let { return floatArrayOf(it[0], it[0], it[0]) }
        "k" -> nums(i, 4)?.let { c ->
          val k = c[3]
          return floatArrayOf((1 - c[0]) * (1 - k), (1 - c[1]) * (1 - k), (1 - c[2]) * (1 - k))
        }
      }
    }
    return floatArrayOf(0f, 0f, 0f)
  }

  /** "#rrggbb" → RGB 0..1; Fill & sign's near-black when missing or malformed (PdfFiller.color). */
  fun hexColor(hex: String?): FloatArray {
    val s = (hex ?: "").trim().removePrefix("#")
    val v = if (s.length == 6) s.toIntOrNull(16) else null
    if (v == null) return floatArrayOf(0.07f, 0.07f, 0.07f)
    return floatArrayOf(((v shr 16) and 0xff) / 255f, ((v shr 8) and 0xff) / 255f, (v and 0xff) / 255f)
  }

  // ── Text ──────────────────────────────────────────────────────────────────

  /**
   * Greedy word wrap of one paragraph to `maxWidth` (in the units `width`
   * measures): breaks at spaces, and inside a word only when the word alone
   * is too wide. Never returns an empty list.
   */
  fun wrap(paragraph: String, maxWidth: Float, width: (String) -> Float): List<String> {
    if (paragraph.isEmpty()) return listOf("")
    val words = paragraph.split(' ')
    val lines = ArrayList<String>()
    var line = ""
    fun pushWord(word: String) {
      var rest = word
      while (rest.isNotEmpty() && width(rest) > maxWidth) {
        // Longest prefix that fits (at least one character).
        var n = rest.length - 1
        while (n > 1 && width(rest.substring(0, n)) > maxWidth) n--
        n = max(1, n)
        lines.add(rest.substring(0, n))
        rest = rest.substring(n)
      }
      line = rest
    }
    for (word in words) {
      val candidate = if (line.isEmpty()) word else "$line $word"
      if (width(candidate) <= maxWidth) {
        line = candidate
      } else if (line.isEmpty()) {
        pushWord(word)
      } else {
        lines.add(line)
        line = ""
        pushWord(word)
      }
    }
    lines.add(line)
    return lines
  }

  enum class Script { LATIN, ARABIC, HEBREW, NEUTRAL }

  /** Arabic letters, marks and presentation forms. */
  fun isArabic(cp: Int): Boolean =
    cp in 0x0600..0x06FF || cp in 0x0750..0x077F || cp in 0x0870..0x08FF ||
      cp in 0xFB50..0xFDFF || cp in 0xFE70..0xFEFF

  fun isHebrew(cp: Int): Boolean = cp in 0x0590..0x05FF || cp in 0xFB1D..0xFB4F

  /** Spaces, digits and punctuation: they take the font of the text around them. */
  fun isNeutral(cp: Int): Boolean =
    cp <= 0x40 || cp in 0x5B..0x60 || cp in 0x7B..0xBF || cp == 0xD7 || cp == 0xF7 ||
      cp in 0x2000..0x206F || cp in 0x0660..0x0669 || cp in 0x06F0..0x06F9 || cp == 0x060C || cp == 0x061B || cp == 0x061F

  fun script(cp: Int): Script = when {
    isArabic(cp) -> Script.ARABIC
    isHebrew(cp) -> Script.HEBREW
    isNeutral(cp) -> Script.NEUTRAL
    else -> Script.LATIN
  }

  /** Text that needs right-to-left layout (and, for Arabic, joining). */
  fun hasRtl(text: String): Boolean {
    var i = 0
    while (i < text.length) {
      val cp = text.codePointAt(i)
      if (isArabic(cp) || isHebrew(cp)) return true
      i += Character.charCount(cp)
    }
    return false
  }

  /**
   * Splits `text` into runs of one writing system; neutral characters join
   * the run before them (or the first run, at the start). Returns
   * (script, text) pairs whose texts concatenate to `text`.
   */
  fun runs(text: String): List<Pair<Script, String>> {
    val out = ArrayList<Pair<Script, StringBuilder>>()
    var leading = StringBuilder()
    var i = 0
    while (i < text.length) {
      val cp = text.codePointAt(i)
      val s = script(cp)
      if (s == Script.NEUTRAL) {
        if (out.isEmpty()) leading.appendCodePoint(cp) else out.last().second.appendCodePoint(cp)
      } else if (out.isNotEmpty() && out.last().first == s) {
        out.last().second.appendCodePoint(cp)
      } else {
        val b = StringBuilder()
        if (out.isEmpty()) { b.append(leading); leading = StringBuilder() }
        b.appendCodePoint(cp)
        out.add(s to b)
      }
      i += Character.charCount(cp)
    }
    if (out.isEmpty()) return if (leading.isEmpty()) emptyList() else listOf(Script.NEUTRAL to leading.toString())
    return out.map { it.first to it.second.toString() }
  }

  /** A comb field's text: at most `maxLen` characters, one per cell. */
  fun combCells(text: String, maxLen: Int): List<String> {
    val cps = ArrayList<String>()
    var i = 0
    while (i < text.length && cps.size < maxLen) {
      val cp = text.codePointAt(i)
      cps.add(String(Character.toChars(cp)))
      i += Character.charCount(cp)
    }
    return cps
  }

  /** Mean absolute difference per pixel of two equally sized grey images, 0..255. */
  fun meanDifference(a: IntArray, b: IntArray): Double {
    if (a.size != b.size || a.isEmpty()) return 255.0
    var total = 0L
    for (k in a.indices) total += abs(a[k] - b[k])
    return total.toDouble() / a.size
  }
}
