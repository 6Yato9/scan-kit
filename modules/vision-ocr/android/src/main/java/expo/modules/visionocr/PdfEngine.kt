package expo.modules.visionocr

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.os.ParcelFileDescriptor
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.cos.COSDictionary
import com.tom_roush.pdfbox.cos.COSName
import com.tom_roush.pdfbox.cos.COSString
import com.tom_roush.pdfbox.io.MemoryUsageSetting
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.encryption.InvalidPasswordException
import com.tom_roush.pdfbox.pdmodel.encryption.StandardSecurityHandler
import com.tom_roush.pdfbox.pdmodel.interactive.annotation.PDAnnotationWidget
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDChoice
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDField
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDSignatureField
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDTextField
import io.legere.pdfiumandroid.PdfDocument
import io.legere.pdfiumandroid.PdfPasswordException
import io.legere.pdfiumandroid.PdfiumCore
import java.io.File
import java.io.IOException
import java.util.UUID
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * PDF reading on Android (port phase 3), the counterpart of PdfTools.swift,
 * PdfRasterizer.swift, PdfEditor.info and PdfUnrestrict.info:
 *
 * - PDFium (PdfiumAndroidKt) draws pages: the viewer, renderPdfPages and
 *   page text. It renders annotations and form fields, and opens encrypted
 *   files with their password.
 * - PdfBox-Android reads structure: passwords and which one opened the file,
 *   permissions, form facts, form values, and writes the decrypted copy a
 *   session reads (unlockPdf).
 *
 * Rejection messages are the ones JS matches (`locked`, `wrong-password`,
 * "Could not open the PDF", "This PDF is password protected", "The PDF has
 * no pages").
 */
object PdfEngine {
  private const val WHITE = Color.WHITE
  /** Key of Scan Kit's Fill & sign marks (PdfFiller.swift markKey). */
  internal val MARK_KEY: COSName = COSName.getPDFName("SKFill")

  @Volatile private var core: PdfiumCore? = null
  @Volatile private var pdfBoxReady = false

  fun pdfium(context: Context): PdfiumCore =
    core ?: synchronized(this) { core ?: PdfiumCore(context.applicationContext).also { core = it } }

  internal fun pdfBox(context: Context) {
    if (pdfBoxReady) return
    synchronized(this) {
      if (!pdfBoxReady) {
        PDFBoxResourceLoader.init(context.applicationContext)
        pdfBoxReady = true
      }
    }
  }

  // ── PDFium ────────────────────────────────────────────────────────────────

  /** Thrown when a password is needed (none given, or it didn't open the file). */
  class Locked : IOException("locked")

  /** Opens `file` with PDFium; throws [Locked] for a password-protected file it can't open. */
  fun openPdfium(context: Context, file: File, password: String?): PdfDocument {
    if (!file.exists()) throw IOException("Could not open the PDF")
    val fd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    try {
      return pdfium(context).newDocument(fd, password?.takeIf { it.isNotEmpty() })
    } catch (e: PdfPasswordException) {
      runCatching { fd.close() }
      throw Locked()
    } catch (e: Exception) {
      runCatching { fd.close() }
      throw IOException("Could not open the PDF")
    }
  }

  /** Opens a PDF held in memory (no password: callers pass unprotected bytes). */
  fun openPdfium(context: Context, bytes: ByteArray): PdfDocument = try {
    pdfium(context).newDocument(bytes, null)
  } catch (e: PdfPasswordException) {
    throw Locked()
  } catch (e: Exception) {
    throw IOException("Could not open the PDF")
  }

  /** Page sizes in points as displayed (rotation applied): w0, h0, w1, h1, … */
  fun pageSizes(doc: PdfDocument): FloatArray {
    val n = doc.getPageCount()
    val out = FloatArray(n * 2)
    for (i in 0 until n) {
      doc.openPage(i).use { page ->
        out[2 * i] = max(1, page.getPageWidthPoint()).toFloat()
        out[2 * i + 1] = max(1, page.getPageHeightPoint()).toFloat()
      }
    }
    return out
  }

  /**
   * Draws page `index` scaled to sizeX × sizeY with its top-left at
   * (startX, startY) of `bitmap` (negative to draw a part of the page), with
   * annotations and form fields, on white.
   */
  fun render(doc: PdfDocument, index: Int, bitmap: Bitmap, startX: Int, startY: Int, sizeX: Int, sizeY: Int) {
    bitmap.eraseColor(WHITE)
    doc.openPage(index).use { page ->
      page.renderPageBitmap(bitmap, startX, startY, sizeX, sizeY, true, false, WHITE, WHITE)
    }
  }

  /**
   * renderPdfPages: every page as a JPEG `pdfpage-%03d.jpg` in `outDir`,
   * ~200 dpi capped at `maxEdge` on the long side, white background, crop
   * box and /Rotate as displayed (PdfRasterizer.swift).
   */
  fun renderPages(context: Context, input: File, outDir: File, maxEdge: Double, quality: Int = 90): List<String> {
    val doc = try {
      openPdfium(context, input, null)
    } catch (e: Locked) {
      throw VisionFailure("ERR_PDF_RENDER", "This PDF is password protected")
    } catch (e: IOException) {
      throw VisionFailure("ERR_PDF_RENDER", "Could not open the PDF")
    }
    doc.use {
      val n = doc.getPageCount()
      if (n <= 0) throw VisionFailure("ERR_PDF_RENDER", "The PDF has no pages")
      outDir.mkdirs()
      val sizes = pageSizes(doc)
      val out = ArrayList<String>(n)
      var bitmap: Bitmap? = null
      try {
        for (i in 0 until n) {
          val (w, h) = rasterSize(sizes[2 * i], sizes[2 * i + 1], maxEdge)
          val bmp = bitmap?.takeIf { it.width == w && it.height == h }
            ?: Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also { bitmap?.recycle(); bitmap = it }
          render(doc, i, bmp, 0, 0, w, h)
          val file = File(outDir, String.format(java.util.Locale.US, "pdfpage-%03d.jpg", i))
          ImageFiles.writeAtomically(file) { stream ->
            if (!bmp.compress(Bitmap.CompressFormat.JPEG, quality, stream)) {
              throw VisionFailure("ERR_PDF_RENDER", "Could not encode page ${i + 1}")
            }
          }
          out.add(ImageFiles.uriOf(file))
        }
      } finally {
        bitmap?.recycle()
      }
      return out
    }
  }

  /** Pixel size of a page rendered at ~200 dpi, the long side capped at `maxEdge` (pure). */
  fun rasterSize(widthPt: Float, heightPt: Float, maxEdge: Double): Pair<Int, Int> {
    val longSide = max(widthPt, heightPt).toDouble()
    val scale = min(200.0 / 72.0, max(1.0, maxEdge) / longSide)
    return max(1, (widthPt * scale).roundToInt()) to max(1, (heightPt * scale).roundToInt())
  }

  /**
   * pdfPageTexts: each page's text (PDFium), plus what was filled in, which
   * lives in annotations rather than the page: text and choice field values
   * and Scan Kit's Fill & sign text marks (PdfTools.pageTexts).
   */
  fun pageTexts(context: Context, file: File, password: String?): List<String> {
    val doc = try {
      openPdfium(context, file, password)
    } catch (e: Locked) {
      throw VisionFailure("ERR_PDF_TEXT", "locked")
    } catch (e: IOException) {
      throw VisionFailure("ERR_PDF_TEXT", "Could not open the PDF")
    }
    val texts = doc.use {
      (0 until doc.getPageCount()).map { i ->
        doc.openPage(i).use { page ->
          page.openTextPage().use { tp ->
            val n = tp.textPageCountChars()
            if (n <= 0) "" else cleanText(tp.textPageGetText(0, n) ?: "")
          }
        }
      }
    }
    val extras = try { filledTexts(context, file, password, texts.size) } catch (e: Throwable) { null }
    return texts.mapIndexed { i, text ->
      val extra = extras?.getOrNull(i).orEmpty()
      if (extra.isEmpty()) text else (listOf(text) + extra).filter { it.isNotEmpty() }.joinToString("\n")
    }
  }

  /** PDFium's text: CRLF line breaks, soft-hyphen markers and NULs (pure). */
  fun cleanText(raw: String): String {
    val s = raw.replace("\r\n", "\n").replace('\r', '\n')
    val b = StringBuilder(s.length)
    for (c in s) {
      when {
        c == '\n' || c == '\t' -> b.append(c)
        c == '\u0002' -> b.append('-') // a hyphen PDFium marks as generated at a line end
        c.code < 0x20 || c == '￾' || c == '￿' -> {}
        else -> b.append(c)
      }
    }
    return b.toString().trimEnd()
  }

  // ── PdfBox ────────────────────────────────────────────────────────────────

  internal fun memory(context: Context): MemoryUsageSetting {
    val dir = File(context.cacheDir, "pdfbox-tmp").apply { mkdirs() }
    return MemoryUsageSetting.setupMixed(48L * 1024 * 1024).setTempDir(dir)
  }

  /** Loads with `password` ("" = none); null when the password doesn't open it. */
  internal fun loadBox(context: Context, file: File, password: String): PDDocument? {
    pdfBox(context)
    if (!file.exists()) throw IOException("Could not open the PDF")
    return try {
      PDDocument.load(file, password, memory(context))
    } catch (e: InvalidPasswordException) {
      null
    }
  }

  /** What an opened document's permissions allow, as PDFAccessPermissions bits. */
  private fun accessBits(doc: PDDocument): Int {
    if (!doc.isEncrypted) return PdfPermissionBits.ALL
    if (doc.currentAccessPermission.isOwnerPermission) return PdfPermissionBits.ALL
    val enc = doc.encryption ?: return PdfPermissionBits.ALL
    return PdfPermissionBits.fromP(enc.permissions, enc.revision)
  }

  /** The author's exact permissions (the file's /P), whoever opened it. */
  private fun authorBits(doc: PDDocument): Int {
    val enc = doc.encryption ?: return PdfPermissionBits.ALL
    return PdfPermissionBits.fromP(enc.permissions, enc.revision)
  }

  /**
   * Whether `password` is the file's USER (open) password, for a document it
   * opened as the owner (user = owner, Scan Kit's own Protect PDF). Null when
   * that can't be told (another security handler).
   */
  private fun isUserPassword(doc: PDDocument, password: String): Boolean? = try {
    val enc = doc.encryption
    if (enc == null || enc.filter != StandardSecurityHandler.FILTER) {
      null
    } else {
      val ids = doc.document.documentID
      val id = (ids?.getObject(0) as? COSString)?.bytes ?: ByteArray(0)
      // (password, U, O, …): the user key comes first (phase 4: these were swapped).
      StandardSecurityHandler().isUserPassword(
        password, enc.userKey, enc.ownerKey, enc.permissions, id, enc.revision, enc.length / 8, enc.isEncryptMetaData,
      )
    }
  } catch (e: Throwable) {
    null
  }

  /** pdfInfo (PdfEditor.info). Rejects ERR_PDF_INFO "Could not open the PDF". */
  fun info(context: Context, file: File, password: String?): Map<String, Any?> {
    try {
      var wasLocked = false
      var doc = loadBox(context, file, "")
      if (doc == null) {
        wasLocked = true
        if (!password.isNullOrEmpty()) doc = loadBox(context, file, password)
      }
      if (doc == null) {
        return mapOf("pageCount" to 0, "locked" to true, "encrypted" to true, "restricted" to false)
      }
      doc.use {
        val bits = accessBits(doc)
        val encrypted = doc.isEncrypted
        val out = mutableMapOf<String, Any?>(
          "pageCount" to doc.numberOfPages,
          "locked" to false,
          "encrypted" to encrypted,
          // Page edits would be refused: opened without a password, assembly forbidden.
          "restricted" to (encrypted && !wasLocked && (bits and PdfPermissionBits.ASSEMBLE) == 0),
          "canAnnotate" to (!encrypted || (bits and PdfPermissionBits.COMMENT) != 0),
          "canFillForms" to (!encrypted || (bits and PdfPermissionBits.FILL_FORMS) != 0),
        )
        var widgets = 0
        var additions = 0
        for (page in doc.pages) {
          for (a in runCatching { page.annotations }.getOrDefault(emptyList())) {
            val sub = a.subtype
            if (sub == "Widget") widgets++
            else if (sub != "Link" && sub != "Popup" && !a.isHidden && !a.isNoView) additions++
          }
        }
        out["formFields"] = widgets
        out["annotations"] = additions
        val facts = formFacts(doc)
        out["signed"] = facts.first
        out["certified"] = facts.second
        out["xfa"] = facts.third
        return out
      }
    } catch (e: VisionFailure) {
      throw e
    } catch (e: Throwable) {
      throw VisionFailure("ERR_PDF_INFO", "Could not open the PDF")
    }
  }

  /** (signed, certified, xfa), as PdfStructure.formFacts. */
  internal fun formFacts(doc: PDDocument): Triple<Boolean, Boolean, Boolean> {
    var signed = false
    var certified = false
    var xfa = false
    val catalog = doc.documentCatalog
    val perms = catalog.cosObject.getDictionaryObject(COSName.PERMS) as? COSDictionary
    if (perms != null && perms.containsKey(COSName.DOCMDP)) {
      certified = true
      signed = true
    }
    // Without PdfBox's fix-ups (they would build missing appearances in a
    // document a caller may write afterwards).
    val form = runCatching { catalog.getAcroForm(null) }.getOrNull()
    if (form != null) {
      if (form.cosObject.getDictionaryObject(COSName.XFA) != null) xfa = true
      if (!signed) {
        var budget = 5000
        for (field in runCatching { form.fieldTree.toList() }.getOrDefault(emptyList())) {
          if (--budget < 0) break
          if (field is PDSignatureField && field.cosObject.getDictionaryObject(COSName.V) != null) {
            signed = true
            break
          }
        }
      }
    }
    if (!signed) {
      var budget = 5000
      outer@ for (page in doc.pages) {
        for (a in runCatching { page.annotations }.getOrDefault(emptyList())) {
          if (--budget < 0) break@outer
          val d = a.cosObject
          if (inherited(d, COSName.FT) == COSName.SIG && inherited(d, COSName.V) != null) {
            signed = true
            break@outer
          }
        }
      }
    }
    return Triple(signed, certified, xfa)
  }

  /** A field key, looked up the /Parent chain (form fields inherit /FT and /V). */
  private fun inherited(start: COSDictionary, key: COSName): Any? {
    var d: COSDictionary? = start
    var depth = 0
    while (d != null && depth < 32) {
      d.getDictionaryObject(key)?.let { return it }
      d = d.getDictionaryObject(COSName.PARENT) as? COSDictionary
      depth++
    }
    return null
  }

  /** pdfPermissions (PdfUnrestrict.info). Rejects ERR_PDF_INFO. */
  fun permissions(context: Context, file: File, password: String?): Map<String, Any?> {
    try {
      var accepted = false
      var doc = loadBox(context, file, "")
      if (doc == null && !password.isNullOrEmpty()) {
        doc = loadBox(context, file, password)
        accepted = doc != null
      }
      if (doc == null) {
        return mapOf(
          "pageCount" to 0, "encrypted" to true, "locked" to true, "passwordAccepted" to false,
          "permissions" to PdfPermissionBits.toMap(0),
        )
      }
      doc.use {
        val out = mutableMapOf<String, Any?>(
          "pageCount" to doc.numberOfPages,
          "encrypted" to doc.isEncrypted,
          "locked" to false,
          "passwordAccepted" to accepted,
          "permissions" to PdfPermissionBits.toMap(accessBits(doc)),
        )
        if (accepted && password != null) {
          // Which password opened it, and the author's exact bits to write
          // back (lib/pdf-session.ts keeps a protected PDF protected).
          val owner = doc.currentAccessPermission.isOwnerPermission
          out["ownerUnlocked"] = owner
          out["userPassword"] = if (!owner) true else isUserPassword(doc, password)
          out["permissionBits"] = authorBits(doc)
        }
        return out
      }
    } catch (e: Throwable) {
      throw VisionFailure("ERR_PDF_INFO", "Could not open the PDF")
    }
  }

  /**
   * unlockPdf (PdfTools.unlock): a faithful unencrypted copy (every object
   * written again; forms, annotations and bookmarks kept), verified: opens
   * without a password, same page count. Rejects "wrong-password".
   */
  fun unlock(context: Context, input: File, output: File, password: String) {
    val doc = try {
      // A file that opens without one (owner-only protection) is copied the
      // same way whatever password was typed, as on iOS.
      loadBox(context, input, password) ?: loadBox(context, input, "")
    } catch (e: Throwable) {
      throw VisionFailure("ERR_PDF_UNLOCK", "Could not open the PDF")
    } ?: throw VisionFailure("ERR_PDF_UNLOCK", "wrong-password")
    val tmp = File(output.parentFile, ".unlock-${UUID.randomUUID()}.pdf")
    try {
      val pages = doc.use {
        doc.isAllSecurityToBeRemoved = true
        output.parentFile?.mkdirs()
        doc.save(tmp)
        doc.numberOfPages
      }
      val ok = try {
        PDDocument.load(tmp, "", memory(context)).use { check -> !check.isEncrypted && check.numberOfPages == pages }
      } catch (e: Throwable) {
        false
      }
      if (!ok) throw VisionFailure("ERR_PDF_UNLOCK", "Could not write the unlocked PDF")
      ImageFiles.replace(tmp, output)
    } catch (e: VisionFailure) {
      throw e
    } catch (e: Throwable) {
      throw VisionFailure("ERR_PDF_UNLOCK", "Could not write the unlocked PDF")
    } finally {
      tmp.delete()
    }
  }

  /** Per page: text and choice field values, and Fill & sign text marks. */
  private fun filledTexts(context: Context, file: File, password: String?, pageCount: Int): List<List<String>>? {
    val doc = loadBox(context, file, password ?: "") ?: loadBox(context, file, "") ?: return null
    doc.use {
      if (doc.numberOfPages != pageCount) return null
      // Widget → its field's value (a field's widgets may be its kids).
      val values = HashMap<COSDictionary, String>()
      val form = runCatching { doc.documentCatalog.acroForm }.getOrNull()
      if (form != null) {
        for (field in runCatching { form.fieldTree.toList() }.getOrDefault(emptyList<PDField>())) {
          val v = when (field) {
            is PDTextField -> field.value
            is PDChoice -> field.value?.joinToString(", ")
            else -> null
          }?.trim().orEmpty()
          if (v.isEmpty()) continue
          for (w in runCatching { field.widgets }.getOrDefault(emptyList())) values[w.cosObject] = v
        }
      }
      return doc.pages.map { page ->
        val extra = ArrayList<String>()
        for (a in runCatching { page.annotations }.getOrDefault(emptyList())) {
          val d = a.cosObject
          if (a is PDAnnotationWidget) {
            values[d]?.let { extra.add(it) }
          } else if (d.containsKey(MARK_KEY)) {
            a.contents?.trim()?.takeIf { it.isNotEmpty() }?.let { extra.add(it) }
          }
        }
        extra
      }
    }
  }
}
