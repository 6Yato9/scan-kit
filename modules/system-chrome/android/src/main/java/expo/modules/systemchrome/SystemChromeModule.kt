package expo.modules.systemchrome

import android.app.Activity
import android.app.Application
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.core.view.WindowInsetsControllerCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * `setNavigationBarStyle("light" | "dark")`: the buttons of the navigation
 * bar (and the contrast scrim the system draws behind 3-button navigation)
 * for the screen on top, as `StatusBar` sets the status bar's: "light" for
 * light buttons over a dark screen, "dark" for dark buttons over a light one.
 * React Native's edge-to-edge setup (WindowUtil.enableEdgeToEdge) chooses it
 * once at launch from the system theme; nothing changes it after that, so it
 * was wrong over the always-dark screens, under the app's own Dark setting,
 * and after the system theme changed while the app was open.
 *
 * `setRecentsPrivacy(on)`: while App Lock is on, the app's card in Recents
 * shows no document (iOS draws a privacy cover when the app goes inactive;
 * Android has no inactive state and takes its snapshot itself). Android 13+:
 * `setRecentsScreenshotEnabled(false)`, which only blanks the Recents card.
 * Older versions have no such switch, so FLAG_SECURE, which also blocks
 * screenshots and screen recording of the app (owner decision: only while
 * App Lock is on).
 *
 * `onActivityVisibility {visible}`: the app's own activity was stopped (no
 * longer visible at all) or started again. React Native's AppState reports
 * "background" on every pause, which also happens under a permission dialog
 * or the share chooser drawn over the app; components/lock-gate.tsx locks on
 * a real stop instead (see its header). Rotation / theme recreation is not a
 * stop.
 */
class SystemChromeModule : Module() {
  private var callbacks: Application.ActivityLifecycleCallbacks? = null

  override fun definition() = ModuleDefinition {
    Name("SystemChrome")

    Events("onActivityVisibility")

    OnCreate {
      val app = appContext.reactContext?.applicationContext as? Application ?: return@OnCreate
      val mainActivity = app.packageManager.getLaunchIntentForPackage(app.packageName)?.component?.className
      val cb = object : Application.ActivityLifecycleCallbacks {
        private fun isMain(activity: Activity) = activity.javaClass.name == mainActivity
        override fun onActivityStarted(activity: Activity) {
          if (isMain(activity)) sendEvent("onActivityVisibility", mapOf("visible" to true))
        }
        override fun onActivityStopped(activity: Activity) {
          if (isMain(activity) && !activity.isChangingConfigurations) {
            sendEvent("onActivityVisibility", mapOf("visible" to false))
          }
        }
        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
        override fun onActivityResumed(activity: Activity) {}
        override fun onActivityPaused(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
        override fun onActivityDestroyed(activity: Activity) {}
      }
      app.registerActivityLifecycleCallbacks(cb)
      callbacks = cb
    }

    OnDestroy {
      val app = appContext.reactContext?.applicationContext as? Application
      callbacks?.let { app?.unregisterActivityLifecycleCallbacks(it) }
      callbacks = null
    }

    Function("setNavigationBarStyle") { style: String ->
      val activity = appContext.currentActivity ?: return@Function false
      activity.runOnUiThread {
        val window = activity.window ?: return@runOnUiThread
        WindowInsetsControllerCompat(window, window.decorView).isAppearanceLightNavigationBars = style == "dark"
        // A night-mode change (the app's own Light / Dark setting goes through
        // AppCompatDelegate) rebuilds the activity theme without the dialog
        // overlay applied at launch; JS calls this after every theme change.
        SystemChromeActivityListener.applyDialogTheme(activity)
      }
      true
    }

    Function("setRecentsPrivacy") { on: Boolean ->
      RecentsPrivacy.enabled = on
      appContext.currentActivity?.let { activity -> activity.runOnUiThread { RecentsPrivacy.apply(activity) } }
      true
    }
  }
}

/** The Recents privacy wanted by JS, re-applied to a recreated activity (SystemChromeActivityListener). */
object RecentsPrivacy {
  @Volatile var enabled = false

  /** Main thread only. */
  fun apply(activity: Activity) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      activity.setRecentsScreenshotEnabled(!enabled)
    } else {
      val window = activity.window ?: return
      if (enabled) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }
  }
}
