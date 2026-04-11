// app/(tabs)/_layout.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Tabs, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useScan } from '@/contexts/scan-context';
import { useTheme } from '@/contexts/theme-context';

const TAB_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  index: 'home',
  files: 'document-text',
  tools: 'grid',
  me: 'settings-outline',
};

const TAB_LABELS: Record<string, string> = {
  index: 'Home',
  files: 'Files',
  tools: 'Tools',
  me: 'Settings',
};

// Number of routes including the non-navigable scan button
const ROUTE_COUNT = 5;

function FloatingTabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const { isDark, colors } = useTheme();
  const { triggerScan } = useScan();

  // Glass selector animation state
  const barWidthRef = useRef(0);
  const [tabWidth, setTabWidth] = useState(0);
  const selectorX = useRef(new Animated.Value(-200)).current;
  const selectorOpacity = useRef(new Animated.Value(0)).current;
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialised = useRef(false);

  const moveSelectorTo = useCallback(
    (routeIndex: number, animated: boolean) => {
      if (barWidthRef.current === 0) return;
      const tw = barWidthRef.current / ROUTE_COUNT;
      const targetX = routeIndex * tw;

      if (fadeTimer.current) clearTimeout(fadeTimer.current);

      selectorOpacity.setValue(1);

      if (animated) {
        Animated.spring(selectorX, {
          toValue: targetX,
          useNativeDriver: true,
          damping: 22,
          stiffness: 260,
          mass: 0.75,
        }).start();
      } else {
        selectorX.setValue(targetX);
      }

      // Fade to a subtle "resting outline" after 500 ms
      fadeTimer.current = setTimeout(() => {
        Animated.timing(selectorOpacity, {
          toValue: 0.38,
          duration: 280,
          useNativeDriver: true,
        }).start();
      }, 500);
    },
    [selectorX, selectorOpacity],
  );

  // Initialise once the bar has been laid out
  const onBarLayout = useCallback(
    (e: { nativeEvent: { layout: { width: number } } }) => {
      const w = e.nativeEvent.layout.width;
      if (w === barWidthRef.current) return; // nothing changed
      barWidthRef.current = w;
      setTabWidth(w / ROUTE_COUNT);

      if (!initialised.current) {
        initialised.current = true;
        moveSelectorTo(state.index, false);
      }
    },
    [moveSelectorTo, state.index],
  );

  // Animate to newly focused tab
  useEffect(() => {
    if (initialised.current) {
      moveSelectorTo(state.index, true);
    }
  }, [state.index, moveSelectorTo]);

  return (
    <View
      onLayout={onBarLayout}
      style={[
        styles.floatingBar,
        {
          bottom: insets.bottom + 8,
          left: screenWidth * 0.05,
          right: screenWidth * 0.05,
          backgroundColor: isDark ? 'rgba(18,18,18,0.93)' : 'rgba(248,248,248,0.93)',
          borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)',
        },
      ]}
    >
      {/* ── Glass selector (absolutely positioned, behind tab icons) ── */}
      {tabWidth > 0 && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.glassSelector,
            {
              width: tabWidth - 8,   // slight inset so it doesn't touch neighbours
              backgroundColor: isDark
                ? 'rgba(255,255,255,0.13)'
                : 'rgba(0,0,0,0.09)',
              borderColor: isDark
                ? 'rgba(255,255,255,0.22)'
                : 'rgba(0,0,0,0.14)',
              opacity: selectorOpacity,
              transform: [
                {
                  translateX: Animated.add(selectorX, new Animated.Value(4)),
                },
              ],
            },
          ]}
        />
      )}

      {/* ── Tab buttons ── */}
      {state.routes.map((route, index) => {
        const isFocused = state.index === index;

        if (route.name === 'scan') {
          return (
            <Pressable
              key={route.key}
              onPress={triggerScan}
              style={styles.scanBtn}
              accessibilityLabel="Scan document"
            >
              <View
                style={[
                  styles.scanCircle,
                  { backgroundColor: colors.accent, shadowColor: colors.accent },
                ]}
              >
                <Ionicons name="camera" size={34} color="#fff" />
              </View>
            </Pressable>
          );
        }

        const color = isFocused ? colors.accent : isDark ? '#666' : '#aaa';

        return (
          <Pressable
            key={route.key}
            onPress={() => {
              if (!isFocused) navigation.navigate(route.name);
            }}
            style={styles.tabBtn}
          >
            <Ionicons
              name={TAB_ICONS[route.name] ?? 'help-circle'}
              size={22}
              color={color}
            />
            <Text style={[styles.tabLabel, { color }]}>
              {TAB_LABELS[route.name] ?? route.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function TabsInner() {
  const router = useRouter();
  const { reviewVisible } = useScan();

  useEffect(() => {
    if (reviewVisible) {
      router.push('/review');
    }
  }, [reviewVisible, router]);

  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="files" />
      <Tabs.Screen name="scan" />
      <Tabs.Screen name="tools" />
      <Tabs.Screen name="me" />
    </Tabs>
  );
}

export default function TabLayout() {
  return <TabsInner />;
}

const styles = StyleSheet.create({
  floatingBar: {
    position: 'absolute',
    height: 64,
    borderRadius: 26,
    borderWidth: 0.5,
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 14,
    overflow: 'visible',
    flexDirection: 'row',
    alignItems: 'center',
  },
  // Absolutely positioned glass pill behind the active tab
  glassSelector: {
    position: 'absolute',
    top: 6,
    bottom: 6,
    // Inner radius = bar radius (26) minus vertical inset (6) so the curve
    // is concentric with the nav bar's own corners.
    borderRadius: 20,
    borderWidth: 1,
  },
  tabBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  tabLabel: {
    fontSize: 10,
    marginBottom: 4,
  },
  scanBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    top: -22,
  },
  scanCircle: {
    width: 75,
    height: 75,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.5,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
});
