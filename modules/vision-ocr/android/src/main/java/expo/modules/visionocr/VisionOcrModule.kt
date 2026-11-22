package expo.modules.visionocr

import android.content.Context
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.File

/**
 * Android side of the VisionOcr module (docs/android-port-plan.md, phase 1).
 * Same name, function names, arguments, result shapes and error codes as
 * VisionOcrModule.swift; the JS (modules/vision-ocr/src/index.ts) feature-
 * checks every function, so only what exists here lights up on Android.
 *
 * Views, in the same order as iOS: PdfDocumentView FIRST (the module's
 * default view in shipped JS; PDFium, phase 3), then DocumentCameraView
 * (phase 2: CameraX, page detection, auto-capture).
 *
 * Every function runs off the main thread (shareFiles presents on it), and
 * rejects with promise.reject(code, message) so JS sees the exact message,
 * never "Call to function … has been rejected".
 */
class VisionOcrModule : Module() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()
  private var reader: TextReader? = null
  private var pendingShare: Promise? = null
  /** A Calendar or Contacts screen we started, waiting for its result: (request code, promise). */
  private var pendingForm: Pair<Int, Promise>? = null
  private var speech: SpeechController? = null

  /** Read aloud (Speech.kt); created on first use. */
  private fun speech(): SpeechController = synchronized(this) {
    speech ?: SpeechController(
      context,
      { name, body -> sendEvent(name, body) },
      { text -> try { textReader().dominantLanguage(text) } catch (_: Exception) { null } },
    ).also { speech = it }
  }

  /** Settles the open system form (once). */
  private fun settleForm(outcome: String) {
    val pending = pendingForm ?: return
    pendingForm = null
    pending.second.resolve(outcome)
  }

  /** Starts a Calendar/Contacts screen for a result; "unavailable" when no app handles it. */
  private fun presentForm(request: Int, intent: android.content.Intent, promise: Promise) {
    val activity = appContext.currentActivity
    if (activity == null) {
      promise.resolve("unavailable")
      return
    }
    // A form still open from before (its result never came) ends as cancelled.
    settleForm("cancelled")
    try {
      pendingForm = request to promise
      activity.startActivityForResult(intent, request)
    } catch (e: android.content.ActivityNotFoundException) {
      pendingForm = null
      promise.resolve("unavailable")
    } catch (e: Exception) {
      pendingForm = null
      Log.w("VisionOcr", "presentForm failed", e)
      promise.resolve("unavailable")
    }
  }

  private fun textReader(): TextReader = synchronized(this) {
    reader ?: TextReader(context.applicationContext).also { reader = it }
  }

  /** Runs `work` on a background thread; maps failures to (code, message) rejections. */
  private fun run(promise: Promise, fallbackCode: String, work: () -> Any?) {
    scope.launch {
      try {
        promise.resolve(work())
      } catch (e: VisionFailure) {
        promise.reject(e.code, e.message, null)
      } catch (e: PdfFail) {
        // The messages JS matches, with the codes iOS gives them.
        val code = when (e.message) {
          PdfDocs.LOCKED -> "ERR_PDF_LOCKED"
          PdfDocs.RESTRICTED -> "ERR_PDF_RESTRICTED"
          PdfDocs.CHANGED -> "ERR_PDF_CHANGED"
          PdfDocs.WRONG_PASSWORD -> "ERR_PDF_PASSWORD"
          else -> fallbackCode
        }
        promise.reject(code, e.message, null)
      } catch (e: QuadMath.BadQuad) {
        promise.reject("ERR_BAD_QUAD", e.message, null)
      } catch (e: OutOfMemoryError) {
        promise.reject(fallbackCode, "Not enough memory to process the file", null)
      } catch (e: Throwable) {
        Log.w("VisionOcr", "$fallbackCode: ${e.message}", e)
        promise.reject(fallbackCode, e.message ?: e.javaClass.simpleName, null)
      }
    }
  }

  private fun checkArgs(quality: Double, maxEdge: Double) {
    if (!quality.isFinite() || !maxEdge.isFinite() || maxEdge < 1) {
      throw VisionFailure("ERR_BAD_ARGS", "quality must be 0...1 and maxEdge >= 1")
    }
  }

  override fun definition() = ModuleDefinition {
    Name("VisionOcr")

    // Read aloud progress (SpeechController), as on iOS.
    Events("onSpeechProgress", "onSpeechState")

    OnDestroy {
      synchronized(this@VisionOcrModule) {
        speech?.shutdown()
        speech = null
      }
      scope.cancel()
      synchronized(this@VisionOcrModule) {
        reader?.close()
        reader = null
      }
    }

    // Must stay the FIRST view: requireNativeView('VisionOcr') without a name
    // is the PDF viewer in shipped JS.
    // Phase 3: PDFium pages, the same props and events as PdfDocumentView.swift.
    View(PdfDocumentView::class) {
      Events("onPageChange", "onLoadError")
      Prop("source") { view: PdfDocumentView, uri: String? -> view.setSource(uri) }
      Prop("backgroundHex") { view: PdfDocumentView, hex: String? -> view.setBackgroundHex(hex) }
      Prop("initialPage") { view: PdfDocumentView, page: Int? -> view.setInitialPage(page) }
      OnViewDestroys { view: PdfDocumentView -> view.destroy() }
    }

    // Scan Kit's own document camera (DocumentCameraView.kt), same contract
    // as DocumentCameraView.swift.
    View(DocumentCameraView::class) {
      Events("onDetection", "onCapture", "onCaptureStart", "onCameraError", "onCameraState")
      Prop("autoCapture") { view: DocumentCameraView, on: Boolean? -> view.setAutoCapture(on ?: true) }
      Prop("flash") { view: DocumentCameraView, mode: String? -> view.setFlash(mode ?: "auto") }
      Prop("torch") { view: DocumentCameraView, on: Boolean? -> view.setTorch(on ?: false) }
      Prop("active") { view: DocumentCameraView, on: Boolean? -> view.setActive(on ?: true) }
      Prop("simulatorImageUri") { view: DocumentCameraView, uri: String? -> view.setSimulatorImage(uri) }
      Prop("simulatorJitter") { view: DocumentCameraView, amount: Double? -> view.setSimulatorJitter(amount ?: 0.0) }
      OnViewDidUpdateProps { view: DocumentCameraView -> view.propsDidUpdate() }
      OnViewDestroys { view: DocumentCameraView -> view.destroy() }
      AsyncFunction("capture") { view: DocumentCameraView, promise: Promise -> view.capture(promise) }
      AsyncFunction("rearm") { view: DocumentCameraView -> view.rearm() }
    }

    // ── PDF reading (port phase 3, PdfEngine.kt). Same contracts and
    // rejection messages as the iOS functions of the same names.

    /** Android only: this build's PdfDocumentView is the real viewer (phase-2 builds registered a placeholder). */
    Function("hasPdfView") { true }

    /** { pageCount, locked, encrypted, restricted, … } without changing the file. Rejects ERR_PDF_INFO. */
    AsyncFunction("pdfInfo") { uri: String, password: String?, promise: Promise ->
      run(promise, "ERR_PDF_INFO") { PdfEngine.info(context, File(ImageFiles.pathOf(uri)), password) }
    }

    /** What the permissions allow, opened with `password` when it needs one; which password it was. Rejects ERR_PDF_INFO. */
    AsyncFunction("pdfPermissions") { uri: String, password: String?, promise: Promise ->
      run(promise, "ERR_PDF_INFO") { PdfEngine.permissions(context, File(ImageFiles.pathOf(uri)), password) }
    }

    /** An unencrypted, verified copy of a protected PDF (the session's working copy). Rejects "wrong-password". */
    AsyncFunction("unlockPdf") { inputUri: String, outputUri: String, password: String, promise: Promise ->
      run(promise, "ERR_PDF_UNLOCK") {
        val out = File(ImageFiles.pathOf(outputUri))
        PdfEngine.unlock(context, File(ImageFiles.pathOf(inputUri)), out, password)
        ImageFiles.uriOf(out)
      }
    }

    /** Embedded text per page, plus filled-in values; rejects "locked" when a password is needed. */
    AsyncFunction("pdfPageTexts") { uri: String, password: String?, promise: Promise ->
      run(promise, "ERR_PDF_TEXT") { PdfEngine.pageTexts(context, File(ImageFiles.pathOf(uri)), password) }
    }

    /** Every page as `pdfpage-%03d.jpg` in `outputDirUri` (~200 dpi, long edge ≤ maxEdge); resolves the URIs in order. */
    AsyncFunction("renderPdfPages") { inputUri: String, outputDirUri: String, maxEdge: Double, promise: Promise ->
      run(promise, "ERR_PDF_RENDER") {
        PdfEngine.renderPages(context, File(ImageFiles.pathOf(inputUri)), File(ImageFiles.pathOf(outputDirUri)), maxEdge)
      }
    }

    // ── PDF tools (port phase 4: PdfTools.kt, PdfForms.kt). Same contracts,
    // result shapes and rejection messages as iOS; every output is read back
    // before it resolves.

    /**
     * Page edits that keep a PDF a PDF: rotate, delete, reorder, blank pages,
     * split. Resolves to the page count. Rejects ERR_PDF_LOCKED ("locked"),
     * ERR_PDF_RESTRICTED ("restricted"), ERR_PDF_EDIT otherwise.
     */
    AsyncFunction("pdfEditPages") { inputUri: String, outputUri: String, sources: List<Int>, rotations: List<Int>, password: String?, promise: Promise ->
      run(promise, "ERR_PDF_EDIT") {
        PdfTools.editPages(context, File(ImageFiles.pathOf(inputUri)), File(ImageFiles.pathOf(outputUri)), sources, rotations, password)
      }
    }

    /** Concatenates PDFs in order. Rejects ERR_PDF_RESTRICTED ("restricted"), ERR_PDF_MERGE. */
    AsyncFunction("mergePdfs") { inputUris: List<String>, outputUri: String, promise: Promise ->
      run(promise, "ERR_PDF_MERGE") {
        val out = File(ImageFiles.pathOf(outputUri))
        PdfTools.merge(context, inputUris.map { File(ImageFiles.pathOf(it)) }, out)
        ImageFiles.uriOf(out)
      }
    }

    /** A password-protected copy (verified). Rejects ERR_PDF_PROTECT. */
    AsyncFunction("protectPdf") { inputUri: String, outputUri: String, password: String, promise: Promise ->
      run(promise, "ERR_PDF_PROTECT") {
        val out = File(ImageFiles.pathOf(outputUri))
        PdfTools.protect(context, File(ImageFiles.pathOf(inputUri)), out, password)
        ImageFiles.uriOf(out)
      }
    }

    /** Encrypts keeping a protection as it was: open password, owner password (random when null), permission bits. */
    AsyncFunction("protectPdfKeeping") { inputUri: String, outputUri: String, userPassword: String, ownerPassword: String?, permissions: Int, promise: Promise ->
      run(promise, "ERR_PDF_PROTECT") {
        val out = File(ImageFiles.pathOf(outputUri))
        PdfTools.protectKeeping(context, File(ImageFiles.pathOf(inputUri)), out, userPassword, ownerPassword, maxOf(0, permissions))
        ImageFiles.uriOf(out)
      }
    }

    /**
     * An unencrypted copy with every restriction removed; resolves
     * { pageCount, encrypted, method }. Rejects ERR_PDF_LOCKED ("locked"),
     * ERR_PDF_PASSWORD ("wrong-password"), ERR_PDF_UNRESTRICT.
     */
    AsyncFunction("unrestrictPdf") { inputUri: String, outputUri: String, password: String?, promise: Promise ->
      run(promise, "ERR_PDF_UNRESTRICT") {
        PdfTools.unrestrict(context, File(ImageFiles.pathOf(inputUri)), File(ImageFiles.pathOf(outputUri)), password)
      }
    }

    /** Pages, form fields and permissions for Fill & sign. Rejects ERR_PDF_LOCKED ("locked"), ERR_PDF_FILL. */
    AsyncFunction("pdfFillInfo") { uri: String, promise: Promise ->
      run(promise, "ERR_PDF_FILL") { PdfForms.fillInfo(context, File(ImageFiles.pathOf(uri))) }
    }

    /** One page as an upright JPEG (crop box, rotation applied), long edge maxEdge px; `hideFields` leaves the widgets out. */
    AsyncFunction("pdfRenderPage") { uri: String, index: Int, outUri: String, maxEdge: Double, hideFields: Boolean, promise: Promise ->
      run(promise, "ERR_PDF_RENDER") {
        PdfForms.renderPage(context, File(ImageFiles.pathOf(uri)), index, File(ImageFiles.pathOf(outUri)), maxEdge, hideFields)
      }
    }

    /**
     * Fills form fields and adds marks, verified before it resolves to the
     * page count. Rejects ERR_PDF_LOCKED, ERR_PDF_RESTRICTED, ERR_PDF_CHANGED
     * ("changed"), ERR_PDF_FILL.
     */
    AsyncFunction("pdfFill") { inputUri: String, outputUri: String, fields: List<Map<String, Any?>>, marks: List<Map<String, Any?>>, promise: Promise ->
      run(promise, "ERR_PDF_FILL") {
        PdfForms.fill(context, File(ImageFiles.pathOf(inputUri)), File(ImageFiles.pathOf(outputUri)), fields, marks)
      }
    }

    /** A flattened copy (verified); resolves to the page count. Rejects ERR_PDF_LOCKED, ERR_PDF_RESTRICTED, ERR_PDF_FLATTEN. */
    AsyncFunction("pdfFlatten") { inputUri: String, outputUri: String, promise: Promise ->
      run(promise, "ERR_PDF_FLATTEN") {
        PdfForms.flatten(context, File(ImageFiles.pathOf(inputUri)), File(ImageFiles.pathOf(outputUri)))
      }
    }

    /** Debug builds only: pdfFill burns its additions into the pages (its fallback). Returns whether the switch exists. */
    Function("pdfFillForceFallback") { on: Boolean ->
      if (BuildConfig.DEBUG) {
        PdfForms.forceBurn = on
        true
      } else {
        false
      }
    }

    /** Whether the device has any camera to scan with (JS offers Import photos otherwise). */
    Function("hasCamera") {
      context.packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_CAMERA_ANY)
    }

    /**
     * Page outline in a photo: [x0,y0,...,x3,y3] TL, TR, BR, BL, normalised
     * 0..1, top-left origin, upright (EXIF applied). null when not confident.
     */
    AsyncFunction("detectQuad") { uri: String, promise: Promise ->
      run(promise, "ERR_DETECT_QUAD") {
        PageScan.detectQuad(ImageFiles.pathOf(uri), 0.15)?.let { PageGeometry.flatten(it) }
      }
    }

    /**
     * Auto-crop on import: { uri, detected }. A confident outline (at least
     * 30 % of the photo) is perspective-corrected into a new JPEG; otherwise
     * the input comes back unchanged.
     */
    AsyncFunction("detectDocument") { uri: String, quality: Double, promise: Promise ->
      run(promise, "ERR_DOC_DETECT") {
        val input = ImageFiles.pathOf(uri)
        val quad = PageScan.detectQuad(input, 0.30)
        if (quad == null) {
          mapOf("uri" to uri, "detected" to false)
        } else {
          val dir = File(context.cacheDir, "page-source").apply { mkdirs() }
          val out = File(dir, "doc-${java.util.UUID.randomUUID().toString().uppercase()}.jpg")
          ImageFiles.warp(input, quad, out, if (quality.isFinite()) quality.coerceIn(0.0, 1.0) else 0.9, 4096)
          mapOf("uri" to ImageFiles.uriOf(out), "detected" to true)
        }
      }
    }

    /** { text, lines: [{ text, left, top, width, height }] }, frames in upright-image pixels. */
    AsyncFunction("recognize") { uri: String, promise: Promise ->
      run(promise, "ERR_VISION_OCR") { textReader().recognize(ImageFiles.pathOf(uri)) }
    }

    /** Perspective-corrected crop of `quad` from the upright source, as an upright JPEG capped at maxEdge. */
    AsyncFunction("warpQuad") { srcUri: String, quad: List<Double>, outUri: String, quality: Double, maxEdge: Double, promise: Promise ->
      run(promise, "ERR_WARP") {
        val pts = QuadMath.parse(quad)
        checkArgs(quality, maxEdge)
        val out = File(ImageFiles.pathOf(outUri))
        val (w, h) = ImageFiles.warp(ImageFiles.pathOf(srcUri), pts, out, quality.coerceIn(0.0, 1.0), maxEdge.toInt())
        mapOf("uri" to ImageFiles.uriOf(out), "width" to w, "height" to h)
      }
    }

    /** Upright (EXIF baked in) JPEG copy with the long edge capped at maxEdge. */
    AsyncFunction("normalizeImage") { srcUri: String, outUri: String, maxEdge: Double, quality: Double, promise: Promise ->
      run(promise, "ERR_NORMALIZE") {
        checkArgs(quality, maxEdge)
        val out = File(ImageFiles.pathOf(outUri))
        val (w, h) = ImageFiles.normalize(ImageFiles.pathOf(srcUri), out, maxEdge.toInt(), quality.coerceIn(0.0, 1.0))
        mapOf("uri" to ImageFiles.uriOf(out), "width" to w, "height" to h)
      }
    }

    /** Moves a file over another in one atomic rename. Resolves to the destination URI. */
    AsyncFunction("replaceFile") { srcUri: String, destUri: String, promise: Promise ->
      run(promise, "ERR_REPLACE_FILE") {
        val dest = File(ImageFiles.pathOf(destUri))
        ImageFiles.replace(File(ImageFiles.pathOf(srcUri)), dest)
        ImageFiles.uriOf(dest)
      }
    }

    /** Copies a file the system handed us (content:// or file://) into the app. */
    AsyncFunction("copyIncomingFile") { sourceUri: String, destUri: String, promise: Promise ->
      run(promise, "ERR_COPY_INCOMING") { IncomingFiles.copy(context, sourceUri, destUri) }
    }

    /** Android only: { name, mimeType, size } of an incoming file (a content:// URI has no file name). */
    AsyncFunction("incomingFileInfo") { uri: String, promise: Promise ->
      run(promise, "ERR_INCOMING_INFO") { IncomingFiles.info(context, uri) }
    }

    /** Dominant language of `text` (BCP-47, e.g. "fr", "ar"), or null. */
    AsyncFunction("detectLanguage") { text: String, promise: Promise ->
      run(promise, "ERR_LANGUAGE") { textReader().dominantLanguage(text) }
    }

    /**
     * One share chooser with several files. Resolves when the chooser is
     * closed (Android reports the same result whatever the user chose; JS
     * treats every outcome alike).
     */
    AsyncFunction("shareFiles") { uris: List<String>, title: String?, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject("ERR_SHARE_FILES", "No activity", null)
        return@AsyncFunction
      }
      try {
        val chooser = IncomingFiles.shareIntent(context, uris, title)
        pendingShare?.resolve(null)
        pendingShare = promise
        activity.startActivityForResult(chooser, SHARE_REQUEST)
      } catch (e: VisionFailure) {
        pendingShare = null
        promise.reject(e.code, e.message, null)
      } catch (e: Exception) {
        pendingShare = null
        promise.reject("ERR_SHARE_FILES", e.message ?: "Could not open the share sheet", null)
      }
    }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)

    OnActivityResult { _, payload ->
      if (payload.requestCode == SHARE_REQUEST) {
        pendingShare?.resolve(null)
        pendingShare = null
      }
      val form = pendingForm
      if (form != null && payload.requestCode == form.first) {
        settleForm(
          if (form.first == SystemForms.EVENT_REQUEST) SystemForms.eventOutcome(payload.resultCode)
          else SystemForms.contactOutcome(payload.resultCode),
        )
      }
    }

    // Leaving the app ends reading (a document isn't read out behind App Lock), as on iOS.
    OnActivityEntersBackground {
      synchronized(this@VisionOcrModule) { speech }?.stop()
    }

    // Back in the app with a form still unsettled (the activity was recreated
    // and its result lost): settle it, so JS never waits forever.
    OnActivityEntersForeground {
      if (pendingForm != null) {
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
          settleForm(if (pendingForm?.first == SystemForms.EVENT_REQUEST) "unknown" else "cancelled")
        }, 1500)
      }
    }

    // ── Acting on recognised text (phase 5: TextData.kt, Barcodes.kt,
    // Speech.kt, SystemForms.kt, VCard.kt). Same contracts as iOS.

    /** Phone numbers, emails, links and (where the system classifier finds them) addresses. */
    AsyncFunction("detectData") { text: String, promise: Promise ->
      run(promise, "ERR_DETECT_DATA") { TextData.detect(context, text) }
    }

    /** QR codes and barcodes in an image file, top to bottom. Rejects ERR_BARCODES for an unreadable file. */
    AsyncFunction("detectBarcodes") { uri: String, promise: Promise ->
      run(promise, "ERR_BARCODES") { Barcodes.detect(ImageFiles.pathOf(uri)) }
    }

    /** Reads `text` aloud (stopping anything being read); resolves { id, language }. */
    AsyncFunction("speak") { text: String, language: String?, rate: Double?, promise: Promise ->
      run(promise, "ERR_SPEECH") { speech().speak(text, language, rate) }
    }

    AsyncFunction("pauseSpeaking") { promise: Promise ->
      run(promise, "ERR_SPEECH") { speech().pause(); null }
    }

    AsyncFunction("resumeSpeaking") { promise: Promise ->
      run(promise, "ERR_SPEECH") { speech().resume(); null }
    }

    AsyncFunction("stopSpeaking") { promise: Promise ->
      run(promise, "ERR_SPEECH") { synchronized(this@VisionOcrModule) { speech }?.stop(); null }
    }

    /** The calendar app's new-event screen, prefilled. Resolves saved | unknown | unavailable. */
    AsyncFunction("presentEventEditor") { title: String, startMs: Double, endMs: Double, allDay: Boolean, notes: String?, location: String?, promise: Promise ->
      presentForm(SystemForms.EVENT_REQUEST, SystemForms.eventIntent(title, startMs, endMs, allDay, notes, location), promise)
    }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)

    /** The contacts app's new-contact screen, prefilled (photo included). Resolves saved | cancelled | unavailable. */
    AsyncFunction("presentNewContact") { fields: Map<String, Any?>, promise: Promise ->
      scope.launch {
        val intent = try {
          SystemForms.contactIntent(fields, VCard.photoJpeg(fields))
        } catch (e: Exception) {
          Log.w("VisionOcr", "presentNewContact", e)
          null
        }
        android.os.Handler(android.os.Looper.getMainLooper()).post {
          if (intent == null) promise.resolve("unavailable") else presentForm(SystemForms.CONTACT_REQUEST, intent, promise)
        }
      }
    }

    /** Writes a vCard 3.0 (.vcf) of the contact, the same text as iOS; resolves its file:// URI. */
    AsyncFunction("writeVCard") { fields: Map<String, Any?>, outputUri: String, promise: Promise ->
      run(promise, "ERR_VCARD") {
        val out = File(ImageFiles.pathOf(outputUri))
        VCard.write(fields, out)
        ImageFiles.uriOf(out)
      }
    }
  }

  companion object {
    private const val SHARE_REQUEST = 7311
  }
}
