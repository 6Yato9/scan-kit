// app/(tabs)/_layout.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Tabs, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useScan } from '@/contexts/scan-context';
import { useTheme } from '@/contexts/theme-context';
import { selection, tapMedium } from '@/lib/haptics';
import { navigateWhenUnlocked } from '@/lib/nav-guard';

// Filled glyph for the active tab, outline for the rest.
type IconName = keyof typeof Ionicons.glyphMap;
const TAB_ICONS: Record<string, { active: IconName; inactive: IconName }> = {
  index: { active: 'home', inactive: 'home-outline' },
  files: { active: 'documents', inactive: 'documents-outline' },
  tools: { active: 'grid', inactive: 'grid-outline' },
  me: { active: 'settings', inactive: 'settings-outline' },
};

const TAB_LABELS: Record<string, string> = {
  index: 'Home',
  files: 'Files',
  tools: 'Tools',
  me: 'Settings',
};

// Number of routes including the non-navigable scan button
const ROUTE_COUNT = 5;

function FloatingTabBar({ state, navigation, descriptors }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const { colors } = useTheme();
  const { triggerScan } = useScan();
  const router = useRouter();

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

  // Clear the fade timer on unmount so it doesn't fire on unmounted Animated.Values.
  useEffect(() => {
    return () => {
      if (fadeTimer.current) {
        clearTimeout(fadeTimer.current);
        fadeTimer.current = null;
      }
    };
  }, []);

  // A screen can hide the bar (Files does while selecting, so its own action
  // bar takes this place, like the toolbar in Photos).
  const focusedOptions = descriptors[state.routes[state.index].key]?.options;
  const hidden = (focusedOptions?.tabBarStyle as { display?: string } | undefined)?.display === 'none';
  if (hidden) return null;

  return (
    <View
      onLayout={onBarLayout}
      style={[
        styles.floatingBar,
        {
          bottom: insets.bottom + 8,
          left: Math.max(16, (screenWidth - ROUTE_COUNT * 78) / 2),
          right: Math.max(16, (screenWidth - ROUTE_COUNT * 78) / 2),
          borderColor: colors.barBorder,
          shadowColor: colors.shadow,
        },
      ]}
    >
      {/* Real translucency: the system chrome material blurs whatever scrolls
          underneath, so text behind the bar never stays legible. It sits in its
          own clipped layer because the bar itself must not clip (the scan
          button rises above it). Android has no live blur; it gets a fill. */}
      <View style={styles.material} pointerEvents="none">
        {Platform.OS === 'ios' ? (
          <BlurView tint={colors.barBlurTint} intensity={100} style={StyleSheet.absoluteFill} />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.barFill }]} />
        )}
      </View>
      {/* ── Glass selector (absolutely positioned, behind tab icons) ── */}
      {tabWidth > 0 && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.glassSelector,
            {
              width: tabWidth - 8,  // 4px inset on each side
              backgroundColor: colors.barSelector,
              borderColor: colors.barSelectorBorder,
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
              onPress={async () => {
                tapMedium();
                const id = await triggerScan();
                if (id) navigateWhenUnlocked(() => router.push({ pathname: '/viewer', params: { id } }));
              }}
              style={styles.scanBtn}
              accessibilityRole="button"
              accessibilityLabel="Scan a document"
            >
              <View
                style={[
                  styles.scanCircle,
                  { backgroundColor: colors.accentFill, shadowColor: colors.accentFill },
                ]}
              >
                <Ionicons name="camera" size={30} color={colors.onAccent} />
              </View>
            </Pressable>
          );
        }

        const color = isFocused ? colors.accent : colors.muted;

        return (
          <Pressable
            key={route.key}
            onPress={() => {
              if (!isFocused) { selection(); navigation.navigate(route.name); }
            }}
            style={styles.tabBtn}
            accessibilityRole="tab"
            accessibilityState={{ selected: isFocused }}
            accessibilityLabel={TAB_LABELS[route.name] ?? route.name}
          >
            <Ionicons
              name={TAB_ICONS[route.name] ? TAB_ICONS[route.name][isFocused ? 'active' : 'inactive'] : 'ellipse-outline'}
              size={22}
              color={color}
            />
            <Text maxFontSizeMultiplier={1.2} numberOfLines={1} style={[styles.tabLabel, { color }]}>
              {TAB_LABELS[route.name] ?? route.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function TabsInner() {
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
    borderRadius: 32,
    borderWidth: StyleSheet.hairlineWidth,
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 14,
    overflow: 'visible',
    flexDirection: 'row',
    alignItems: 'center',
  },
  material: { ...StyleSheet.absoluteFillObject, borderRadius: 32, overflow: 'hidden' },
  // Absolutely positioned glass pill behind the active tab
  glassSelector: {
    position: 'absolute',
    top: 4,
    bottom: 4,
    // borderRadius = half of remaining height (64 - 8 = 56) → perfect semicircle ends
    borderRadius: 28,
    borderWidth: 1,
  },
  tabBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingTop: 2,
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 4,
  },
  scanBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    top: -22,
  },
  scanCircle: {
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.5,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
});
