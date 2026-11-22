package expo.modules.visionocr

import com.tom_roush.pdfbox.cos.COSArray
import com.tom_roush.pdfbox.cos.COSName
import com.tom_roush.pdfbox.cos.COSString
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPageContentStream
import com.tom_roush.pdfbox.pdmodel.PDResources
import com.tom_roush.pdfbox.pdmodel.common.PDRectangle
import com.tom_roush.pdfbox.pdmodel.interactive.annotation.PDAnnotationWidget
import com.tom_roush.pdfbox.pdmodel.interactive.annotation.PDAppearanceDictionary
import com.tom_roush.pdfbox.pdmodel.interactive.annotation.PDAppearanceStream
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDTextField
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDVariableText
import kotlin.math.max
import kotlin.math.min

/**
 * A text or choice widget's normal appearance drawn by Scan Kit (port phase
 * 4), for values PdfBox's generator can't draw with the form's own font
 * (scripts outside Latin-1, right-to-left text). It follows what PdfBox and
 * Acrobat draw: the widget's background and border (/MK), its turn (/MK /R),
 * padding inside the border, the field's alignment (/Q), comb cells, a
 * multiline field's wrapped lines, the /DA size (automatic: fits the height,
 * at most 12 pt) and colour, inside /Tx BMC … EMC. Text goes through PdfText
 * (bundled fonts, Arabic joined, visual order).
 */
object FieldAppearance {
  private val TX = COSName.getPDFName("Tx")
  private const val ASCENT = 0.77f
  private const val CAP = 0.71f
  private const val LEADING = 1.15f

  fun build(doc: PDDocument, field: PDVariableText, widget: PDAnnotationWidget, value: String, text: PdfText) {
    val d = widget.cosObject
    val r = PdfForms.rectOf(d)
    val rw = r[2].toFloat()
    val rh = r[3].toFloat()
    if (rw <= 0f || rh <= 0f) return
    val mk = widget.appearanceCharacteristics
    val turn = PdfPlan.normalized(mk?.rotation ?: 0)
    val w = if (turn % 180 != 0) rh else rw
    val h = if (turn % 180 != 0) rw else rh
    val bg = PdfForms.rgbOf(mk?.background)
    val bc = PdfForms.rgbOf(mk?.borderColour)
    val borderWidth = widget.borderStyle?.width ?: (if (bc != null) 1f else 0f)
    val da = (d.getDictionaryObject(COSName.DA) as? COSString)?.string ?: field.defaultAppearance
    val rgb = PdfPlan.daColor(da)
    val multiline = field is PDTextField && field.isMultiline
    val comb = field is PDTextField && field.isComb && !multiline && field.maxLen > 0
    val q = field.q

    val ap = PDAppearanceStream(doc)
    ap.bBox = PDRectangle(0f, 0f, w, h)
    ap.resources = PDResources()
    if (turn != 0) {
      val m = PdfPlan.rotationMatrix(turn)
      ap.cosObject.setItem(COSName.MATRIX, COSArray().apply { setFloatArray(m) })
    }
    PDPageContentStream(doc, ap).use { cs ->
      if (bg != null) {
        cs.setNonStrokingColor(bg[0], bg[1], bg[2])
        cs.addRect(0f, 0f, w, h)
        cs.fill()
      }
      if (bc != null && borderWidth > 0f) {
        cs.setStrokingColor(bc[0], bc[1], bc[2])
        cs.setLineWidth(borderWidth)
        cs.addRect(borderWidth / 2, borderWidth / 2, w - borderWidth, h - borderWidth)
        cs.stroke()
      }
      cs.beginMarkedContent(TX)
      cs.saveGraphicsState()
      val pad = max(1f, borderWidth)
      val cx = pad
      val cy = pad
      val cw = max(1f, w - 2 * pad)
      val ch = max(1f, h - 2 * pad)
      cs.addRect(cx, cy, cw, ch)
      cs.clip()
      // Content area: one more point inside on each side (PdfBox's padding).
      val ix = cx + 1
      val iw = max(1f, cw - 2)
      val daSize = PdfPlan.daFontSize(da)
      if (comb) {
        drawComb(cs, value, (field as PDTextField).maxLen, cx, cy, cw, ch, daSize, rgb, text)
      } else if (multiline) {
        val size = if (daSize > 0f) daSize else 12f
        val lines = value.split("\n").flatMap { p ->
          PdfPlan.wrap(p, iw / size) { s -> text.width(s, standard = false) ?: s.length * 0.5f }
        }
        val laid = lines.map { text.layout(it, standard = false) }
        val top = cy + ch - 1
        if (laid.any { it == null }) {
          val bmp = text.rasterize(lines, iw, ch - 2, size, size * LEADING, size * ASCENT, rgb, q)
          text.drawImage(cs, bmp, ix, cy + 1, iw, ch - 2)
        } else {
          var y = top - size * ASCENT
          for (line in laid) {
            text.draw(cs, line!!, alignX(q, ix, iw, line.width * size), y, size, rgb)
            y -= size * LEADING
          }
        }
      } else {
        val single = value.replace("\r\n", " ").replace('\n', ' ').replace('\r', ' ')
        val line = text.layout(single, standard = false)
        val size = when {
          daSize > 0f -> daSize
          line == null -> min(12f, ch * 0.7f)
          else -> {
            val byHeight = ch / (CAP + 0.29f)
            val byWidth = if (line.width > 0f) iw / line.width else byHeight
            max(4f, min(12f, min(byHeight, byWidth)))
          }
        }
        // Baseline: the capitals centred in the box.
        val y = cy + (ch - size * CAP) / 2
        if (line == null) {
          val bmp = text.rasterize(listOf(single), iw, ch, size, size, ch - (y - cy), rgb, q)
          text.drawImage(cs, bmp, ix, cy, iw, ch)
        } else {
          text.draw(cs, line, alignX(q, ix, iw, line.width * size), y, size, rgb)
        }
      }
      cs.restoreGraphicsState()
      cs.endMarkedContent()
    }
    widget.appearance = PDAppearanceDictionary().apply { setNormalAppearance(ap) }
  }

  private fun alignX(q: Int, x: Float, w: Float, textWidth: Float): Float = when (q) {
    1 -> x + (w - textWidth) / 2
    2 -> x + w - textWidth
    else -> x
  }

  /** One character per cell, centred (comb fields). */
  private fun drawComb(cs: PDPageContentStream, value: String, maxLen: Int, x: Float, y: Float, w: Float, h: Float, daSize: Float, rgb: FloatArray, text: PdfText) {
    val cell = w / maxLen
    val visual = PdfText.visualOrder(value)
    val cells = PdfPlan.combCells(visual, maxLen)
    val size = if (daSize > 0f) daSize else max(4f, min(12f, min(h / 1.0f, cell * 1.2f)))
    val baseline = y + (h - size * CAP) / 2
    cells.forEachIndexed { i, c ->
      val line = text.layout(c, standard = false) ?: return@forEachIndexed
      val cxi = x + i * cell + (cell - line.width * size) / 2
      text.draw(cs, line, cxi, baseline, size, rgb)
    }
  }
}
