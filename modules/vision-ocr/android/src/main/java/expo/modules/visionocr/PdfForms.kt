package expo.modules.visionocr

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.Log
import com.tom_roush.pdfbox.cos.COSArray
import com.tom_roush.pdfbox.cos.COSDictionary
import com.tom_roush.pdfbox.cos.COSName
import com.tom_roush.pdfbox.cos.COSStream
import com.tom_roush.pdfbox.cos.COSString
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import com.tom_roush.pdfbox.pdmodel.PDPageContentStream
import com.tom_roush.pdfbox.pdmodel.PDResources
import com.tom_roush.pdfbox.pdmodel.common.PDRectangle
import com.tom_roush.pdfbox.pdmodel.graphics.color.PDColor
import com.tom_roush.pdfbox.pdmodel.graphics.form.PDFormXObject
import com.tom_roush.pdfbox.pdmodel.graphics.image.LosslessFactory
import com.tom_roush.pdfbox.pdmodel.graphics.image.PDImageXObject
import com.tom_roush.pdfbox.pdmodel.interactive.annotation.PDAnnotation
import com.tom_roush.pdfbox.pdmodel.interactive.annotation.PDAnnotationRubberStamp
import com.tom_roush.pdfbox.pdmodel.interactive.annotation.PDAnnotationWidget
import com.tom_roush.pdfbox.pdmodel.interactive.annotation.PDAppearanceDictionary
import com.tom_roush.pdfbox.pdmodel.interactive.annotation.PDAppearanceStream
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDAcroForm
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDCheckBox
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDChoice
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDComboBox
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDListBox
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDRadioButton
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDSignatureField
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDTerminalField
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDTextField
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDVariableText
import com.tom_roush.pdfbox.util.Matrix
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.IdentityHashMap
import java.util.UUID
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Fill & sign and Flatten on Android (port phase 4), the counterparts of
 * PdfFiller.swift and PdfFlattener.swift with the same contracts.
 *
 * Fill: form fields get their values with appearance streams written into the
 * file (PdfBox's own generator for text its standard fonts can show; Scan
 * Kit's for the rest, with a bundled Unicode font and Arabic shaping, see
 * PdfText), and additions (text, check, cross, signature, initials) become
 * Stamp annotations whose /AP /N Scan Kit draws itself, tagged /SKFill. The
 * page's own content is never touched. The written file is read back: every
 * field value and every addition with its appearance must be there, or
 * nothing is handed over. If an addition's appearance were missing, the fill
 * is done again with the additions drawn into the page content instead (the
 * burn-in fallback, as iOS).
 *
 * Flatten: every shown annotation except links (form widgets, signatures,
 * added text, stamps, notes) is drawn into its page from its appearance
 * stream, as vector content, and removed; links stay; the form is removed.
 */
object PdfForms {
  private const val TAG = "PdfForms"
  const val MARK_PREFIX = "scankit-fill-"
  private const val UNVERIFIED_FILL = "The filled PDF could not be verified"

  /** Debug builds (VisionOcr.pdfFillForceFallback): always burn the additions in. */
  @Volatile var forceBurn = false

  // ── The form, as Fill & sign sees it ─────────────────────────────────────

  /** Every widget of the form → its field (a field's widgets may be its kids). */
  fun widgetFields(form: PDAcroForm?): IdentityHashMap<COSDictionary, PDTerminalField> {
    val map = IdentityHashMap<COSDictionary, PDTerminalField>()
    form ?: return map
    var budget = 20000
    for (field in runCatching { form.fieldTree.toList() }.getOrDefault(emptyList())) {
      if (--budget < 0) break
      if (field !is PDTerminalField) continue
      for (w in runCatching { field.widgets }.getOrDefault(emptyList())) map[w.cosObject] = field
    }
    return map
  }

  fun kindOf(field: PDTerminalField): String? = when (field) {
    is PDTextField -> "text"
    is PDChoice -> "choice"
    is PDSignatureField -> "signature"
    is PDCheckBox -> "checkbox"
    is PDRadioButton -> "radio"
    else -> null // push buttons do nothing here
  }

  /** Shown on screen: not hidden, not "no view" (PDFKit's shouldDisplay). */
  fun isShown(a: COSDictionary): Boolean = a.getInt(COSName.F, 0) and (2 or 32) == 0

  /** A button widget's on-state name (its /AP /N key other than Off). */
  fun onState(widget: COSDictionary): String? {
    val n = ((widget.getDictionaryObject(COSName.AP) as? COSDictionary)?.getDictionaryObject(COSName.N)) as? COSDictionary
    n?.keySet()?.firstOrNull { it.name != "Off" }?.let { return it.name }
    val d = ((widget.getDictionaryObject(COSName.AP) as? COSDictionary)?.getDictionaryObject(COSName.D)) as? COSDictionary
    return d?.keySet()?.firstOrNull { it.name != "Off" }?.name
  }

  fun isOn(widget: COSDictionary): Boolean {
    val state = widget.getCOSName(COSName.AS) ?: return false
    return state.name != "Off"
  }

  /** [x, y, w, h] of an annotation's rectangle, normalised. */
  fun rectOf(a: COSDictionary): DoubleArray {
    val r = (a.getDictionaryObject(COSName.RECT) as? COSArray)?.toFloatArray() ?: floatArrayOf(0f, 0f, 0f, 0f)
    if (r.size < 4) return doubleArrayOf(0.0, 0.0, 0.0, 0.0)
    val x0 = min(r[0], r[2]).toDouble()
    val y0 = min(r[1], r[3]).toDouble()
    return doubleArrayOf(x0, y0, abs(r[2] - r[0]).toDouble(), abs(r[3] - r[1]).toDouble())
  }

  private fun boxArray(b: PDRectangle): List<Double> =
    listOf(b.lowerLeftX.toDouble(), b.lowerLeftY.toDouble(), b.width.toDouble(), b.height.toDouble())

  private fun da(widget: COSDictionary, field: PDTerminalField): String? =
    (widget.getDictionaryObject(COSName.DA) as? COSString)?.string ?: (field as? PDVariableText)?.defaultAppearance

  private fun annots(page: PDPage): COSArray? = page.cosObject.getDictionaryObject(COSName.ANNOTS) as? COSArray

  /** pdfFillInfo (PdfFiller.info). Throws "locked" for a PDF that needs a password. */
  fun fillInfo(context: Context, file: File): Map<String, Any?> {
    val doc = PdfDocs.openUnlocked(context, file)
    doc.use {
      val count = doc.numberOfPages
      if (count <= 0) throw PdfFail("The PDF has no pages")
      val form = runCatching { doc.documentCatalog.getAcroForm(null) }.getOrNull()
      val owners = widgetFields(form)
      val pages = ArrayList<Map<String, Any?>>()
      val fields = ArrayList<Map<String, Any?>>()
      doc.pages.forEachIndexed { i, page ->
        val crop = page.cropBox
        pages.add(mapOf("crop" to boxArray(crop), "media" to boxArray(page.mediaBox), "rotation" to PdfPlan.normalized(page.rotation)))
        val list = annots(page) ?: return@forEachIndexed
        for (k in 0 until list.size()) {
          val a = list.getObject(k) as? COSDictionary ?: continue
          if (a.getCOSName(COSName.SUBTYPE) != COSName.WIDGET || !isShown(a)) continue
          val field = owners[a] ?: continue
          val kind = kindOf(field) ?: continue
          val f = mutableMapOf<String, Any?>(
            "id" to "$i:$k",
            "page" to i,
            "name" to (field.fullyQualifiedName ?: ""),
            "kind" to kind,
            "rect" to rectOf(a).toList(),
            "readOnly" to field.isReadOnly,
            "fontSize" to PdfPlan.daFontSize(da(a, field)).toDouble(),
            "label" to (field.alternateFieldName ?: ""),
          )
          when (field) {
            is PDTextField -> {
              f["value"] = field.value ?: ""
              f["multiline"] = field.isMultiline
              f["maxLength"] = max(0, field.maxLen)
              f["comb"] = field.isComb
              f["align"] = when (field.q) { 1 -> "center"; 2 -> "right"; else -> "left" }
            }
            is PDChoice -> {
              val display = runCatching { field.optionsDisplayValues }.getOrDefault(emptyList())
              val export = runCatching { field.optionsExportValues }.getOrDefault(emptyList())
              val v = runCatching { field.value }.getOrDefault(emptyList()).firstOrNull() ?: ""
              val at = export.indexOf(v)
              f["value"] = if (at >= 0 && at < display.size) display[at] else v
              f["options"] = display
              f["list"] = field is PDListBox
            }
            is PDCheckBox, is PDRadioButton -> {
              f["on"] = isOn(a)
              f["onValue"] = onState(a) ?: ""
            }
          }
          fields.add(f)
        }
      }
      val allowed = PdfDocs.allowed(doc)
      val facts = PdfEngine.formFacts(doc)
      return mapOf(
        "pageCount" to count,
        "encrypted" to doc.isEncrypted,
        "canAnnotate" to (allowed and PdfPermissionBits.COMMENT != 0),
        "canFillForms" to (allowed and PdfPermissionBits.FILL_FORMS != 0),
        "pages" to pages,
        "fields" to fields,
        "signed" to facts.first,
        "certified" to facts.second,
        "xfa" to facts.third,
      )
    }
  }

  // ── pdfRenderPage ────────────────────────────────────────────────────────

  /**
   * The PDF with every form widget hidden (so the fill screen can draw the
   * fields itself), as bytes in memory for the pages that follow; other
   * annotations (earlier notes and signatures) still draw. Never a file: the
   * copy has its security removed, and for a session-unlocked PDF it is the
   * decrypted document, which must not outlive the session copy it came from
   * (lib/pdf-session.ts: nothing decrypted is persisted). Only the last
   * document is kept, and only while the app is in front ([dropPreview] runs
   * when it leaves); the cached entry also spares the full PdfBox parse each
   * page's lock check used to cost.
   */
  private class Preview(val key: String, val bytes: ByteArray?)

  @Volatile private var preview: Preview? = null

  private fun previewKey(file: File) = "${file.absolutePath}|${file.length()}|${file.lastModified()}"

  /** The lock check (and, with `hideFields`, the widget-less bytes) for `file`, cached for the next page. */
  @Synchronized
  private fun prepared(context: Context, file: File, hideFields: Boolean): Preview {
    val key = previewKey(file)
    val cached = preview
    if (cached != null && cached.key == key && (!hideFields || cached.bytes != null)) return cached
    // Locked or unreadable files are refused the way pdfFillInfo refuses them.
    val doc = PdfDocs.openUnlocked(context, file)
    val bytes = doc.use {
      if (!hideFields) return@use null
      for (page in doc.pages) {
        val list = annots(page) ?: continue
        for (k in 0 until list.size()) {
          val a = list.getObject(k) as? COSDictionary ?: continue
          if (a.getCOSName(COSName.SUBTYPE) == COSName.WIDGET) a.setInt(COSName.F, a.getInt(COSName.F, 0) or 2)
        }
      }
      doc.isAllSecurityToBeRemoved = true
      ByteArrayOutputStream().also { doc.save(it) }.toByteArray()
    }
    return Preview(key, bytes).also { preview = it }
  }

  /** Forgets the cached preview (VisionOcrModule calls it when the app leaves the foreground). */
  fun dropPreview() {
    preview = null
  }

  /** pdfRenderPage (PdfFiller.renderPage): page `index` as an upright JPEG q 0.88, long edge `maxEdge`, on white. */
  fun renderPage(context: Context, file: File, index: Int, out: File, maxEdge: Double, hideFields: Boolean): Map<String, Any> {
    val prepared = prepared(context, file, hideFields)
    val doc = try {
      val bytes = prepared.bytes
      if (hideFields && bytes != null) PdfEngine.openPdfium(context, bytes) else PdfEngine.openPdfium(context, file, null)
    } catch (e: PdfEngine.Locked) {
      throw PdfFail(PdfDocs.LOCKED)
    }
    doc.use {
      if (index < 0 || index >= doc.getPageCount()) throw PdfFail("No such page")
      val sizes = PdfEngine.pageSizes(doc)
      val w = sizes[2 * index]
      val h = sizes[2 * index + 1]
      if (w <= 0f || h <= 0f) throw PdfFail("Empty page")
      val scale = max(0.1, min(maxEdge, 4000.0) / max(w, h))
      val pw = max(1, (w * scale).roundToInt())
      val ph = max(1, (h * scale).roundToInt())
      val bmp = Bitmap.createBitmap(pw, ph, Bitmap.Config.ARGB_8888)
      try {
        PdfEngine.render(doc, index, bmp, 0, 0, pw, ph)
        ImageFiles.writeAtomically(out) { stream ->
          if (!bmp.compress(Bitmap.CompressFormat.JPEG, 88, stream)) throw PdfFail("Could not encode the page")
        }
      } finally {
        bmp.recycle()
      }
      return mapOf("uri" to ImageFiles.uriOf(out), "width" to pw, "height" to ph)
    }
  }

  // ── pdfFill ──────────────────────────────────────────────────────────────

  class Mark(
    val page: Int, val rect: FloatArray /* x y w h */, val kind: String, val text: String,
    val fontSize: Float, val color: FloatArray, val image: Bitmap?,
  )

  private fun num(v: Any?): Double? = (v as? Number)?.toDouble()

  private fun inkImage(base64: String, ink: FloatArray): Bitmap {
    val b64 = base64.substringAfter("base64,", base64)
    val bytes = try {
      Base64.decode(b64, Base64.DEFAULT)
    } catch (e: Throwable) {
      throw PdfFail("Bad signature image")
    }
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw PdfFail("Bad signature image")
    var sample = 1
    while (max(bounds.outWidth, bounds.outHeight) / sample > 3200) sample *= 2
    val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
      ?: throw PdfFail("Bad signature image")
    val long = max(decoded.width, decoded.height)
    val scaled = if (long > 1600) {
      val f = 1600.0 / long
      Bitmap.createScaledBitmap(decoded, max(1, (decoded.width * f).roundToInt()), max(1, (decoded.height * f).roundToInt()), true)
        .also { if (it !== decoded) decoded.recycle() }
    } else decoded
    val out = scaled.copy(Bitmap.Config.ARGB_8888, true)
    if (out !== scaled) scaled.recycle()
    // Recoloured to the ink, the shape kept by its alpha (PdfFiller.inkImage).
    val r = (ink[0] * 255).roundToInt()
    val g = (ink[1] * 255).roundToInt()
    val b = (ink[2] * 255).roundToInt()
    val row = IntArray(out.width)
    for (y in 0 until out.height) {
      out.getPixels(row, 0, out.width, 0, y, out.width, 1)
      for (x in row.indices) {
        val a = row[x] ushr 24
        row[x] = (a shl 24) or (r shl 16) or (g shl 8) or b
      }
      out.setPixels(row, 0, out.width, 0, y, out.width, 1)
    }
    return out
  }

  private fun parseMarks(list: List<Map<String, Any?>>, pageCount: Int): List<Mark> {
    val images = HashMap<String, Bitmap>()
    return list.map { m ->
      val page = num(m["page"])?.toInt()
      val r = (m["rect"] as? List<*>)?.map { num(it) }
      val kind = m["kind"] as? String
      if (page == null || page < 0 || page >= pageCount || r == null || r.size != 4 || r.any { it == null || !it.isFinite() } ||
        r[2]!! <= 0 || r[3]!! <= 0 || kind !in listOf("text", "check", "cross", "image")) {
        throw PdfFail("Bad addition")
      }
      val ink = PdfPlan.hexColor(m["color"] as? String)
      val text = (m["text"] as? String) ?: ""
      if (kind == "text" && text.isBlank()) throw PdfFail("Empty text")
      var image: Bitmap? = null
      if (kind == "image") {
        val src = (m["image"] as? String) ?: ""
        val key = "${m["color"] ?: ""}|$src"
        image = images.getOrPut(key) { inkImage(src, ink) }
      }
      val size = (num(m["fontSize"]) ?: 12.0).coerceIn(2.0, 400.0).toFloat()
      Mark(page, floatArrayOf(r[0]!!.toFloat(), r[1]!!.toFloat(), r[2]!!.toFloat(), r[3]!!.toFloat()), kind!!, text, size, ink, image)
    }
  }

  /** A widget expected after the write, found again by field name and place. */
  private class Expect(val page: Int, val name: String, val rect: DoubleArray, val kind: String, val value: String?, val on: Boolean?)

  /**
   * pdfFill (PdfFiller.fill). fields: [{ id: "page:index", name, kind,
   * value?, on? }]; marks: [{ page, rect [x, y, w, h], kind, text?, fontSize?,
   * color?, image? }]. Returns the page count.
   */
  fun fill(context: Context, input: File, output: File, fields: List<Map<String, Any?>>, marks: List<Map<String, Any?>>): Int {
    if (BuildConfig.DEBUG && forceBurn) return fillOnce(context, input, output, fields, marks, burn = true)
    return try {
      fillOnce(context, input, output, fields, marks, burn = false)
    } catch (e: AppearancesMissing) {
      Log.w(TAG, "appearances missing; burning the additions into the pages")
      fillOnce(context, input, output, fields, marks, burn = true)
    }
  }

  private class AppearancesMissing : Exception("appearances missing")

  private fun fillOnce(
    context: Context, input: File, output: File,
    fields: List<Map<String, Any?>>, rawMarks: List<Map<String, Any?>>, burn: Boolean,
  ): Int {
    val opened = PdfDocs.open(context, input, null)
    val doc = opened.doc
    val tmp = PdfDocs.tempNextTo(output, "fill")
    val count: Int
    val rotations: List<Int>
    val expects = ArrayList<Expect>()
    val expectedMarks = HashMap<Int, Int>()
    val burned = HashMap<Int, List<FloatArray>>()
    val runId = MARK_PREFIX + UUID.randomUUID().toString().take(8).lowercase()
    var source: Pair<Int, Int>? = null
    try {
      count = doc.numberOfPages
      if (count <= 0) throw PdfFail("The PDF has no pages")
      if (fields.isEmpty() && rawMarks.isEmpty()) throw PdfFail("Nothing to fill")
      val allowed = PdfDocs.allowed(doc)
      if (rawMarks.isNotEmpty() && allowed and PdfPermissionBits.COMMENT == 0) throw PdfFail(PdfDocs.RESTRICTED)
      if (fields.isNotEmpty() && allowed and PdfPermissionBits.FILL_FORMS == 0) throw PdfFail(PdfDocs.RESTRICTED)
      val marks = parseMarks(rawMarks, count)
      val pages = doc.pages.toList()
      rotations = pages.map { PdfPlan.normalized(it.rotation) }
      val text = PdfText(context, doc)

      if (fields.isNotEmpty()) fillFields(doc, pages, fields, text, expects)

      // Additions: annotations, or (burn) drawn into their pages.
      val placed = marks.map { m ->
        val media = pages[m.page].mediaBox
        val x0 = max(m.rect[0], media.lowerLeftX)
        val y0 = max(m.rect[1], media.lowerLeftY)
        val x1 = min(m.rect[0] + m.rect[2], media.upperRightX)
        val y1 = min(m.rect[1] + m.rect[3], media.upperRightY)
        if (x1 - x0 < 1f || y1 - y0 < 1f) throw PdfFail("Addition off the page")
        m to floatArrayOf(x0, y0, x1 - x0, y1 - y0)
      }
      val images = IdentityHashMap<Bitmap, PDImageXObject>()
      fun imageOf(b: Bitmap) = images.getOrPut(b) { LosslessFactory.createFromImage(doc, b) }
      if (burn) {
        for ((pageIndex, here) in placed.groupBy { it.first.page }) {
          val page = pages[pageIndex]
          PDPageContentStream(doc, page, PDPageContentStream.AppendMode.APPEND, true, true).use { cs ->
            for ((m, rect) in here) {
              cs.saveGraphicsState()
              cs.transform(Matrix(1f, 0f, 0f, 1f, rect[0], rect[1]))
              drawMark(cs, m, rect[2], rect[3], rotations[pageIndex], text, ::imageOf)
              cs.restoreGraphicsState()
            }
          }
          burned[pageIndex] = here.map { it.second }
        }
      } else {
        placed.forEachIndexed { n, (m, rect) ->
          val page = pages[m.page]
          val ap = PDAppearanceStream(doc)
          ap.bBox = PDRectangle(0f, 0f, rect[2], rect[3])
          ap.resources = PDResources()
          PDPageContentStream(doc, ap).use { cs -> drawMark(cs, m, rect[2], rect[3], rotations[m.page], text, ::imageOf) }
          val stamp = PDAnnotationRubberStamp()
          stamp.rectangle = PDRectangle(rect[0], rect[1], rect[2], rect[3])
          stamp.appearance = PDAppearanceDictionary().apply { setNormalAppearance(ap) }
          stamp.isPrinted = true
          stamp.cosObject.setString(PdfEngine.MARK_KEY, "$runId-$n")
          // The text, for search and screen readers (pdfPageTexts).
          if (m.kind == "text") stamp.contents = m.text
          stamp.page = page
          val list = page.annotations
          list.add(stamp)
          page.annotations = list
          expectedMarks[m.page] = (expectedMarks[m.page] ?: 0) + 1
        }
      }
      marks.mapNotNull { it.image }.distinct().forEach { it.recycle() }
      source = PdfDocs.keepProtection(opened)
      doc.save(tmp)
    } catch (e: PdfFail) {
      tmp.delete()
      throw e
    } catch (e: Throwable) {
      tmp.delete()
      Log.w(TAG, "fill failed", e)
      throw PdfFail("Could not write the PDF")
    } finally {
      PdfDocs.closeQuietly(doc)
    }
    return PdfDocs.cleaningUp(tmp) {
      verifyFill(context, input, tmp, count, rotations, source, expects, expectedMarks, burned, runId)
      PdfDocs.accept(tmp, output)
      count
    }
  }

  /** Sets the fields' values (each checked against what pdfFillInfo said); records what to read back. */
  private fun fillFields(doc: PDDocument, pages: List<PDPage>, fields: List<Map<String, Any?>>, text: PdfText, expects: MutableList<Expect>) {
    val form = runCatching { doc.documentCatalog.getAcroForm(null) }.getOrNull() ?: throw PdfFail(PdfDocs.CHANGED)
    val owners = widgetFields(form)
    // Every widget of the document with its page.
    val widgets = ArrayList<Pair<COSDictionary, Int>>()
    pages.forEachIndexed { i, page ->
      val list = annots(page) ?: return@forEachIndexed
      for (k in 0 until list.size()) {
        val a = list.getObject(k) as? COSDictionary ?: continue
        if (a.getCOSName(COSName.SUBTYPE) == COSName.WIDGET) widgets.add(a to i)
      }
    }
    val hadNeed = form.needAppearances
    // Appearances are built now (PdfBox skips them while the flag is on).
    form.needAppearances = false
    val textValues = HashMap<String, String>()
    val buttons = ArrayList<Triple<PDTerminalField, String, Boolean>>() // field, on-state, on
    val radioGroupsOn = HashSet<String>()
    for (f in fields) {
      val id = f["id"] as? String
      val name = f["name"] as? String
      val kind = f["kind"] as? String
      if (id == null || name == null || kind == null) throw PdfFail(PdfDocs.CHANGED)
      val parts = id.split(":").mapNotNull { it.toIntOrNull() }
      if (parts.size != 2 || parts[0] !in pages.indices) throw PdfFail(PdfDocs.CHANGED)
      val list = annots(pages[parts[0]]) ?: throw PdfFail(PdfDocs.CHANGED)
      if (parts[1] < 0 || parts[1] >= list.size()) throw PdfFail(PdfDocs.CHANGED)
      val a = list.getObject(parts[1]) as? COSDictionary ?: throw PdfFail(PdfDocs.CHANGED)
      val field = owners[a]
      if (a.getCOSName(COSName.SUBTYPE) != COSName.WIDGET || field == null || (field.fullyQualifiedName ?: "") != name ||
        kindOf(field) != kind || field.isReadOnly) {
        throw PdfFail(PdfDocs.CHANGED)
      }
      when (kind) {
        "text", "choice" -> {
          val value = (f["value"] as? String) ?: ""
          // One field, one value: two different values for it can't both be kept.
          if (name.isNotEmpty() && textValues[name]?.let { it != value } == true) throw PdfFail("Two values for one field")
          // Every field of that name (the same field shown on several pages: its widgets).
          val targets = if (name.isEmpty()) listOf(field) else owners.values.filter {
            (it.fullyQualifiedName ?: "") == name && kindOf(it) == kind && !it.isReadOnly
          }.distinct()
          for (t in targets) {
            setTextValue(doc, t as PDVariableText, value, text)
            for (w in t.widgets) {
              val page = widgets.firstOrNull { it.first === w.cosObject }?.second ?: continue
              expects.add(Expect(page, name, rectOf(w.cosObject), kind, value, null))
            }
          }
          if (name.isNotEmpty()) textValues[name] = value
        }
        "checkbox", "radio" -> {
          val on = (f["on"] as? Boolean) ?: false
          val state = onState(a) ?: throw PdfFail(PdfDocs.CHANGED)
          buttons.add(Triple(field, state, on))
          if (kind == "radio" && on) radioGroupsOn.add(name)
          // Every widget of the field with that on-state shows it (same-name checkboxes).
          for (w in field.widgets) {
            val page = widgets.firstOrNull { it.first === w.cosObject }?.second ?: continue
            val wState = onState(w.cosObject)
            if (kind == "checkbox" && wState != state) continue
            if (kind == "radio" && w.cosObject !== a) continue
            expects.add(Expect(page, name, rectOf(w.cosObject), kind, null, on))
          }
        }
        else -> throw PdfFail(PdfDocs.CHANGED)
      }
    }
    // Buttons: offs before ons (a group shares one value: the one turned on
    // is set last); a radio group with a chosen button is never turned off.
    for ((field, state, on) in buttons.filter { !it.third } + buttons.filter { it.third }) {
      val isRadio = field is PDRadioButton
      if (on) setButton(field, state)
      else if (!isRadio || (field.fullyQualifiedName ?: "") !in radioGroupsOn) setButton(field, "Off")
    }
    // A radio button turned off whose group has a chosen one isn't expected off.
    expects.removeAll { it.kind == "radio" && it.on == false && it.name in radioGroupsOn }
    // /NeedAppearances settled: off when every widget can be drawn as written.
    if (hadNeed) {
      for (t in owners.values.distinct()) {
        if (t.widgets.any { isShown(it.cosObject) && !PdfDocs.hasNormalAppearance(it.cosObject) }) {
          try { form.refreshAppearances(listOf(t)) } catch (e: Throwable) { Log.w(TAG, "no appearance for ${t.fullyQualifiedName}") }
        }
      }
      form.needAppearances = !PdfDocs.everyWidgetHasAppearance(doc)
    }
  }

  /** /V = state, and each widget shows it if it has that state, else Off (PDButton.updateByValue, without /Opt indirection). */
  private fun setButton(field: PDTerminalField, state: String) {
    val name = COSName.getPDFName(state)
    field.cosObject.setItem(COSName.V, name)
    for (w in field.widgets) {
      val states = ((w.cosObject.getDictionaryObject(COSName.AP) as? COSDictionary)?.getDictionaryObject(COSName.N)) as? COSDictionary
      w.cosObject.setItem(COSName.AS, if (states?.containsKey(name) == true) name else COSName.Off)
    }
  }

  /**
   * A text or choice field's value with its appearance: PdfBox draws it when
   * the form's own font can show it; otherwise (other scripts, right-to-left)
   * Scan Kit draws it with a bundled font (PdfText).
   */
  private fun setTextValue(doc: PDDocument, field: PDVariableText, value: String, text: PdfText) {
    var display = value
    var export = value
    if (field is PDChoice) {
      val displays = runCatching { field.optionsDisplayValues }.getOrDefault(emptyList())
      val exports = runCatching { field.optionsExportValues }.getOrDefault(emptyList())
      val at = displays.indexOf(value)
      if (at >= 0 && at < exports.size) export = exports[at] else if (exports.contains(value)) display = displays.getOrNull(exports.indexOf(value)) ?: value
    }
    val custom = PdfPlan.hasRtl(display) || !text.standardCan(display)
    if (!custom) {
      try {
        if (field is PDChoice) field.setValue(export) else field.setValue(value)
        if (field.widgets.all { PdfDocs.hasNormalAppearance(it.cosObject) || !isShown(it.cosObject) }) return
      } catch (e: Throwable) {
        Log.i(TAG, "PdfBox appearance failed for ${field.fullyQualifiedName}: ${e.message}")
      }
    }
    // The value as typed (logical order), and Scan Kit's own appearance.
    if (field is PDChoice) {
      if (field.isMultiSelect) {
        field.cosObject.setItem(COSName.V, COSArray().apply { add(COSString(export)) })
      } else {
        field.cosObject.setString(COSName.V, export)
      }
      val exports = runCatching { field.optionsExportValues }.getOrDefault(emptyList())
      val at = exports.indexOf(export)
      if (at >= 0) field.cosObject.setItem(COSName.I, COSArray().apply { add(com.tom_roush.pdfbox.cos.COSInteger.get(at.toLong())) })
    } else {
      field.cosObject.setString(COSName.V, value)
    }
    for (w in field.widgets) FieldAppearance.build(doc, field, w, display, text)
  }

  /**
   * Draws a mark in a box of `bw` × `bh` (origin at 0, 0), turned against the
   * page's rotation so it reads upright (FillMark.draw).
   */
  private fun drawMark(cs: PDPageContentStream, m: Mark, bw: Float, bh: Float, rotation: Int, text: PdfText, image: (Bitmap) -> PDImageXObject) {
    val turned = rotation % 180 != 0
    val w = if (turned) bh else bw
    val h = if (turned) bw else bh
    cs.saveGraphicsState()
    cs.transform(Matrix.getRotateInstance(Math.toRadians(rotation.toDouble()), bw / 2, bh / 2))
    val x0 = -w / 2
    val y0 = -h / 2
    when (m.kind) {
      "text" -> drawText(cs, m, x0, y0, w, h, text)
      "check", "cross" -> {
        val s = min(w, h)
        cs.setStrokingColor(m.color[0], m.color[1], m.color[2])
        cs.setLineWidth(max(0.5f, s * 0.13f))
        cs.setLineCapStyle(1)
        cs.setLineJoinStyle(1)
        fun p(x: Float, y: Float) = (x0 + x * w) to (y0 + y * h)
        if (m.kind == "check") {
          val (ax, ay) = p(0.16f, 0.52f)
          val (bx, by) = p(0.40f, 0.24f)
          val (cx, cy) = p(0.86f, 0.80f)
          cs.moveTo(ax, ay); cs.lineTo(bx, by); cs.lineTo(cx, cy)
        } else {
          val (ax, ay) = p(0.2f, 0.2f)
          val (bx, by) = p(0.8f, 0.8f)
          val (cx, cy) = p(0.2f, 0.8f)
          val (dx, dy) = p(0.8f, 0.2f)
          cs.moveTo(ax, ay); cs.lineTo(bx, by); cs.moveTo(cx, cy); cs.lineTo(dx, dy)
        }
        cs.stroke()
      }
      "image" -> m.image?.let { cs.drawImage(image(it), x0, y0, w, h) }
    }
    cs.restoreGraphicsState()
  }

  /** Helvetica metrics as iOS's CoreText reports them: ascent 0.77, descent 0.23 (line height = size). */
  private const val ASCENT = 0.77f
  private const val DESCENT = 0.23f

  private fun drawText(cs: PDPageContentStream, m: Mark, x0: Float, y0: Float, w: Float, h: Float, text: PdfText) {
    val lines = m.text.split("\n")
    val size = m.fontSize
    val laid = lines.map { text.layout(it, standard = true) }
    if (laid.any { it == null }) {
      // A script without a bundled font: Android draws it, placed as an image.
      val bmp = text.rasterize(lines, w, h, size, size * (ASCENT + DESCENT), size * ASCENT, m.color, 0)
      text.drawImage(cs, bmp, x0, y0, w, h)
      return
    }
    var y = y0 + h - size * ASCENT
    for (line in laid) {
      text.draw(cs, line!!, x0, y, size, m.color)
      y -= size * (ASCENT + DESCENT)
    }
  }

  /** Read back a fill: pages and turns, permissions, field values with appearances, every addition. */
  private fun verifyFill(
    context: Context, input: File, written: File, count: Int, rotations: List<Int>, source: Pair<Int, Int>?,
    expects: List<Expect>, expectedMarks: Map<Int, Int>, burned: Map<Int, List<FloatArray>>, runId: String,
  ) {
    var missingAppearance = false
    fun refuse(why: String): Nothing {
      Log.w(TAG, "fill not verified: $why")
      throw PdfFail(UNVERIFIED_FILL)
    }
    val check = PdfDocs.reload(context, written) ?: refuse("unreadable")
    check.use {
      if (check.numberOfPages != count) refuse("pages")
      PdfDocs.widened(source, check)?.let { refuse("permissions: $it") }
      val pages = check.pages.toList()
      for (i in 0 until count) if (PdfPlan.normalized(pages[i].rotation) != rotations[i]) refuse("rotation")
      val owners = widgetFields(runCatching { check.documentCatalog.getAcroForm(null) }.getOrNull())
      for (e in expects) {
        val list = annots(pages[e.page]) ?: refuse("field page")
        var found: Pair<COSDictionary, PDTerminalField>? = null
        for (k in 0 until list.size()) {
          val a = list.getObject(k) as? COSDictionary ?: continue
          val f = owners[a] ?: continue
          if ((f.fullyQualifiedName ?: "") != e.name || kindOf(f) != e.kind) continue
          val r = rectOf(a)
          if ((0 until 4).all { abs(r[it] - e.rect[it]) < 0.01 }) { found = a to f; break }
        }
        val (w, f) = found ?: refuse("field ${e.name}")
        if (e.value != null) {
          val now = when (f) {
            is PDTextField -> f.value ?: ""
            is PDChoice -> {
              val v = f.value.firstOrNull() ?: ""
              val at = f.optionsExportValues.indexOf(v)
              if (at >= 0 && at < f.optionsDisplayValues.size) f.optionsDisplayValues[at] else v
            }
            else -> ""
          }
          if (now != e.value) refuse("value of ${e.name}")
          if (isShown(w) && !PdfDocs.hasNormalAppearance(w)) refuse("appearance of ${e.name}")
        }
        if (e.on != null && isOn(w) != e.on) refuse("state of ${e.name}")
      }
      for ((page, n) in expectedMarks) {
        if (appearancesWritten(pages[page], runId) != n) {
          missingAppearance = true
        }
      }
    }
    if (missingAppearance) {
      Log.w(TAG, "fill not verified: additions' appearances")
      throw AppearancesMissing()
    }
    if (burned.isNotEmpty()) {
      // Each burned page looks different where something was added.
      val before = PdfDocs.looks(context, input, null, annotations = false)
      val after = PdfDocs.looks(context, written, null, annotations = false)
      for ((page, _) in burned) {
        if (count > 24) break // looks are a sample of the pages; trust the content stream then
        val a = before.getOrNull(page) ?: refuse("look")
        val b = after.getOrNull(page) ?: refuse("look")
        if (a.indices.none { abs(a[it] - b[it]) > 24 }) refuse("burned addition on page ${page + 1}")
      }
    }
  }

  /** Annotations on the page tagged `prefix…` with a non-empty normal appearance stream. */
  private fun appearancesWritten(page: PDPage, prefix: String): Int {
    val list = annots(page) ?: return 0
    var found = 0
    for (k in 0 until list.size()) {
      val a = list.getObject(k) as? COSDictionary ?: continue
      val tag = (a.getDictionaryObject(PdfEngine.MARK_KEY) as? COSString)?.string ?: continue
      if (!tag.startsWith(prefix)) continue
      val n = ((a.getDictionaryObject(COSName.AP) as? COSDictionary)?.getDictionaryObject(COSName.N)) as? COSStream ?: continue
      val bytes = try { n.createInputStream().use { it.readBytes() } } catch (e: Throwable) { null } ?: continue
      if (bytes.size > 8) found++
    }
    return found
  }

  // ── pdfFlatten (PdfFlattener.flatten) ────────────────────────────────────

  /** Drawn into the page by Flatten: everything shown except links and pop-ups. */
  private fun flattens(a: COSDictionary): Boolean {
    val sub = a.getCOSName(COSName.SUBTYPE)?.name
    return sub != "Link" && sub != "Popup" && isShown(a)
  }

  /** The appearance stream an annotation shows now (its /AS state for widgets). */
  private fun normalAppearance(a: COSDictionary): COSStream? {
    val n = (a.getDictionaryObject(COSName.AP) as? COSDictionary)?.getDictionaryObject(COSName.N) ?: return null
    if (n is COSStream) return n
    val state = a.getCOSName(COSName.AS) ?: return null
    return (n as? COSDictionary)?.getDictionaryObject(state) as? COSStream
  }

  /**
   * Writes a flattened copy and reads it back; returns the page count. An
   * encrypted PDF keeps its exact permissions and is refused ("restricted")
   * when they don't allow both commenting and filling in its form.
   */
  fun flatten(context: Context, input: File, output: File): Int {
    val opened = PdfDocs.open(context, input, null)
    val doc = opened.doc
    val tmp = PdfDocs.tempNextTo(output, "flatten")
    val count: Int
    val rotations = ArrayList<Int>()
    val links = ArrayList<Int>()
    var source: Pair<Int, Int>? = null
    try {
      if (doc.isEncrypted) {
        val allowed = PdfDocs.allowed(doc)
        if (allowed and PdfPermissionBits.COMMENT == 0 || allowed and PdfPermissionBits.FILL_FORMS == 0) throw PdfFail(PdfDocs.RESTRICTED)
      }
      count = doc.numberOfPages
      if (count <= 0) throw PdfFail("The PDF has no pages")
      val formDict = PdfDocs.acroFormDict(doc)
      val form = runCatching { doc.documentCatalog.getAcroForm(null) }.getOrNull()
      // Fields with no appearance yet (a form that asked readers to draw them) get one first.
      if (form != null) {
        for (t in widgetFields(form).values.distinct()) {
          if (t.widgets.any { isShown(it.cosObject) && !PdfDocs.hasNormalAppearance(it.cosObject) }) {
            try { form.refreshAppearances(listOf(t)) } catch (e: Throwable) { Log.w(TAG, "no appearance for ${t.fullyQualifiedName}") }
          }
        }
      }
      val dr = formDict?.getDictionaryObject(COSName.DR) as? COSDictionary
      for (page in doc.pages) {
        rotations.add(PdfPlan.normalized(page.rotation))
        val list = annots(page)
        val all = (0 until (list?.size() ?: 0)).mapNotNull { list!!.getObject(it) as? COSDictionary }
        val keep = all.filter { it.getCOSName(COSName.SUBTYPE)?.name == "Link" }
        links.add(keep.size)
        val burn = all.filter(::flattens)
        if (burn.isNotEmpty()) {
          PDPageContentStream(doc, page, PDPageContentStream.AppendMode.APPEND, true, true).use { cs ->
            for (a in burn) drawAppearance(doc, cs, a, dr)
          }
        }
        if (list != null && all.size != keep.size) {
          val kept = COSArray()
          keep.forEach { kept.add(it) }
          page.cosObject.setItem(COSName.ANNOTS, kept)
        }
      }
      // No widget is left: the form goes too.
      doc.documentCatalog.cosObject.removeItem(COSName.ACRO_FORM)
      source = PdfDocs.keepProtection(opened)
      doc.save(tmp)
    } catch (e: PdfFail) {
      tmp.delete()
      throw e
    } catch (e: Throwable) {
      tmp.delete()
      Log.w(TAG, "flatten failed", e)
      throw PdfFail("Could not write the PDF")
    } finally {
      PdfDocs.closeQuietly(doc)
    }
    return PdfDocs.cleaningUp(tmp) {
      fun refuse(why: String): Nothing {
        Log.w(TAG, "flatten not verified: $why")
        throw PdfFail("The flattened PDF could not be verified")
      }
      val check = PdfDocs.reload(context, tmp) ?: refuse("unreadable")
      check.use {
        if (check.numberOfPages != count) refuse("pages")
        PdfDocs.widened(source, check)?.let { refuse(it) }
        check.pages.forEachIndexed { i, p ->
          if (PdfPlan.normalized(p.rotation) != rotations[i]) refuse("rotation")
          val list = annots(p)
          val all = (0 until (list?.size() ?: 0)).mapNotNull { list!!.getObject(it) as? COSDictionary }
          // Nothing left to edit or move; links still there.
          if (all.any { it.getCOSName(COSName.SUBTYPE)?.name != "Link" }) refuse("annotations on page ${i + 1}")
          if (all.size != links[i]) refuse("links on page ${i + 1}")
        }
        if (PdfDocs.acroFormDict(check) != null) refuse("form")
      }
      // The text is still text.
      val before = PdfDocs.texts(context, input, null)
      val after = PdfDocs.texts(context, tmp, null)
      if (before.size != after.size) refuse("pdfium pages")
      for (i in before.indices) if (after[i].length < before[i].length / 2) refuse("text on page ${i + 1}")
      PdfDocs.accept(tmp, output)
      count
    }
  }

  /**
   * Draws an annotation's normal appearance into the page content where the
   * annotation is (ISO 32000-1 §12.5.5): the form's BBox through its /Matrix,
   * fitted to the annotation's Rect. A widget appearance that relies on the
   * form's /DR for its fonts gets them in its own resources first.
   */
  private fun drawAppearance(doc: PDDocument, cs: PDPageContentStream, a: COSDictionary, dr: COSDictionary?) {
    var stream = normalAppearance(a)
    if (stream == null && a.getCOSName(COSName.SUBTYPE) != COSName.WIDGET) {
      // Notes and markup without an appearance: PdfBox draws a standard one.
      try {
        val annotation = PDAnnotation.createAnnotation(a)
        annotation.constructAppearances(doc)
        stream = normalAppearance(a)
      } catch (e: Throwable) {
        Log.i(TAG, "no appearance for a ${a.getCOSName(COSName.SUBTYPE)?.name}")
      }
    }
    stream ?: return
    val form = PDFormXObject(stream)
    val bbox = form.bBox ?: return
    val m = form.matrix
    val rect = (a.getDictionaryObject(COSName.RECT) as? COSArray)?.toFloatArray() ?: return
    if (rect.size < 4) return
    val t = PdfPlan.appearanceTransform(
      floatArrayOf(bbox.lowerLeftX, bbox.lowerLeftY, bbox.upperRightX, bbox.upperRightY),
      floatArrayOf(m.scaleX, m.shearY, m.shearX, m.scaleY, m.translateX, m.translateY),
      rect,
    ) ?: return
    if (a.getCOSName(COSName.SUBTYPE) == COSName.WIDGET && dr != null) mergeResources(stream, dr)
    cs.saveGraphicsState()
    cs.transform(Matrix(t[0], t[1], t[2], t[3], t[4], t[5]))
    cs.drawForm(form)
    cs.restoreGraphicsState()
  }

  /** Adds the /DR fonts an appearance stream doesn't have itself. */
  private fun mergeResources(stream: COSStream, dr: COSDictionary) {
    val drFonts = dr.getDictionaryObject(COSName.FONT) as? COSDictionary ?: return
    val res = (stream.getDictionaryObject(COSName.RESOURCES) as? COSDictionary) ?: COSDictionary().also { stream.setItem(COSName.RESOURCES, it) }
    val fonts = (res.getDictionaryObject(COSName.FONT) as? COSDictionary) ?: COSDictionary().also { res.setItem(COSName.FONT, it) }
    for (key in drFonts.keySet()) if (!fonts.containsKey(key)) fonts.setItem(key, drFonts.getItem(key))
  }

  /** A /MK colour (grey, RGB or CMYK) as RGB 0..1, or null (FieldAppearance). */
  internal fun rgbOf(c: PDColor?): FloatArray? {
    val v = c?.components ?: return null
    return when (v.size) {
      1 -> floatArrayOf(v[0], v[0], v[0])
      3 -> floatArrayOf(v[0], v[1], v[2])
      4 -> floatArrayOf((1 - v[0]) * (1 - v[3]), (1 - v[1]) * (1 - v[3]), (1 - v[2]) * (1 - v[3]))
      else -> null
    }
  }
}
