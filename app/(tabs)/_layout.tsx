// app/(tabs)/_layout.tsx
import { useCallback } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Tabs, useRouter } from 'expo-router';
import type { BottomTabBarButtonProps } from '@react-navigation/bottom-tabs';
import * as Crypto from 'expo-crypto';
import { ScanProvider, useScan } from '@/contexts/scan-context';
import { ScanNameSheet } from '@/components/scan-name-sheet';
import { Document, PageFilter } from '@/types/document';
import { saveDocument } from '@/lib/storage';
import { copyPageWithQuality, copyPdfToStorage } from '@/lib/files';

// Rendered inside ScanProvider so useScan() works.
function ScanTabButton(props: BottomTabBarButtonProps) {
  const { triggerScan } = useScan();
  return (
    <Pressable
      onPress={triggerScan}
      style={[props.style, styles.scanBtn]}
      accessibilityLabel="Scan document"
    >
      <View style={styles.scanCircle}>
        <Text style={styles.scanIcon}>📷</Text>
      </View>
    </Pressable>
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

  return (
    <>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarStyle: styles.tabBar,
          tabBarActiveTintColor: '#0a7ea4',
          tabBarInactiveTintColor: '#666',
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Home',
            tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>🏠</Text>,
          }}
        />
        <Tabs.Screen
          name="files"
          options={{
            title: 'Files',
            tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>🗂</Text>,
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
            tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>🔧</Text>,
          }}
        />
        <Tabs.Screen
          name="me"
          options={{
            title: 'Me',
            tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>👤</Text>,
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
  tabBar: {
    backgroundColor: '#1a1a1a',
    borderTopColor: '#222',
    height: 64,
  },
  scanBtn: {
    justifyContent: 'center',
    alignItems: 'center',
    top: -16,
  },
  scanCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#0a7ea4',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0a7ea4',
    shadowOpacity: 0.5,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  scanIcon: { fontSize: 24 },
});
