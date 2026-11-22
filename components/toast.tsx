// components/toast.tsx
// Lightweight toast: a provider + useToast() hook exposing show(message).
// Uses React Native's built-in Animated API (no reanimated). The toast fades
// and slides in near the bottom, rests ~1.8 s, then fades out. A toast with an
// action (Undo, Open) rests 6 s, long enough to read it and reach the button,
// and 10 s while VoiceOver is running, so the button can still be reached by
// swiping to it.
//
// Where it sits: by default `offset` above the bottom safe area (the tab bar);
// a screen with its own bottom bar claims a spot just above it with
// useToastAnchor (ToolScreen does, for its pinned footer), and the viewer
// passes `bottom` to keep it above its toolbar, never on it.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AccessibilityInfo, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { Colors } from '@/lib/theme';

/** Optional trailing button, e.g. Undo after a delete. Keeps the toast up longer. */
export type ToastAction = { label: string; onPress: () => void };
type ToastOptions = {
  action?: ToastAction;
  /** An Undo after an edit that changed or removed something: the action stays up longer (ACTION_VISIBLE_MS_LONG). */
  long?: boolean;
};

/** Claims the toast's position (distance of its bottom edge above the screen's bottom); returns the release. */
type ClaimAnchor = (bottom: number) => () => void;
type ToastContextType = { show: (message: string, options?: ToastOptions) => void; claimAnchor?: ClaimAnchor };

const ToastContext = createContext<ToastContextType | null>(null);

export const VISIBLE_MS = 1800;
/** Long enough to read the message and reach for the action. */
export const ACTION_VISIBLE_MS = 6000;
/** VoiceOver reads the message first, then the user swipes to the action. */
export const ACTION_VISIBLE_MS_SCREEN_READER = 10000;
/** `long` toasts (Undo after a destructive edit): time to notice the change, then reach Undo. */
export const ACTION_VISIBLE_MS_LONG = 10000;
export const ACTION_VISIBLE_MS_LONG_SCREEN_READER = 15000;

export function ToastProvider({
  children,
  offset = 140,
  bottom = null,
  onChrome = false,
}: {
  children: ReactNode;
  /** Distance above the bottom safe area. Raise it to clear a screen's own bottom bar. */
  offset?: number;
  /**
   * When set, the toast's bottom edge sits this far above the bottom of the
   * screen instead, whatever a screen claimed. The viewer sets it just above
   * its toolbar, so a toast never covers (or blocks) the toolbar's buttons.
   */
  bottom?: number | null;
  /**
   * Over the always-dark viewer chrome: the chrome's own raised pill with a
   * hairline edge, matching the viewer's other overlays in both themes.
   */
  onChrome?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const [message, setMessage] = useState<string | null>(null);
  const [action, setAction] = useState<ToastAction | null>(null);

  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(20)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The action stays on screen (and pressable) while the toast fades out, so a
  // quick second tap must not run it again — Undo twice would restore twice.
  const actionUsed = useRef(false);
  const screenReader = useRef(false);
  // A screen's own bottom bar (useToastAnchor); the latest claim wins.
  const [anchor, setAnchor] = useState<{ id: number; bottom: number } | null>(null);
  const anchorSeq = useRef(0);
  const claimAnchor = useCallback<ClaimAnchor>(at => {
    const id = ++anchorSeq.current;
    setAnchor({ id, bottom: at });
    return () => setAnchor(a => (a && a.id === id ? null : a));
  }, []);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isScreenReaderEnabled()
      .then(on => { if (alive) screenReader.current = on; })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', on => { screenReader.current = on; });
    return () => {
      alive = false;
      sub?.remove();
    };
  }, []);

  const hide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    Animated.parallel([
      Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 20, duration: 220, useNativeDriver: true }),
    ]).start(({ finished }) => {
      if (finished) {
        setMessage(null);
        setAction(null);
      }
    });
  }, [opacity, translateY]);

  const show = useCallback((msg: string, options?: ToastOptions) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setMessage(msg);
    setAction(options?.action ?? null);
    actionUsed.current = false;
    AccessibilityInfo.announceForAccessibility(msg);
    opacity.setValue(0);
    translateY.setValue(20);
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start();

    const visible = options?.action
      ? options.long
        ? (screenReader.current ? ACTION_VISIBLE_MS_LONG_SCREEN_READER : ACTION_VISIBLE_MS_LONG)
        : (screenReader.current ? ACTION_VISIBLE_MS_SCREEN_READER : ACTION_VISIBLE_MS)
      : VISIBLE_MS;
    hideTimer.current = setTimeout(hide, visible);
  }, [opacity, translateY, hide]);

  useEffect(() => {
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  // The action is always tinted, like a link: the accent that reads on the
  // pill — the viewer chrome's accent there, else the other theme's accent
  // (the pill is the inverse surface: dark in light mode, light in dark mode).
  const actionColor = onChrome ? colors.chromeAccent : Colors[isDark ? 'light' : 'dark'].accent;

  return (
    <ToastContext.Provider value={{ show, claimAnchor }}>
      {children}
      {message !== null && (
        <Animated.View
          pointerEvents={action ? 'box-none' : 'none'}
          collapsable={false}
          style={[
            styles.wrapper,
            { bottom: bottom ?? anchor?.bottom ?? insets.bottom + offset },
            { opacity, transform: [{ translateY }] },
          ]}
        >
          <View
            style={[
              styles.toast,
              // Inverse surface: dark pill in light mode, light pill in dark mode.
              onChrome
                ? { backgroundColor: colors.chromeRaised, borderColor: colors.chromeBorder, borderWidth: StyleSheet.hairlineWidth, shadowColor: colors.shadow }
                : { backgroundColor: colors.text, shadowColor: colors.shadow },
            ]}
          >
            <Text
              maxFontSizeMultiplier={1.4}
              numberOfLines={2}
              style={[styles.text, action && styles.textWithAction, { color: onChrome ? colors.chromeText : colors.bg }]}
            >
              {message}
            </Text>
            {action && (
              <Pressable
                onPress={() => {
                  if (actionUsed.current) return;
                  actionUsed.current = true;
                  const fn = action.onPress;
                  hide();
                  fn();
                }}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.6 }]}
              >
                <Text maxFontSizeMultiplier={1.4} style={[styles.text, styles.actionText, { color: actionColor }]}>
                  {action.label}
                </Text>
              </Pressable>
            )}
          </View>
        </Animated.View>
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

const noClaim: ClaimAnchor = () => () => {};

/**
 * For a screen with its own bottom bar: `claim(bottom)` puts the app's toasts
 * with their bottom edge `bottom` points above the screen's bottom, until the
 * returned release is called (on blur). Outside a provider it does nothing.
 */
export function useToastAnchor(): ClaimAnchor {
  return useContext(ToastContext)?.claimAnchor ?? noClaim;
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  toast: {
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 11,
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  text: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  textWithAction: { textAlign: 'left', flexShrink: 1 },
  actionBtn: { marginLeft: 16, minHeight: 24, justifyContent: 'center' },
  actionText: { fontWeight: '800' },
});
