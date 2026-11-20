// lib/platform-support.ts
// Android port, phase 0: features whose native code exists only on iOS so far
// (modules/vision-ocr is an Apple-only module). On iOS a missing native
// function means a build older than the feature, hence "update Scan Kit";
// on Android it means the feature isn't built for Android yet, which is what
// the user should read there instead.
import { Platform } from 'react-native';

export type UnavailableCopy = { title: string; text: string };

/** True on Android, where the iOS-only native features are missing. */
export function isAndroid(): boolean {
  return Platform.OS === 'android';
}

/**
 * The "this feature is missing" copy for this platform: `ios` (an older
 * build) everywhere but Android, where it says the feature is coming.
 */
export function unavailableCopy(ios: UnavailableCopy, feature: string): UnavailableCopy {
  if (!isAndroid()) return ios;
  return {
    title: `${feature} isn’t available on Android yet`,
    text: 'It’s coming in a later version of Scan Kit for Android. Your documents are unchanged.',
  };
}
