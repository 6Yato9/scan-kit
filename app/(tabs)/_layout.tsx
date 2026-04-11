// app/(tabs)/_layout.tsx
import { useCallback, useEffect } from 'react';
import { Alert, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Tabs, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Crypto from 'expo-crypto';
import { ScanProvider, useScan } from '@/contexts/scan-context';
import { useTheme } from '@/contexts/theme-context';
import { Document, PageFilter } from '@/types/document';
import { saveDocument } from '@/lib/storage';
import { copyPageWithQuality, copyPdfToStorage } from '@/lib/files';
import { autoName } from '@/lib/auto-name';

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

// Custom tab bar renders its own absolutely-positioned View so left/right
// values apply to the actual visible element, not a React Navigation wrapper.
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

// Inner wrapper: has access to ScanContext to render ScanNameSheet.
function TabsWithScanSheet() {
  const router = useRouter();
  const {
    pendingPages,
    pendingPdfUri,
    pendingQuality,
    pendingDefaultFilter,
    nameSheetVisible,
    clearPending,
    bumpLastSaved,
  } = useScan();

  const handleSave = useCallback(
    async (name: string) => {
      try {
        const id = Crypto.randomUUID();
        const now = Date.now();
        let doc: Document;

        if (pendingPdfUri) {
          const storedUri = copyPdfToStorage(pendingPdfUri, id);
          doc = { id, name, pages: [], pdfUri: storedUri, createdAt: now, updatedAt: now };
        } else {
          const savedPages = await Promise.all(
            pendingPages.map((uri, i) => copyPageWithQuality(uri, id, i, pendingQuality))
          );
          const filters: PageFilter[] = savedPages.map(() => pendingDefaultFilter as PageFilter);
          const allOriginal = filters.every(f => f === 'original');
          doc = {
            id,
            name,
            pages: savedPages,
            filters: allOriginal ? undefined : filters,
            createdAt: now,
            updatedAt: now,
          };
        }

        await saveDocument(doc);
        bumpLastSaved();
        clearPending();
        router.navigate('/(tabs)/files');
      } catch (err) {
        console.error('Save failed', err);
        Alert.alert('Save Failed', 'Could not save document. Please try again.');
      }
    },
    [pendingPages, pendingPdfUri, pendingQuality, pendingDefaultFilter, clearPending, bumpLastSaved, router]
  );

  // Auto-save with a generated name — no popup needed.
  useEffect(() => {
    if (nameSheetVisible) {
      handleSave(autoName());
    }
  }, [nameSheetVisible]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
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
    </>
  );
}

export default function TabLayout() {
  return (
    <ScanProvider>
      <TabsWithScanSheet />
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
