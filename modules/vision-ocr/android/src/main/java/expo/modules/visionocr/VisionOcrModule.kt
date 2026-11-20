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
 * No views yet: the JS checks getViewConfig('VisionOcr') before using
 * PdfDocumentView or DocumentCameraView, so without them the viewer keeps its
 * "PDF not available on Android yet" state and the camera stays off. When the
 * views come (phases 2-3), PdfDocumentView must be registered FIRST (it is the
 * module's default view in shipped JS).
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
      } catch (e: QuadMath.BadQuad) {
        promise.reject("ERR_BAD_QUAD", e.message, null)
      } catch (e: OutOfMemoryError) {
        promise.reject(fallbackCode, "Not enough memory to process the image", null)
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

    OnDestroy {
      scope.cancel()
      synchronized(this@VisionOcrModule) {
        reader?.close()
        reader = null
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
    }
  }

  companion object {
    private const val SHARE_REQUEST = 7311
  }
}
