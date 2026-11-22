// modules/system-chrome: Android-only window chrome (see android/build.gradle).
// Absent on iOS and in builds made before it existed: every call is optional.
import { requireOptionalNativeModule } from 'expo';

type SystemChromeNative = {
  setNavigationBarStyle?: (style: 'light' | 'dark') => boolean;
  setRecentsPrivacy?: (on: boolean) => boolean;
  addListener?: (event: 'onActivityVisibility', listener: (e: { visible?: boolean }) => void) => { remove: () => void };
};

const SystemChrome = requireOptionalNativeModule<SystemChromeNative>('SystemChrome');

/**
 * The navigation bar's buttons for the screen on top: 'light' over a dark
 * screen, 'dark' over a light one (the same meaning as StatusBar's style).
 * Returns false when this build can't set it (iOS, an older Android build).
 */
export function setNavigationBarStyle(style: 'light' | 'dark'): boolean {
  const fn = SystemChrome?.setNavigationBarStyle;
  if (typeof fn !== 'function') return false;
  try {
    return fn(style) !== false;
  } catch {
    return false;
  }
}

/**
 * App Lock is on: keep documents out of the Recents card (Android 13+), or
 * out of every snapshot, screenshot and recording below that (FLAG_SECURE).
 * Returns false when this build can't (iOS, an older Android build).
 */
export function setRecentsPrivacy(on: boolean): boolean {
  const fn = SystemChrome?.setRecentsPrivacy;
  if (typeof fn !== 'function') return false;
  try {
    return fn(on) !== false;
  } catch {
    return false;
  }
}

/** True when this build reports the activity being stopped / started (Android). */
export function hasActivityVisibility(): boolean {
  return typeof SystemChrome?.setRecentsPrivacy === 'function' && typeof SystemChrome?.addListener === 'function';
}

/**
 * Calls `fn(false)` when the app's activity is stopped (nothing of the app
 * is visible any more: Home, Recents, another app, screen off, or a
 * full-screen activity the app opened) and `fn(true)` when it is visible
 * again. Not called for a dialog or sheet drawn over the app (a permission
 * prompt, the share chooser), unlike AppState's "background". Returns an
 * unsubscribe function (a no-op when unavailable).
 */
export function addActivityVisibilityListener(fn: (visible: boolean) => void): () => void {
  if (!hasActivityVisibility()) return () => {};
  try {
    const sub = SystemChrome!.addListener!('onActivityVisibility', e => fn(e?.visible !== false));
    return () => sub.remove();
  } catch {
    return () => {};
  }
}
