// modules/system-chrome: Android-only window chrome (see android/build.gradle).
// Absent on iOS and in builds made before it existed: every call is optional.
import { requireOptionalNativeModule } from 'expo';

type SystemChromeNative = {
  setNavigationBarStyle?: (style: 'light' | 'dark') => boolean;
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
