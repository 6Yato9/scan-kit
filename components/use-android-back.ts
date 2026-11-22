// components/use-android-back.ts
// Android's back button / back gesture for a screen with something to lose.
//
// iOS has no such button (BackHandler never fires there), so none of this
// changes iOS. On Android the system back closes the top screen, and on a
// fullScreenModal or a tool screen that silently threw away work the screen's
// own Cancel or Back would have asked about (a drawn signature, redaction
// boxes, a captured ID card).
//
// The handler is registered only while the screen is focused: a screen
// further down the stack must not answer the back press meant for the screen
// on top of it (BackHandler calls the newest listener first, whatever screen
// it belongs to). RN Modals (bottom sheets, the crop editor) get the back
// press through their own onRequestClose before any of this.
import { useCallback, useRef } from 'react';
import { Alert, BackHandler, Platform } from 'react-native';
import { useFocusEffect } from 'expo-router';

/**
 * Calls `onBack` on Android's back press while the screen is focused and
 * `enabled`. Return true when handled (the screen stays), false to let the
 * navigator go back as usual.
 */
export function useAndroidBack(onBack: () => boolean, enabled = true) {
  const latest = useRef(onBack);
  latest.current = onBack;
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android' || !enabled) return;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => latest.current());
      return () => sub.remove();
    }, [enabled]),
  );
}

export type DiscardPrompt = {
  /** "Discard your signature?" */
  title: string;
  /** What will be lost, in a sentence. */
  message: string;
  /** Destructive button (default "Discard"). */
  discardLabel?: string;
  /** Cancel button (default "Keep editing"). */
  keepLabel?: string;
};

/** Asks before discarding; `onDiscard` runs only on the destructive choice. */
export function confirmDiscard(prompt: DiscardPrompt, onDiscard: () => void) {
  Alert.alert(prompt.title, prompt.message, [
    { text: prompt.keepLabel ?? 'Keep editing', style: 'cancel' },
    { text: prompt.discardLabel ?? 'Discard', style: 'destructive', onPress: onDiscard },
  ]);
}
