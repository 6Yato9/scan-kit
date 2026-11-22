package expo.modules.visionocr

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.util.Log
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import io.legere.pdfiumandroid.PdfDocument
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * The PDF viewer for imported PDF documents on Android (port phase 3), with
 * PdfDocumentView.swift's contract: props `source` (file URI),
 * `backgroundHex`, `initialPage` (zero-based, applied once per load); events
 * `onPageChange {page, count}` (zero-based, the page under the view's
 * vertical centre) and `onLoadError {message}` ('locked' when a password is
 * needed, anything else = unreadable).
 *
 * PDFium draws the pages (annotations and form fields included) on one
 * background thread per view; [PdfPagesView] does the scrolling, zooming
 * and caching. A session-unlocked PDF arrives as its decrypted working copy
 * (lib/pdf-session.ts), so the view never needs the password.
 *
 * Must stay the module's FIRST view: requireNativeView('VisionOcr') without
 * a name is the PDF viewer in shipped JS.
 */
@SuppressLint("ViewConstructor")
class PdfDocumentView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  val onPageChange by EventDispatcher<Map<String, Any?>>()
  val onLoadError by EventDispatcher<Map<String, Any?>>()

  override val shouldUseAndroidLayout = true

  private val main = Handler(Looper.getMainLooper())
  private val worker: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "scankit-pdf-view") }
  private val pages = PdfPagesView(context) { page, count ->
    onPageChange(mapOf("page" to page, "count" to count))
  }

  /** Main thread. */
  private var loadedPath: String? = null
  private var loadToken = 0
  private var destroyed = false

  /** Render thread only. */
  private var document: PdfDocument? = null

  init {
    setBackgroundColor(Color.BLACK)
    pages.setBackgroundHex(Color.BLACK)
    addView(pages)
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    val h = MeasureSpec.getSize(heightMeasureSpec)
    pages.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
    setMeasuredDimension(w, h)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    pages.layout(0, 0, r - l, b - t)
  }

  private fun onWorker(task: Runnable) {
    if (destroyed) return
    try {
      worker.execute(task)
    } catch (e: RejectedExecutionException) {
      // Destroyed meanwhile.
    }
  }

  // ── Props (main thread) ───────────────────────────────────────────────────

  fun setSource(uri: String?) {
    val path = uri?.takeIf { it.isNotEmpty() }?.let { ImageFiles.pathOf(it) }
    if (path == loadedPath) return
    loadedPath = path
    val token = ++loadToken
    pages.clear()
    onWorker {
      closeDocument()
      if (path == null) return@onWorker
      val result: Any = try {
        val doc = PdfEngine.openPdfium(context, File(path), null)
        document = doc
        PdfEngine.pageSizes(doc)
      } catch (e: PdfEngine.Locked) {
        "locked"
      } catch (e: Throwable) {
        Log.w("VisionOcr", "PDF view: ${e.message}")
        "Could not open the PDF"
      }
      main.post {
        if (token != loadToken || destroyed) return@post
        when (result) {
          is FloatArray -> {
            if (result.isEmpty()) {
              onLoadError(mapOf("message" to "The PDF has no pages"))
            } else {
              pages.setDocument(result, renderer(token), ::onWorker)
            }
          }
          else -> onLoadError(mapOf("message" to result))
        }
      }
    }
  }

  /** Draws a page of the document loaded for `token` (render thread). */
  private fun renderer(token: Int) = PdfPagesView.Renderer { index: Int, bitmap: Bitmap, startX: Int, startY: Int, sizeX: Int, sizeY: Int ->
    val doc = document
    if (doc == null || token != loadToken) {
      false
    } else {
      PdfEngine.render(doc, index, bitmap, startX, startY, sizeX, sizeY)
      true
    }
  }

  fun setBackgroundHex(hex: String?) {
    val color = parseHex(hex) ?: Color.BLACK
    setBackgroundColor(color)
    pages.setBackgroundHex(color)
  }

  /** Opens the document at this page (zero-based) instead of the first; applied once. */
  fun setInitialPage(page: Int?) {
    if (page != null && page > 0) pages.goToPage(page)
  }

  fun destroy() {
    if (destroyed) return
    loadToken++
    pages.clear()
    try {
      worker.execute { closeDocument() }
    } catch (e: RejectedExecutionException) {}
    destroyed = true
    worker.shutdown()
  }

  private fun closeDocument() {
    val doc = document ?: return
    document = null
    try { doc.close() } catch (e: Throwable) {}
  }

  companion object {
    /** "#RRGGBB" → colour; null when it isn't one (PdfDocumentView.swift's UIColor(hexString:)). */
    fun parseHex(hex: String?): Int? {
      var s = hex?.trim() ?: return null
      if (s.startsWith("#")) s = s.substring(1)
      if (s.length != 6) return null
      val v = s.toLongOrNull(16) ?: return null
      return (0xFF000000 or v).toInt()
    }
  }
}
