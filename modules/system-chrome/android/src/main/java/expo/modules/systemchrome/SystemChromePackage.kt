package expo.modules.systemchrome

import android.app.Activity
import android.content.Context
import android.os.Bundle
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener

/** Found by Expo autolinking (it looks for *Package files): gives the activity the app's alert dialog look and Recents privacy. */
class SystemChromePackage : Package {
  override fun createReactActivityLifecycleListeners(activityContext: Context?): List<ReactActivityLifecycleListener> =
    listOf(SystemChromeActivityListener())
}

class SystemChromeActivityListener : ReactActivityLifecycleListener {
  override fun onCreate(activity: Activity?, savedInstanceState: Bundle?) {
    activity?.let {
      applyDialogTheme(it)
      // A recreated activity (theme change) keeps App Lock's Recents privacy.
      RecentsPrivacy.apply(it)
    }
  }

  companion object {
    /**
     * Layers alertDialogTheme and its colours (res/values/system_chrome.xml)
     * over the app theme; dialogs read it when they are built. Day/night
     * resources follow the night mode the app sets from its theme setting.
     * Idempotent.
     */
    fun applyDialogTheme(activity: Activity) {
      activity.theme?.applyStyle(R.style.SystemChromeOverlay, true)
    }
  }
}
