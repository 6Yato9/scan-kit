package expo.modules.systemchrome

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
 */
class SystemChromeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SystemChrome")

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
  }
}
