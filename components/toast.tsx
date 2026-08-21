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
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';

type ToastContextType = { show: (message: string) => void };

const ToastContext = createContext<ToastContextType | null>(null);

const VISIBLE_MS = 1800;

export function ToastProvider({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const { isDark } = useTheme();
  const [message, setMessage] = useState<string | null>(null);

  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(20)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((msg: string) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setMessage(msg);
    opacity.setValue(0);
    translateY.setValue(20);
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start();

    hideTimer.current = setTimeout(() => {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: 20, duration: 220, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) setMessage(null);
      });
    }, VISIBLE_MS);
  }, [opacity, translateY]);

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
          pointerEvents="none"
          style={[
            styles.wrapper,
            { bottom: insets.bottom + 96, opacity, transform: [{ translateY }] },
          ]}
        >
          <View
            style={[
              styles.toast,
              { backgroundColor: isDark ? 'rgba(245,245,245,0.96)' : 'rgba(28,28,30,0.94)' },
            ]}
          >
            <Text
              allowFontScaling={false}
              numberOfLines={2}
              style={[styles.text, { color: isDark ? '#1a1a1a' : '#fff' }]}
            >
              {message}
            </Text>
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
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 11,
    shadowColor: '#000',
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
});
