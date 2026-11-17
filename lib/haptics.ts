// lib/haptics.ts
// Thin, crash-safe wrappers over expo-haptics. Haptics can fail or be
// unsupported (web, some devices); every call swallows both the synchronous
// throw path and any async promise rejection so callers can fire-and-forget.
import * as Haptics from 'expo-haptics';

export const tapLight = () => {
  try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); } catch {}
};

export const tapMedium = () => {
  try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}); } catch {}
};

export const notifySuccess = () => {
  try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}); } catch {}
};

export const notifyWarning = () => {
  try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {}); } catch {}
};

export const notifyError = () => {
  try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {}); } catch {}
};

export const selection = () => {
  try { Haptics.selectionAsync().catch(() => {}); } catch {}
};
