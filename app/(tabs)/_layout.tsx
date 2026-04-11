// app/(tabs)/_layout.tsx
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Tabs, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScanProvider, useScan } from '@/contexts/scan-context';
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

function FloatingTabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const { isDark, colors } = useTheme();
  const { triggerScan } = useScan();

  return (
    <View
      style={[
        styles.floatingBar,
        {
          bottom: insets.bottom + 8,
          left: screenWidth * 0.05,
          right: screenWidth * 0.05,
          backgroundColor: isDark ? 'rgba(18,18,18,0.92)' : 'rgba(248,248,248,0.92)',
          borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)',
        },
      ]}
    >
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
              <View style={[styles.scanCircle, { backgroundColor: colors.accent, shadowColor: colors.accent }]}>
                <Ionicons name="camera" size={34} color="#fff" />
              </View>
            </Pressable>
          );
        }

        const color = isFocused ? colors.accent : isDark ? '#666' : '#aaa';

        return (
          <Pressable
            key={route.key}
            onPress={() => { if (!isFocused) navigation.navigate(route.name); }}
            style={styles.tabBtn}
          >
            <Ionicons name={TAB_ICONS[route.name] ?? 'help-circle'} size={22} color={color} />
            <Text style={[styles.tabLabel, { color }]}>{TAB_LABELS[route.name] ?? route.name}</Text>
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
  return (
    <ScanProvider>
      <TabsInner />
    </ScanProvider>
  );
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
