package expo.modules.visionocr

import kotlin.math.max
import kotlin.math.min

/**
 * Pure text-layout logic of `recognize` (no android.*: JVM unit tests in
 * src/test cover it).
 *
 * Engines (see TextReader):
 *  - ML Kit Latin (bundled model) reads every page.
 *  - Tesseract with tessdata_fast `ara` reads a page only when ML Kit left
 *    text-like ink unread or misread much of it (`ink`, `suspectsArabic`).
 *  - `merge` then keeps, line by line, the engine that read that line:
 *    ML Kit wherever it read a clean line, Tesseract's confident, mostly
 *    Arabic lines elsewhere.
 *  - `readingOrder` is the iOS ordering (VisionOcrModule.swift recognize):
 *    rows of boxes that overlap vertically by at least half the smaller
 *    height, rows top to bottom, cells left to right — but right to left in a
 *    row whose letters are mostly right-to-left script (Arabic), where the
 *    first cell is the rightmost one.
 */
object OcrLayout {
  enum class Engine { LATIN, ARABIC }

  /** A recognised line in upright-image pixels. `confidence` 0..1 (-1 = unknown). */
  data class Line(
    val text: String,
    val left: Double,
    val top: Double,
    val width: Double,
    val height: Double,
    val confidence: Double = -1.0,
    val engine: Engine = Engine.LATIN,
  ) {
    val right get() = left + width
    val bottom get() = top + height
    val area get() = max(0.0, width) * max(0.0, height)
  }

  fun isArabicLetter(c: Char): Boolean {
    val cp = c.code
    return cp in 0x0600..0x06FF || cp in 0x0750..0x077F || cp in 0x08A0..0x08FF ||
      cp in 0xFB50..0xFDFF || cp in 0xFE70..0xFEFF
  }

  fun isHebrewLetter(c: Char): Boolean = c.code in 0x0590..0x05FF

  /** Share of the letters in `text` that are Arabic (0 when it has no letters). */
  fun arabicShare(text: String): Double {
    var letters = 0
    var arabic = 0
    for (c in text) {
      if (isArabicLetter(c) && Character.isLetter(c)) {
        letters++; arabic++
      } else if (Character.isLetter(c)) {
        letters++
      }
    }
    return if (letters == 0) 0.0 else arabic.toDouble() / letters
  }

  /** Mostly right-to-left letters (Arabic, Hebrew). */
  fun isRtl(text: String): Boolean {
    var letters = 0
    var rtl = 0
    for (c in text) {
      if (!Character.isLetter(c)) continue
      letters++
      if (isArabicLetter(c) || isHebrewLetter(c)) rtl++
    }
    return letters > 0 && rtl * 2 > letters
  }

  /**
   * How much of what ML Kit's Latin model returned looks like a misreading:
   * low confidence, or hardly any letters or digits. Arabic print read by the
   * Latin model comes back as short, low-confidence fragments ("JI", "ill",
   * "u..."). Weighted by box area, 0..1.
   */
  fun junkShare(lines: List<Line>): Double {
    var total = 0.0
    var junk = 0.0
    for (l in lines) {
      val a = l.area
      total += a
      if (looksMisread(l)) junk += a
    }
    return if (total <= 0) 0.0 else junk / total
  }

  fun looksMisread(l: Line): Boolean {
    val t = l.text.trim()
    if (t.isEmpty()) return true
    val alnum = t.count { it.isLetterOrDigit() }
    if (alnum * 2 < t.length) return true
    if (l.confidence in 0.0..0.55) return true
    return false
  }

  /** Text-like ink of a small grey copy of the page: inside ML Kit's line boxes, and outside them. */
  data class Ink(val covered: Int, val uncovered: Int, val total: Int)

  /**
   * Counts text-like ink in `gray` (w x h luminance 0..255, row-major). A
   * pixel is ink when it is darker than 65% of the mean of the 17 x 17
   * pixels around it and that mean is paper-bright (a dark desk or a shadow
   * isn't paper). Ink is then grouped into connected strokes and only
   * glyph-sized ones count (1.5-6% of the long side tall, at most 15% wide):
   * table rules, page edges, photos and stains don't. `boxes` are ML Kit's
   * lines in the same pixel space, padded by half their height; a stroke
   * whose centre lies in one is "covered" (read).
   */
  fun ink(gray: IntArray, w: Int, h: Int, boxes: List<Line>): Ink {
    val integral = LongArray((w + 1) * (h + 1))
    for (y in 0 until h) {
      var row = 0L
      for (x in 0 until w) {
        row += gray[y * w + x]
        integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row
      }
    }
    val r = 8
    val dark = BooleanArray(w * h)
    for (y in 0 until h) {
      val ya = max(0, y - r)
      val yb = min(h, y + r + 1)
      for (x in 0 until w) {
        val xa = max(0, x - r)
        val xb = min(w, x + r + 1)
        val sum = integral[yb * (w + 1) + xb] - integral[ya * (w + 1) + xb] - integral[yb * (w + 1) + xa] + integral[ya * (w + 1) + xa]
        val mean = sum.toDouble() / ((yb - ya) * (xb - xa))
        dark[y * w + x] = mean >= 120 && gray[y * w + x] < mean * 0.65
      }
    }
    val long = max(w, h)
    val minH = max(2, (long * 0.006).toInt())
    val maxH = max(minH + 1, (long * 0.06).toInt())
    val maxW = (long * 0.15).toInt()
    var covered = 0
    var uncovered = 0
    val seen = BooleanArray(w * h)
    val stack = IntArray(w * h)
    for (start in 0 until w * h) {
      if (!dark[start] || seen[start]) continue
      var top = 0
      stack[top++] = start
      seen[start] = true
      var n = 0
      var x0 = w; var x1 = -1; var y0 = h; var y1 = -1
      while (top > 0) {
        val p = stack[--top]
        n++
        val px = p % w
        val py = p / w
        if (px < x0) x0 = px
        if (px > x1) x1 = px
        if (py < y0) y0 = py
        if (py > y1) y1 = py
        for (d in 0 until 8) {
          val nx = px + DX[d]
          val ny = py + DY[d]
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          val q = ny * w + nx
          if (dark[q] && !seen[q]) {
            seen[q] = true
            stack[top++] = q
          }
        }
      }
      val ch = y1 - y0 + 1
      val cw = x1 - x0 + 1
      if (ch < minH || ch > maxH || cw > maxW) continue
      val cx = (x0 + x1) / 2.0
      val cy = (y0 + y1) / 2.0
      val inBox = boxes.any { b ->
        val pad = b.height * 0.5
        cx >= b.left - pad && cx <= b.right + pad && cy >= b.top - pad && cy <= b.bottom + pad
      }
      if (inBox) covered += n else uncovered += n
    }
    return Ink(covered, uncovered, w * h)
  }

  private val DX = intArrayOf(-1, 0, 1, -1, 1, -1, 0, 1)
  private val DY = intArrayOf(-1, -1, -1, 0, 0, 1, 1, 1)

  /**
   * Whether the page should also be read by the Arabic engine. ML Kit's Latin
   * model skips script it doesn't know rather than misreading it, so the
   * main signal is ink it left unread: dark strokes outside every line it
   * returned, at least 0.3% of the page and a fifth of the ink it did read
   * (a page that also has Arabic lines; a page entirely in Arabic). A large
   * share of misread-looking lines is the other signal. A blank page has no
   * ink at all and costs nothing. `arabicPreferred` (an Arabic device
   * language) lowers both bars.
   */
  fun suspectsArabic(latin: List<Line>, ink: Ink?, arabicPreferred: Boolean): Boolean {
    if (latin.isNotEmpty() && junkShare(latin) >= (if (arabicPreferred) 0.12 else 0.25)) return true
    if (ink == null) return latin.isEmpty()
    val minShare = if (arabicPreferred) 0.0015 else 0.003
    if (ink.total <= 0 || ink.uncovered < ink.total * minShare) return false
    return ink.uncovered >= ink.covered * (if (arabicPreferred) 0.1 else 0.2)
  }

  /** Overlap area of two boxes over the smaller one's area. */
  fun overlapRatio(a: Line, b: Line): Double {
    val w = min(a.right, b.right) - max(a.left, b.left)
    val h = min(a.bottom, b.bottom) - max(a.top, b.top)
    if (w <= 0 || h <= 0) return 0.0
    val smaller = min(a.area, b.area)
    return if (smaller <= 0) 0.0 else (w * h) / smaller
  }

  /**
   * Tesseract lines worth keeping: mostly Arabic letters, read confidently.
   * (The Arabic model reads Latin print as Arabic-looking letters too, so
   * neither test alone is enough; see `merge` for the rest.)
   */
  fun arabicLines(tesseract: List<Line>): List<Line> = tesseract.filter {
    it.text.isNotBlank() && arabicShare(it.text) >= 0.6 && (it.confidence < 0 || it.confidence >= 0.6)
  }

  /**
   * ML Kit's lines plus the Arabic engine's Arabic lines. ML Kit wins
   * wherever it read a clean line: Tesseract's Arabic model turns Latin print
   * into confident Arabic-looking letters, so an "Arabic" line sitting on a
   * clean Latin line (overlap >= 30% of the smaller box) is that misreading
   * and is dropped. ML Kit lines that look misread and sit on a kept Arabic
   * line are dropped instead. With no Arabic lines, ML Kit's result stands.
   */
  fun merge(latin: List<Line>, tesseract: List<Line>): List<Line> {
    val cleanLatin = latin.filter { !looksMisread(it) }
    val arabic = arabicLines(tesseract).filter { a -> cleanLatin.none { overlapRatio(a, it) >= 0.3 } }
    if (arabic.isEmpty()) return latin
    val keptLatin = latin.filter { l -> !looksMisread(l) || arabic.none { overlapRatio(l, it) >= 0.3 } }
    return keptLatin + arabic
  }

  /** Lines in reading order, and the page text: cells joined with two spaces, rows with newlines. */
  fun readingOrder(lines: List<Line>): Pair<List<Line>, String> {
    val byTop = lines.filter { it.text.isNotBlank() }.sortedBy { it.top }
    val rows = mutableListOf<MutableList<Line>>()
    for (l in byTop) {
      val row = rows.firstOrNull { row ->
        row.any { o ->
          val overlap = min(l.bottom, o.bottom) - max(l.top, o.top)
          overlap >= min(l.height, o.height) * 0.5
        }
      }
      if (row != null) row.add(l) else rows.add(mutableListOf(l))
    }
    val ordered = mutableListOf<Line>()
    val texts = mutableListOf<String>()
    for (row in rows) {
      val rtl = isRtl(row.joinToString(" ") { it.text })
      val cells = if (rtl) row.sortedByDescending { it.right } else row.sortedBy { it.left }
      ordered.addAll(cells)
      texts.add(cells.joinToString("  ") { it.text.trim() })
    }
    return ordered to texts.joinToString("\n")
  }
}
