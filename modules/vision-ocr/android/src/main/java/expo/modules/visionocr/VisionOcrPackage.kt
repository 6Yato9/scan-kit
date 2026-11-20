package expo.modules.visionocr

import android.content.Context
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener

/** Registers the activity hooks (quick actions, "Share to Scan Kit"). Found by Expo autolinking. */
class VisionOcrPackage : Package {
  override fun createReactActivityLifecycleListeners(activityContext: Context?): List<ReactActivityLifecycleListener> =
    listOf(VisionOcrActivityListener())
}
