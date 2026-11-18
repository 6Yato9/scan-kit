// lib/alert-guard.ts
// Stops buttons in a native alert from doing anything while App Lock is on.
//
// The lock covers screens by pushing the /lock route (components/lock-gate.tsx).
// native-stack dismisses whatever system UI is shown over the top screen before
// it shows /lock (share sheet, print dialog, action sheet, photo picker), so
// none of these stay above the lock. React Native's Alert is the exception. iOS
// shows it in a separate UIWindow above the app's own window
// (RCTAlertController: windowLevel = UIWindowLevelAlert + 1), so nothing in the
// app can cover it and JS has no way to close it. An alert that was open when
// the app went to the background, such as "Delete this page?", is still showing
// above the lock screen afterwards.
//
// We can't hide that alert, but we can make its buttons do nothing while the
// app is locked. Every Alert.alert / Alert.prompt goes through this guard. A
// button pressed while locked just closes the alert, as Cancel would. Once the
// user has unlocked, buttons work normally again. An alert RAISED while locked
// (work that failed behind the lock screen) is held until the app is unlocked
// and the lock screen has gone (AlertHold), so it can't sit above the lock.
import { Alert } from 'react-native';

type AnyFn = (...args: unknown[]) => unknown;
type Button = { onPress?: AnyFn } & Record<string, unknown>;

// The latest `isLocked` passed to installAlertGuard. Kept on Alert itself so a
// module reloaded in development patches Alert once and still reads the
// current lock state.
type GuardState = { isLocked: () => boolean; hold?: AlertHold };
type Guarded = { __lockGuard?: GuardState };

/** Wraps one button's onPress so that it does nothing while `isLocked()` is true. */
function guardButton<T extends Button>(button: T, isLocked: () => boolean): T {
  if (!button || typeof button.onPress !== 'function') return button;
  const onPress = button.onPress;
  return { ...button, onPress: (...args: unknown[]) => (isLocked() ? undefined : onPress(...args)) };
}

/** Exported for tests: wraps an Alert.alert / Alert.prompt buttons argument. */
export function guardAlertButtons(buttons: unknown, isLocked: () => boolean): unknown {
  if (typeof buttons === 'function') {
    // Alert.prompt(title, message, callback)
    const fn = buttons as AnyFn;
    return (...args: unknown[]) => (isLocked() ? undefined : fn(...args));
  }
  if (Array.isArray(buttons)) return buttons.map(b => guardButton(b as Button, isLocked));
  return buttons;
}

/**
 * Optional: hold alerts raised while locked. `hold()` says whether an alert
 * raised right now must wait; `later(show)` runs `show` once it may appear
 * (LockGate passes lib/nav-guard's isNavigationHeld / navigateWhenUnlocked).
 * Without it an alert raised behind the lock screen ("Couldn't export" from
 * work that failed while locked) would sit above the lock until dismissed.
 */
export type AlertHold = { hold: () => boolean; later: (show: () => void) => void };

/**
 * Installs the guard for the whole app; calling it again only replaces
 * `isLocked` (and `hold`). `isLocked` must answer synchronously: it is read at
 * the moment a button is pressed.
 */
export function installAlertGuard(isLocked: () => boolean, hold?: AlertHold): void {
  const target = Alert as unknown as Guarded & { alert: AnyFn; prompt?: AnyFn };
  if (target.__lockGuard) {
    target.__lockGuard.isLocked = isLocked;
    target.__lockGuard.hold = hold;
    return;
  }
  const state: GuardState = { isLocked, hold };
  target.__lockGuard = state;
  const locked = () => state.isLocked();
  const present = (show: () => void) => {
    if (state.hold?.hold()) state.hold.later(show);
    else show();
  };
  const alert = target.alert.bind(Alert);
  target.alert = (title, message, buttons, ...rest) => {
    present(() => alert(title, message, guardAlertButtons(buttons, locked), ...rest));
  };
  if (typeof target.prompt === 'function') {
    const prompt = target.prompt.bind(Alert);
    target.prompt = (title, message, callbackOrButtons, ...rest) => {
      present(() => prompt(title, message, guardAlertButtons(callbackOrButtons, locked), ...rest));
    };
  }
}
