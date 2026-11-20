package expo.modules.visionocr

import android.annotation.SuppressLint
import android.content.Context
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/**
 * Placeholder for the PDF viewer (phase 3 of docs/android-port-plan.md). It
 * exists only so the module's views are registered in the same order as on
 * iOS: the FIRST view is the module's default view, and shipped JS asks for
 * the default view as the PDF viewer (src/PdfDocumentView.tsx). JS doesn't
 * use it on Android until the real viewer replaces it; if something does,
 * it reports the PDF as unreadable rather than showing nothing.
 */
@SuppressLint("ViewConstructor")
class PdfDocumentView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  val onPageChange by EventDispatcher<Map<String, Any?>>()
  val onLoadError by EventDispatcher<Map<String, Any?>>()
  private var reported: String? = null

  fun setSource(uri: String?) {
    if (uri.isNullOrEmpty() || uri == reported) return
    reported = uri
    post { onLoadError(mapOf("message" to "unavailable")) }
  }
}
