import ExpoModulesCore
import UIKit

// Home-screen quick actions (long-press the app icon).
//
// The items themselves are static: UIApplicationShortcutItems in Info.plist
// (app.json ios.infoPlist, which EAS prebuilds from). There are deliberately no
// dynamic items: a "recent document" item would put a document's name on the
// home screen, which App Lock users must never see.
//
// The app has no UIScene manifest (AppDelegate.swift creates the window
// itself), so actions arrive through the app delegate, which ExpoAppDelegate
// forwards to its subscribers:
//   - cold launch: launchOptions[.shortcutItem] in didFinishLaunching. JS isn't
//     running yet, so the action is kept until JS asks for it
//     (takePendingQuickAction).
//   - warm launch: application(_:performActionFor:completionHandler:). Sent to
//     JS as "onQuickAction" when JS is listening, else kept like a cold one.
// ExpoAppDelegate always returns true from didFinishLaunching, and iOS then
// ALSO calls performActionFor for the item it launched the app with (Apple
// expects false from the launch method to suppress it). That echo is dropped
// here, so a cold launch delivers the action exactly once. Any echo arrives
// before the app first goes to the background; a genuine warm launch always
// follows one, so the flag is cleared there and can't swallow a real action.
//
// If the app ever adopts UIScene, the scene delegate receives these instead
// (connectionOptions.shortcutItem / windowScene(_:performActionFor:)) and they
// must be forwarded to QuickActionCenter.

/// Shared between the app delegate subscriber and the JS module. Main thread
/// writes, JS thread reads: everything goes through the lock.
final class QuickActionCenter {
  static let shared = QuickActionCenter()

  private let lock = NSLock()
  private var pending: String?
  /// The cold-launch item, until its performActionFor echo has been dropped.
  private var launchEcho: String?
  /// Sends an event to JS; returns false when the module is gone.
  private var emitter: ((String) -> Bool)?

  func launched(with type: String) {
    lock.lock()
    pending = type
    launchEcho = type
    lock.unlock()
  }

  /// performActionFor: to JS now if it is listening, else kept for it. (JS ignores types it doesn't know.)
  func perform(_ type: String) {
    lock.lock()
    if let echo = launchEcho, echo == type {
      // The cold launch already queued this one.
      launchEcho = nil
      lock.unlock()
      return
    }
    launchEcho = nil
    let send = emitter
    lock.unlock()
    if let send, send(type) { return }
    lock.lock()
    pending = type
    lock.unlock()
  }

  func enteredBackground() {
    lock.lock()
    launchEcho = nil
    lock.unlock()
  }

  func take() -> String? {
    lock.lock()
    defer { lock.unlock() }
    let type = pending
    pending = nil
    return type
  }

  func setEmitter(_ fn: ((String) -> Bool)?) {
    lock.lock()
    emitter = fn
    lock.unlock()
  }
}

/// Registered in expo-module.config.json ("appDelegateSubscribers").
public class QuickActionsAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    if let item = launchOptions?[.shortcutItem] as? UIApplicationShortcutItem {
      QuickActionCenter.shared.launched(with: item.type)
    }
    return true
  }

  public func application(
    _ application: UIApplication,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    QuickActionCenter.shared.perform(shortcutItem.type)
    completionHandler(true)
  }

  public func applicationDidEnterBackground(_ application: UIApplication) {
    QuickActionCenter.shared.enteredBackground()
  }
}

/// JS side: lib/quick-actions.ts (requireOptionalNativeModule('ScanKitQuickActions')).
public class QuickActionsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ScanKitQuickActions")

    Events("onQuickAction")

    OnStartObserving {
      QuickActionCenter.shared.setEmitter { [weak self] type in
        guard let self else { return false }
        self.sendEvent("onQuickAction", ["type": type])
        return true
      }
    }

    OnStopObserving {
      QuickActionCenter.shared.setEmitter(nil)
    }

    OnDestroy {
      QuickActionCenter.shared.setEmitter(nil)
    }

    /// The action the app was launched with (or one that arrived while JS
    /// wasn't listening), once: it is cleared as it is read.
    Function("takePendingQuickAction") { () -> String? in
      QuickActionCenter.shared.take()
    }

    /// True while something other than a navigation screen is presented on top
    /// (a React Native Modal — every bottom sheet —, an alert or action sheet, a
    /// share sheet, a picker). A screen presented then fails silently on iOS, so
    /// a quick action must not navigate.
    AsyncFunction("isOverlayPresented") { () -> Bool in
      let windows = UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .flatMap { $0.windows }
      guard let root = (windows.first { $0.isKeyWindow } ?? windows.first)?.rootViewController else { return false }
      var vc = root.presentedViewController
      while let current = vc {
        // react-native-screens' own modals (fullScreenModal routes) are RNS*.
        let name = NSStringFromClass(type(of: current))
        if !name.hasPrefix("RNS") { return true }
        vc = current.presentedViewController
      }
      return false
    }.runOnQueue(.main)
  }
}
