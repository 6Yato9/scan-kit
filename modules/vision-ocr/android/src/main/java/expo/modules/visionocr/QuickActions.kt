package expo.modules.visionocr

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
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
// with extra "type" = the iOS item type ("com.zerohorizon.scan.scan" …), so the
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

/**
 * The incoming-file launches already handled, as (task id, intent
 * fingerprint), kept across process death in private SharedPreferences. A
 * task keeps its id for its whole life, Recents relaunches included; a new
 * share that starts the app makes a new task.
 */
internal object LaunchMemory {
  private const val PREFS = "scankit.launch-memory"
  private const val KEY = "handled"
  private const val MAX = 8

  /** True when this task already handled this intent; else remembers it. */
  fun seenBefore(activity: Activity, intent: Intent): Boolean {
    val entry = "${activity.taskId}|${fingerprint(intent)}"
    val prefs = activity.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
    val list = prefs.getString(KEY, "")!!.split('\n').filter { it.isNotEmpty() }
    if (entry in list) return true
    prefs.edit().putString(KEY, (list + entry).takeLast(MAX).joinToString("\n")).apply()
    return false
  }

  /** Action, type, data and every URI it carries (never the contents), hashed. */
  fun fingerprint(intent: Intent): String {
    val parts = ArrayList<String>()
    parts.add(intent.action.orEmpty())
    parts.add(intent.type.orEmpty())
    parts.add(intent.dataString.orEmpty())
    intent.clipData?.let { clip -> for (i in 0 until clip.itemCount) parts.add(clip.getItemAt(i).uri?.toString().orEmpty()) }
    val digest = java.security.MessageDigest.getInstance("SHA-256").digest(parts.joinToString("\u0000").toByteArray())
    return digest.take(12).joinToString("") { "%02x".format(it) }
  }
}

/** Activity hooks: quick actions and "Share to Scan Kit" intents. */
class VisionOcrActivityListener : ReactActivityLifecycleListener {
  override fun onCreate(activity: Activity?, savedInstanceState: Bundle?) {
    // Runs before React Native starts: nothing here may crash the launch.
    try {
      appContext = activity?.applicationContext
      val intent = activity?.intent ?: return
      // A recreated activity (or one reopened from Recents, also after the
      // process was killed) carries the intent it was first started with:
      // don't run that action, or import those files, again. Expo's
      // MainActivity passes a null state to super.onCreate (react-native-
      // screens), so listeners never see savedInstanceState, and Android
      // relaunches a killed task's activity without LAUNCHED_FROM_HISTORY:
      // LaunchMemory recognises the same task's same intent instead.
      val replayed = savedInstanceState != null ||
        (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0 ||
        (isIncoming(intent) && LaunchMemory.seenBefore(activity, intent))
      if (intent.action == QUICK_ACTION) {
        val type = intent.getStringExtra(QUICK_ACTION_TYPE)
        if (type != null && !replayed) QuickActionCenter.launched(type)
        intent.removeExtra(QUICK_ACTION_TYPE)
        return
      }
      if (replayed && isIncoming(intent)) {
        IncomingFiles.neutralize(intent)
        return
      }
      IncomingFiles.rewriteShareIntent(activity, intent)
    } catch (e: Throwable) {
      Log.w("VisionOcr", "launch intent", e)
      activity?.intent?.let { IncomingFiles.neutralize(it) }
    }
  }

  override fun onNewIntent(intent: Intent?): Boolean {
    try {
      if (intent?.action == QUICK_ACTION) {
        intent.getStringExtra(QUICK_ACTION_TYPE)?.let { QuickActionCenter.perform(it) }
        return false
      }
      val context = appContext ?: return false
      IncomingFiles.rewriteShareIntent(context, intent)
    } catch (e: Throwable) {
      Log.w("VisionOcr", "new intent", e)
      intent?.let { IncomingFiles.neutralize(it) }
    }
    return false
  }

  /** "Open with" / "Share to": files Linking would hand to JS. Deep links (scankit://) are not files. */
  private fun isIncoming(intent: Intent): Boolean = when (intent.action) {
    Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> true
    Intent.ACTION_VIEW -> !intent.data?.scheme.equals("scankit", ignoreCase = true)
    else -> false
  }

  /** The application, remembered from onCreate (onNewIntent gets no activity). */
  private var appContext: android.content.Context? = null
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
