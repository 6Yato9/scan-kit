// app/(tabs)/_layout.tsx
import { useCallback } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { Tabs, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { BottomTabBarButtonProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Crypto from 'expo-crypto';
import { ScanProvider, useScan } from '@/contexts/scan-context';
import { useTheme } from '@/contexts/theme-context';
import { ScanNameSheet } from '@/components/scan-name-sheet';
import { Document, PageFilter } from '@/types/document';
import { saveDocument } from '@/lib/storage';
import { copyPageWithQuality, copyPdfToStorage } from '@/lib/files';

// Rendered inside ScanProvider so useScan() works.
function ScanTabButton(props: BottomTabBarButtonProps) {
  const { triggerScan } = useScan();
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={triggerScan}
      style={[props.style, styles.scanBtn]}
      accessibilityLabel="Scan document"
    >
      <View style={[styles.scanCircle, { backgroundColor: colors.accent, shadowColor: colors.accent }]}>
        <Ionicons name="camera" size={26} color="#fff" />
      </View>
    </Pressable>
  );
}

// Inner wrapper: has access to ScanContext to render ScanNameSheet.
function TabsWithScanSheet() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { isDark, colors } = useTheme();
  const {
    pendingPages,
    pendingPdfUri,
    pendingQuality,
    pendingDefaultFilter,
    nameSheetVisible,
    clearPending,
    triggerScan,
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

  const handleRetake = useCallback(() => {
    clearPending();
    setTimeout(triggerScan, 350);
  }, [clearPending, triggerScan]);

  const glassBar = {
    position: 'absolute' as const,
    bottom: insets.bottom + 8,
    left: 12,
    right: 12,
    borderRadius: 26,
    height: 64,
    backgroundColor: isDark ? 'rgba(18,18,18,0.92)' : 'rgba(248,248,248,0.92)',
    borderTopWidth: 0,
    borderWidth: 0.5,
    borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)',
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 14,
    overflow: 'visible' as const,
  };

  return (
    <>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarStyle: glassBar,
          tabBarActiveTintColor: colors.accent,
          tabBarInactiveTintColor: isDark ? '#666' : '#aaa',
          tabBarLabelStyle: { fontSize: 10, marginBottom: 4 },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Home',
            tabBarIcon: ({ color, size }) => <Ionicons name="home" size={size} color={color} />,
          }}
        />
        <Tabs.Screen
          name="files"
          options={{
            title: 'Files',
            tabBarIcon: ({ color, size }) => <Ionicons name="document-text" size={size} color={color} />,
          }}
        />
        <Tabs.Screen
          name="scan"
          options={{
            title: '',
            tabBarButton: (props) => <ScanTabButton {...props} />,
          }}
        />
        <Tabs.Screen
          name="tools"
          options={{
            title: 'Tools',
            tabBarIcon: ({ color, size }) => <Ionicons name="grid" size={size} color={color} />,
          }}
        />
        <Tabs.Screen
          name="me"
          options={{
            title: 'Me',
            tabBarIcon: ({ color, size }) => <Ionicons name="person" size={size} color={color} />,
          }}
        />
      </Tabs>

      <ScanNameSheet
        visible={nameSheetVisible}
        pageCount={pendingPdfUri ? 1 : pendingPages.length}
        onSave={handleSave}
        onRetake={handleRetake}
        onClose={clearPending}
      />
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
  scanBtn: {
    justifyContent: 'center',
    alignItems: 'center',
    top: -18,
  },
  scanCircle: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.5,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
});
