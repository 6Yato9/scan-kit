package expo.modules.visionocr

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import expo.modules.core.interfaces.ReactActivityLifecycleListener
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Home-screen shortcuts (long-press the app icon), Android side of
// QuickActions.swift with the same JS contract (lib/quick-actions.ts):
// takePendingQuickAction(), the "onQuickAction" event and
// isOverlayPresented().
//
// The shortcuts are static (res/xml/scankit_shortcuts.xml, written by
// plugins/with-android-platform.js); each starts QuickActionTrampolineActivity
// with extra "type" = the iOS item type ("com.6yato9.scan-kit.scan" …), so the
// JS map is shared. No dynamic shortcuts, on purpose: a "recent document"
// shortcut would put a document's name on the home screen (App Lock).

const val QUICK_ACTION = "expo.modules.visionocr.QUICK_ACTION"
const val QUICK_ACTION_TYPE = "type"

/** Shared between the activity listener and the JS module; everything under the lock. */
object QuickActionCenter {
  private val lock = Any()
  private var pending: String? = null
  private var emitter: ((String) -> Boolean)? = null

  /** Cold launch: kept until JS asks for it. */
  fun launched(type: String) = synchronized(lock) { pending = type }

  /** Warm launch: to JS now if it is listening, else kept. */
  fun perform(type: String) {
    val send = synchronized(lock) { emitter }
    if (send != null && send(type)) return
    synchronized(lock) { pending = type }
  }

  fun take(): String? = synchronized(lock) { pending.also { pending = null } }

  fun setEmitter(fn: ((String) -> Boolean)?) = synchronized(lock) { emitter = fn }
}

/**
 * The launcher starts a static shortcut with NEW_TASK | CLEAR_TASK. Started
 * in its own empty task (taskAffinity "" in the manifest) this activity only
 * clears that one, then brings Scan Kit's task forward as it was (the main
 * activity is singleTask) with the action, and goes away.
 */
class QuickActionTrampolineActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val type = intent?.getStringExtra(QUICK_ACTION_TYPE)
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    if (type != null && launch?.component != null) {
      startActivity(
        Intent(QUICK_ACTION).apply {
          component = launch.component
          putExtra(QUICK_ACTION_TYPE, type)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        },
      )
    }
    finish()
    @Suppress("DEPRECATION")
    overridePendingTransition(0, 0)
  }
}

/** Activity hooks: quick actions and "Share to Scan Kit" intents. */
class VisionOcrActivityListener : ReactActivityLifecycleListener {
  override fun onCreate(activity: Activity?, savedInstanceState: Bundle?) {
    val intent = activity?.intent ?: return
    // A recreated activity (or one reopened from Recents) carries the
    // intent it was first started with: don't run that action again.
    val replayed = savedInstanceState != null ||
      (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0
    if (intent.action == QUICK_ACTION) {
      val type = intent.getStringExtra(QUICK_ACTION_TYPE)
      if (type != null && !replayed) QuickActionCenter.launched(type)
      intent.removeExtra(QUICK_ACTION_TYPE)
      return
    }
    IncomingFiles.rewriteShareIntent(intent)
  }

  override fun onNewIntent(intent: Intent?): Boolean {
    if (intent?.action == QUICK_ACTION) {
      intent.getStringExtra(QUICK_ACTION_TYPE)?.let { QuickActionCenter.perform(it) }
      return false
    }
    IncomingFiles.rewriteShareIntent(intent)
    return false
  }
}

/** JS: lib/quick-actions.ts (requireOptionalNativeModule('ScanKitQuickActions')). */
class QuickActionsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ScanKitQuickActions")

    Events("onQuickAction")

    OnStartObserving {
      QuickActionCenter.setEmitter { type ->
        sendEvent("onQuickAction", mapOf("type" to type))
        true
      }
    }

    OnStopObserving { QuickActionCenter.setEmitter(null) }

    OnDestroy { QuickActionCenter.setEmitter(null) }

    Function("takePendingQuickAction") { QuickActionCenter.take() }

    /**
     * True while a React Native Modal (every bottom sheet), an alert or a
     * system sheet is over the screens. Each of those is its own window, so
     * the activity's window loses focus to it. Focus can lag a moment behind
     * coming back to the foreground, so a missing focus is re-checked for up
     * to half a second before it counts.
     */
    AsyncFunction("isOverlayPresented") { promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      val handler = Handler(Looper.getMainLooper())
      val start = System.currentTimeMillis()
      fun check() {
        if (activity.hasWindowFocus()) {
          promise.resolve(false)
        } else if (System.currentTimeMillis() - start >= 500) {
          promise.resolve(true)
        } else {
          handler.postDelayed({ check() }, 50)
        }
      }
      handler.post { check() }
    }
  }
}
