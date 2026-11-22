package expo.modules.visionocr

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.icu.text.Bidi
import android.text.TextPaint
import com.tom_roush.fontbox.ttf.CmapLookup
import com.tom_roush.fontbox.ttf.TTFParser
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPageContentStream
import com.tom_roush.pdfbox.pdmodel.font.PDFont
import com.tom_roush.pdfbox.pdmodel.font.PDType0Font
import com.tom_roush.pdfbox.pdmodel.font.PDType1Font
import com.tom_roush.pdfbox.pdmodel.graphics.image.LosslessFactory
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Text that PdfBox's standard fonts can't show (port phase 4): form-field
 * values and Fill & sign text outside Latin-1 (Polish Ł, Romanian Ș, Greek,
 * Cyrillic, Arabic, Hebrew…).
 *
 * - Fonts bundled in the APK (assets/fonts, see LICENSES.txt), embedded in the
 *   PDF as subsets: Roboto (Latin, Greek, Cyrillic, Vietnamese), Noto Naskh
 *   Arabic, Noto Sans Hebrew. A line mixing scripts is drawn in runs, one font
 *   per run.
 * - Arabic is joined on the device (ArabicShaper: each letter's initial,
 *   medial, final or isolated form and the lam-alef ligatures, drawn with the
 *   font's presentation-form glyphs), and right-to-left text is put in visual
 *   order with ICU's Bidi (android.icu.text.Bidi; brackets mirrored). Vowel
 *   marks are drawn with the font's own offsets, without OpenType mark
 *   positioning.
 * - Anything else (CJK, Indic, Thai…) has no bundled font: it is drawn by
 *   Android's own text engine (system fonts, full shaping) into an image at
 *   4× and placed as such, so it at least shows; that text isn't selectable
 *   in the page (the form value and the mark's /Contents still hold it).
 *
 * Latin-1 text keeps the standard Helvetica (no font embedded), as before.
 */
class PdfText(private val context: Context, private val doc: PDDocument) {
  enum class Face(val asset: String) {
    LATIN("fonts/RobotoStatic-Regular.ttf"),
    ARABIC("fonts/NotoNaskhArabic-Regular.ttf"),
    HEBREW("fonts/NotoSansHebrew-Regular.ttf"),
  }

  /** A piece of a line in one font, its text in visual order (shaped). */
  class Run(val font: PDFont, val text: String, val width: Float)

  /** A line ready to draw: its runs left to right and its width at size 1. */
  class Line(val runs: List<Run>, val width: Float)

  private val loaded = HashMap<Face, PDFont>()

  private fun font(face: Face): PDFont = loaded.getOrPut(face) {
    context.assets.open(face.asset).use { PDType0Font.load(doc, it, true) }
  }

  /** True when Helvetica (WinAnsi) can show `text` and it needs no right-to-left layout. */
  fun standardCan(text: String): Boolean {
    if (PdfPlan.hasRtl(text)) return false
    return try {
      PDType1Font.HELVETICA.encode(text.replace("\n", ""))
      true
    } catch (e: Throwable) {
      false
    }
  }

  /**
   * One logical line laid out for drawing: shaped, in visual order, split
   * into font runs. null when a character has no bundled font (draw it with
   * [rasterize] instead).
   */
  fun layout(logical: String, standard: Boolean): Line? {
    if (standard && standardCan(logical)) {
      val f = PDType1Font.HELVETICA
      val w = f.getStringWidth(logical) / 1000f
      return Line(listOf(Run(f, logical, w)), w)
    }
    val visual = visualOrder(logical)
    val runs = ArrayList<Run>()
    var current: Face? = null
    val buf = StringBuilder()
    fun flush() {
      val face = current ?: return
      if (buf.isEmpty()) return
      val f = font(face)
      val text = buf.toString()
      runs.add(Run(f, text, f.getStringWidth(text) / 1000f))
      buf.setLength(0)
    }
    var i = 0
    while (i < visual.length) {
      val cp = visual.codePointAt(i)
      i += Character.charCount(cp)
      if (cp == 0x200C || cp == 0x200D || cp == 0x200E || cp == 0x200F) continue // joiners / marks: shaping is done
      val face = faceFor(cp, current) ?: return null
      if (face != current) {
        flush()
        current = face
      }
      buf.appendCodePoint(cp)
    }
    flush()
    return Line(runs, runs.fold(0f) { a, r -> a + r.width })
  }

  private fun faceFor(cp: Int, current: Face?): Face? {
    val wanted = when (PdfPlan.script(cp)) {
      PdfPlan.Script.ARABIC -> Face.ARABIC
      PdfPlan.Script.HEBREW -> Face.HEBREW
      PdfPlan.Script.LATIN -> Face.LATIN
      PdfPlan.Script.NEUTRAL -> current ?: Face.LATIN
    }
    if (covers(wanted, cp)) return wanted
    return Face.values().firstOrNull { covers(it, cp) }
  }

  /** Width of a logical line at size 1, or null when it can't be laid out. */
  fun width(logical: String, standard: Boolean): Float? = layout(logical, standard)?.width

  /** Draws `line` with its left end at (x, y) baseline, `size` pt. Call inside no text object. */
  fun draw(cs: PDPageContentStream, line: Line, x: Float, y: Float, size: Float, rgb: FloatArray) {
    if (line.runs.isEmpty()) return
    cs.beginText()
    cs.setNonStrokingColor(rgb[0], rgb[1], rgb[2])
    var first = true
    var previous = 0f
    for (run in line.runs) {
      cs.setFont(run.font, size)
      if (first) cs.newLineAtOffset(x, y) else cs.newLineAtOffset(previous, 0f)
      cs.showText(run.text)
      previous = run.width * size
      first = false
    }
    cs.endText()
  }

  /**
   * Lines of text drawn by Android's text engine into a transparent image
   * of `w` × `h` points (4 px per point, at most 2400 px a side), the first
   * baseline at `ascent` from the top, each `lineHeight` below the last,
   * aligned 0 left / 1 centre / 2 right. Placed with [drawImage].
   */
  fun rasterize(lines: List<String>, w: Float, h: Float, size: Float, lineHeight: Float, ascent: Float, rgb: FloatArray, align: Int, topInset: Float = 0f): Bitmap {
    val scale = min(4f, 2400f / max(1f, max(w, h)))
    val bw = max(1, ceil(w * scale).toInt())
    val bh = max(1, ceil(h * scale).toInt())
    val bmp = Bitmap.createBitmap(bw, bh, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bmp)
    val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
      textSize = size * scale
      color = android.graphics.Color.rgb((rgb[0] * 255).roundToInt(), (rgb[1] * 255).roundToInt(), (rgb[2] * 255).roundToInt())
    }
    var y = (topInset + ascent) * scale
    for (line in lines) {
      val lw = paint.measureText(line)
      val x = when (align) {
        1 -> (bw - lw) / 2f
        2 -> bw - lw
        else -> 0f
      }
      canvas.drawText(line, x, y, paint)
      y += lineHeight * scale
    }
    return bmp
  }

  /** Puts a rasterized text image at (x, y, w, h) in the content stream. */
  fun drawImage(cs: PDPageContentStream, bmp: Bitmap, x: Float, y: Float, w: Float, h: Float) {
    val image = LosslessFactory.createFromImage(doc, bmp)
    cs.drawImage(image, x, y, w, h)
    bmp.recycle()
  }

  companion object {
    private val cmaps = HashMap<Face, CmapLookup?>()

    /** The bundled font has a glyph for `cp` (its cmap, read once per process). */
    private fun coverage(context: Context, face: Face): CmapLookup? = synchronized(cmaps) {
      cmaps.getOrPut(face) {
        try {
          context.assets.open(face.asset).use { TTFParser().parse(it).getUnicodeCmapLookup() }
        } catch (e: Throwable) {
          null
        }
      }
    }

    private lateinit var appContext: Context

    fun remember(context: Context) {
      appContext = context.applicationContext
    }

    private fun covers(face: Face, cp: Int): Boolean =
      (coverage(appContext, face)?.getGlyphId(cp) ?: 0) != 0

    /**
     * Arabic letters joined (presentation forms) and the line put in visual
     * order, left to right. Text without right-to-left characters is returned
     * as it is.
     */
    fun visualOrder(logical: String): String {
      if (!PdfPlan.hasRtl(logical)) return logical
      val shaped = ArabicShaper.shape(logical)
      return try {
        val bidi = Bidi()
        bidi.setPara(shaped, Bidi.LEVEL_DEFAULT_LTR, null)
        bidi.writeReordered(Bidi.DO_MIRRORING.toInt() or Bidi.REMOVE_BIDI_CONTROLS.toInt())
      } catch (e: Throwable) {
        shaped
      }
    }
  }

  init {
    remember(context)
  }

  private fun covers(face: Face, cp: Int) = Companion.covers(face, cp)
}
