// components/toast.tsx
// Lightweight toast: a provider + useToast() hook exposing show(message).
// Uses React Native's built-in Animated API (no reanimated). The toast fades
// and slides in near the bottom, rests ~1.8s, then fades out.
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

/** Optional trailing button, e.g. Undo after a delete. Keeps the toast up longer. */
export type ToastAction = { label: string; onPress: () => void };
type ToastOptions = { action?: ToastAction };

type ToastContextType = { show: (message: string, options?: ToastOptions) => void };

const ToastContext = createContext<ToastContextType | null>(null);

const VISIBLE_MS = 1800;
/** Long enough to read the message and reach for the action. */
const ACTION_VISIBLE_MS = 5000;

export function ToastProvider({
  children,
  offset = 140,
  onChrome = false,
}: {
  children: ReactNode;
  /** Distance above the bottom safe area. Raise it to clear a screen's own bottom bar. */
  offset?: number;
  /** Over the always-dark viewer chrome: a light pill, so it stands out in both themes. */
  onChrome?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [message, setMessage] = useState<string | null>(null);
  const [action, setAction] = useState<ToastAction | null>(null);

  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(20)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    AccessibilityInfo.announceForAccessibility(msg);
    opacity.setValue(0);
    translateY.setValue(20);
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start();

    hideTimer.current = setTimeout(hide, options?.action ? ACTION_VISIBLE_MS : VISIBLE_MS);
  }, [opacity, translateY, hide]);

  useEffect(() => {
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {message !== null && (
        <Animated.View
          pointerEvents={action ? 'box-none' : 'none'}
          style={[
            styles.wrapper,
            { bottom: insets.bottom + offset, opacity, transform: [{ translateY }] },
          ]}
        >
          <View
            style={[
              styles.toast,
              // Inverse surface: dark pill in light mode, light pill in dark mode.
              { backgroundColor: onChrome ? colors.chromeText : colors.text, shadowColor: colors.shadow },
            ]}
          >
            <Text
              maxFontSizeMultiplier={1.4}
              numberOfLines={2}
              style={[styles.text, action && styles.textWithAction, { color: onChrome ? colors.chrome : colors.bg }]}
            >
              {message}
            </Text>
            {action && (
              <Pressable
                onPress={() => {
                  const fn = action.onPress;
                  hide();
                  fn();
                }}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.6 }]}
              >
                <Text maxFontSizeMultiplier={1.4} style={[styles.text, styles.actionText, { color: onChrome ? colors.chrome : colors.bg }]}>
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
