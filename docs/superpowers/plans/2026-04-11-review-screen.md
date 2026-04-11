# Post-Scan Review Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-screen review screen that appears after every scan/import so the user can rename the document, apply per-page filters, rotate/delete pages, and add more pages before saving.

**Architecture:** New `app/review.tsx` fullScreenModal route. `scan-context` sets `reviewVisible=true` after scanning; a `useEffect` in `app/(tabs)/_layout.tsx` pushes `/review`. The review screen owns all local state (pages, per-page filters, name), calls `handleSave` on Done, and navigates to `/(tabs)/files`.

**Tech Stack:** React Native FlatList (vertical snap), expo-image-manipulator (rotation), react-native-document-scanner-plugin (Add Page / Crop), expo-crypto (UUID), existing `lib/` utilities.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `contexts/scan-context.tsx` | Modify | Rename `nameSheetVisible` → `reviewVisible` |
| `app/_layout.tsx` | Modify | Register `review` as fullScreenModal Stack.Screen |
| `app/(tabs)/_layout.tsx` | Modify | Replace auto-save effect with `router.push('/review')`, strip save logic |
| `app/review.tsx` | **Create** | Entire review screen |

---

## Task 1: Rename `nameSheetVisible` → `reviewVisible` in scan-context

**Files:**
- Modify: `contexts/scan-context.tsx`

- [ ] **Step 1: Update the type, state, and value in scan-context.tsx**

Replace the entire file with:

```tsx
import { createContext, useCallback, useContext, useMemo, useState, ReactNode } from 'react';
import DocumentScanner from 'react-native-document-scanner-plugin';
import { PageFilter } from '@/types/document';
import { getScanSettings } from '@/lib/storage';

type ScanContextType = {
  pendingPages: string[];
  pendingPdfUri: string | null;
  pendingQuality: number;
  pendingDefaultFilter: PageFilter | 'original';
  reviewVisible: boolean;
  lastSaved: number;
  triggerScan: () => Promise<void>;
  openImport: (pages: string[]) => Promise<void>;
  openPdfImport: (uri: string) => Promise<void>;
  clearPending: () => void;
  bumpLastSaved: () => void;
};

const QUALITY_MAP = { low: 0.5, medium: 0.75, high: 0.9 } as const;

const ScanContext = createContext<ScanContextType | null>(null);

export function ScanProvider({ children }: { children: ReactNode }) {
  const [pendingPages, setPendingPages] = useState<string[]>([]);
  const [pendingPdfUri, setPendingPdfUri] = useState<string | null>(null);
  const [pendingQuality, setPendingQuality] = useState<number>(0.9);
  const [pendingDefaultFilter, setPendingDefaultFilter] = useState<PageFilter | 'original'>('original');
  const [reviewVisible, setReviewVisible] = useState(false);
  const [lastSaved, setLastSaved] = useState(0);

  const triggerScan = useCallback(async () => {
    try {
      const settings = await getScanSettings();
      const { scannedImages } = await DocumentScanner.scanDocument({
        letUserAdjustCrop: settings.autoCrop,
      });
      if (!scannedImages?.length) return;
      setPendingPages(scannedImages);
      setPendingPdfUri(null);
      setPendingQuality(QUALITY_MAP[settings.quality]);
      setPendingDefaultFilter(settings.defaultFilter);
      setReviewVisible(true);
    } catch (err) {
      console.error('Scan failed', err);
    }
  }, []);

  const openImport = useCallback(async (pages: string[]) => {
    try {
      const settings = await getScanSettings();
      setPendingPages(pages);
      setPendingPdfUri(null);
      setPendingQuality(QUALITY_MAP[settings.quality]);
      setPendingDefaultFilter('original');
      setReviewVisible(true);
    } catch (err) {
      console.error('Import failed', err);
    }
  }, []);

  const openPdfImport = useCallback(async (uri: string) => {
    try {
      const settings = await getScanSettings();
      setPendingPages([]);
      setPendingPdfUri(uri);
      setPendingQuality(QUALITY_MAP[settings.quality]);
      setPendingDefaultFilter('original');
      setReviewVisible(true);
    } catch (err) {
      console.error('PDF import failed', err);
    }
  }, []);

  const clearPending = useCallback(() => {
    setPendingPages([]);
    setPendingPdfUri(null);
    setReviewVisible(false);
  }, []);

  const bumpLastSaved = useCallback(() => setLastSaved(Date.now()), []);

  const value = useMemo(() => ({
    pendingPages,
    pendingPdfUri,
    pendingQuality,
    pendingDefaultFilter,
    reviewVisible,
    lastSaved,
    triggerScan,
    openImport,
    openPdfImport,
    clearPending,
    bumpLastSaved,
  }), [pendingPages, pendingPdfUri, pendingQuality, pendingDefaultFilter, reviewVisible, lastSaved, triggerScan, openImport, openPdfImport, clearPending, bumpLastSaved]);

  return (
    <ScanContext.Provider value={value}>
      {children}
    </ScanContext.Provider>
  );
}

export function useScan() {
  const ctx = useContext(ScanContext);
  if (!ctx) throw new Error('useScan must be used within ScanProvider');
  return ctx;
}
```

- [ ] **Step 2: Verify no compile errors**

```bash
cd /Users/abdellah/Desktop/Programming/scan-kit && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors referencing `nameSheetVisible`.

- [ ] **Step 3: Commit**

```bash
git add contexts/scan-context.tsx
git commit -m "refactor: rename nameSheetVisible to reviewVisible in scan-context"
```

---

## Task 2: Register `review` route in root Stack

**Files:**
- Modify: `app/_layout.tsx`

- [ ] **Step 1: Add the Stack.Screen entry**

In `app/_layout.tsx`, add after the `viewer` Screen entry:

```tsx
<Stack.Screen
  name="review"
  options={{ presentation: 'fullScreenModal', headerShown: false }}
/>
```

Full file after change:

```tsx
// app/_layout.tsx
import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ThemeProvider } from '@/contexts/theme-context';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen
            name="viewer"
            options={{ presentation: 'fullScreenModal', headerShown: false }}
          />
          <Stack.Screen
            name="review"
            options={{ presentation: 'fullScreenModal', headerShown: false }}
          />
          <Stack.Screen
            name="settings/scan-settings"
            options={{ title: 'Scan Settings', presentation: 'card' }}
          />
          <Stack.Screen
            name="settings/document-settings"
            options={{ title: 'Document Settings', presentation: 'card' }}
          />
          <Stack.Screen
            name="settings/printer"
            options={{ title: 'My Printer', presentation: 'card' }}
          />
          <Stack.Screen
            name="settings/about"
            options={{ title: 'About', presentation: 'card' }}
          />
        </Stack>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add app/_layout.tsx
git commit -m "feat: register review route as fullScreenModal"
```

---

## Task 3: Update `app/(tabs)/_layout.tsx` — navigation instead of auto-save

**Files:**
- Modify: `app/(tabs)/_layout.tsx`

The current file auto-saves when `nameSheetVisible` is true. Replace that with navigation to `/review`. Also remove all save-related imports and logic — that moves into `review.tsx`.

- [ ] **Step 1: Rewrite TabsWithScanSheet**

Replace the entire `app/(tabs)/_layout.tsx` with:

```tsx
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
  }, [reviewVisible]); // eslint-disable-line react-hooks/exhaustive-deps

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
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd /Users/abdellah/Desktop/Programming/scan-kit && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/(tabs)/_layout.tsx
git commit -m "feat: navigate to /review when scan completes instead of auto-saving"
```

---

## Task 4: Create `app/review.tsx` — skeleton, top bar, save logic, PDF mode

**Files:**
- Create: `app/review.tsx`

- [ ] **Step 1: Create the file with skeleton, top bar, save logic, and PDF mode**

```tsx
// app/review.tsx
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Crypto from 'expo-crypto';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import DocumentScanner from 'react-native-document-scanner-plugin';
import { useScan } from '@/contexts/scan-context';
import { useTheme } from '@/contexts/theme-context';
import { PageFilter } from '@/types/document';
import { saveDocument } from '@/lib/storage';
import { copyPageWithQuality, copyPdfToStorage } from '@/lib/files';
import { filterStyle } from '@/lib/filters';
import { autoName } from '@/lib/auto-name';

const FILTERS: { label: string; value: PageFilter | 'original' }[] = [
  { label: 'Original', value: 'original' },
  { label: 'Enhanced', value: 'enhanced' },
  { label: 'Grayscale', value: 'grayscale' },
  { label: 'B&W', value: 'bw' },
];

export default function ReviewScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const { colors, isDark } = useTheme();
  const {
    pendingPages,
    pendingPdfUri,
    pendingQuality,
    pendingDefaultFilter,
    clearPending,
    bumpLastSaved,
    triggerScan,
  } = useScan();

  const [pages, setPages] = useState<string[]>(pendingPages);
  const [filters, setFilters] = useState<(PageFilter | 'original')[]>(
    pendingPages.map(() => pendingDefaultFilter)
  );
  const [name, setName] = useState(autoName());
  const [focusedIndex, setFocused] = useState(0);
  const [rotating, setRotating] = useState(false);
  const [saving, setSaving] = useState(false);

  const pagerRef = useRef<FlatList>(null);
  const onViewableItemsChanged = useRef(({ viewableItems }: any) => {
    if (viewableItems[0]?.index != null) {
      setFocused(viewableItems[0].index);
    }
  });
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 });

  // Approximate item height: screen minus top bar (~56) minus filter strip (~90) minus action row (~72) minus insets
  const ITEM_HEIGHT = screenHeight - 56 - insets.top - 90 - 72 - insets.bottom;

  const handleDiscard = useCallback(() => {
    clearPending();
    router.back();
  }, [clearPending, router]);

  const handleSave = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName || saving) return;
    setSaving(true);
    try {
      const id = Crypto.randomUUID();
      const now = Date.now();

      if (pendingPdfUri) {
        const storedUri = copyPdfToStorage(pendingPdfUri, id);
        await saveDocument({ id, name: trimmedName, pages: [], pdfUri: storedUri, createdAt: now, updatedAt: now });
      } else {
        const savedPages = await Promise.all(
          pages.map((uri, i) => copyPageWithQuality(uri, id, i, pendingQuality))
        );
        const allOriginal = filters.every(f => f === 'original');
        await saveDocument({
          id,
          name: trimmedName,
          pages: savedPages,
          filters: allOriginal ? undefined : (filters as PageFilter[]),
          createdAt: now,
          updatedAt: now,
        });
      }

      bumpLastSaved();
      clearPending();
      router.replace('/(tabs)/files');
    } catch (err) {
      console.error('Save failed', err);
      Alert.alert('Save Failed', 'Could not save document. Please try again.');
      setSaving(false);
    }
  }, [name, saving, pages, filters, pendingPdfUri, pendingQuality, clearPending, bumpLastSaved, router]);

  // PDF import mode: simple preview, title editable, no filters or actions
  if (pendingPdfUri) {
    return (
      <View style={[styles.container, { backgroundColor: colors.bg }]}>
        {/* Top bar */}
        <View style={[styles.topBar, { paddingTop: insets.top + 8, borderBottomColor: colors.border }]}>
          <Pressable onPress={handleDiscard} hitSlop={12} style={styles.closeBtn}>
            <Text style={[styles.closeBtnText, { color: colors.text }]}>✕</Text>
          </Pressable>
          <TextInput
            style={[styles.titleInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.input }]}
            value={name}
            onChangeText={setName}
            selectTextOnFocus
            returnKeyType="done"
          />
          <Pressable
            onPress={handleSave}
            disabled={!name.trim() || saving}
            style={[styles.doneBtn, { backgroundColor: colors.accent }, (!name.trim() || saving) && styles.doneBtnDisabled]}
          >
            {saving
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={styles.doneBtnText}>Done ✓</Text>
            }
          </Pressable>
        </View>
        <View style={styles.pdfPreview}>
          <Text style={[styles.pdfLabel, { color: colors.muted }]}>PDF Document</Text>
          <Text style={[styles.pdfSub, { color: colors.muted }]}>Tap Done to save</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      {/* ① Top bar */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8, borderBottomColor: colors.border }]}>
        <Pressable onPress={handleDiscard} hitSlop={12} style={styles.closeBtn}>
          <Text style={[styles.closeBtnText, { color: colors.text }]}>✕</Text>
        </Pressable>
        <TextInput
          style={[styles.titleInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.input }]}
          value={name}
          onChangeText={setName}
          selectTextOnFocus
          returnKeyType="done"
        />
        <Pressable
          onPress={handleSave}
          disabled={!name.trim() || saving}
          style={[styles.doneBtn, { backgroundColor: colors.accent }, (!name.trim() || saving) && styles.doneBtnDisabled]}
        >
          {saving
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={styles.doneBtnText}>Done ✓</Text>
          }
        </Pressable>
      </View>

      {/* ② Page pager — added in Task 5 */}
      <View style={{ flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' }}>
        <Text style={{ color: '#666' }}>Pager coming in Task 5</Text>
      </View>

      {/* ③ Filter strip — added in Task 6 */}
      <View style={{ height: 90, backgroundColor: colors.card, justifyContent: 'center', alignItems: 'center' }}>
        <Text style={{ color: colors.muted }}>Filter strip coming in Task 6</Text>
      </View>

      {/* ④ Action row — added in Task 7 */}
      <View style={{ height: 72 + insets.bottom, backgroundColor: colors.card, justifyContent: 'center', alignItems: 'center' }}>
        <Text style={{ color: colors.muted }}>Actions coming in Task 7</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 10,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  closeBtn: { padding: 4 },
  closeBtnText: { fontSize: 18, fontWeight: '600' },
  titleInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 14,
  },
  doneBtn: {
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minWidth: 72,
    alignItems: 'center',
  },
  doneBtnDisabled: { opacity: 0.4 },
  doneBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  pdfPreview: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pdfLabel: { fontSize: 18, fontWeight: '600', marginBottom: 8 },
  pdfSub: { fontSize: 14 },
});
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd /Users/abdellah/Desktop/Programming/scan-kit && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 3: Smoke-test manually**

Run the dev build (`npx expo run:ios`). Tap the camera button — the review screen should open as a modal with the title input and Done button. Tapping ✕ should dismiss it. Tapping Done should save and navigate to Files.

- [ ] **Step 4: Commit**

```bash
git add app/review.tsx
git commit -m "feat: add review screen skeleton with top bar and save logic"
```

---

## Task 5: Add vertical page pager

**Files:**
- Modify: `app/review.tsx`

- [ ] **Step 1: Replace the placeholder pager View with the real FlatList**

Replace the `{/* ② Page pager */}` section:

```tsx
{/* ② Page pager */}
<View style={{ flex: 1, backgroundColor: '#000' }}>
  <FlatList
    ref={pagerRef}
    data={pages}
    keyExtractor={(_, i) => String(i)}
    showsVerticalScrollIndicator={false}
    snapToInterval={ITEM_HEIGHT}
    decelerationRate="fast"
    onViewableItemsChanged={onViewableItemsChanged.current}
    viewabilityConfig={viewabilityConfig.current}
    getItemLayout={(_, index) => ({ length: ITEM_HEIGHT, offset: ITEM_HEIGHT * index, index })}
    renderItem={({ item: uri, index }) => {
      const fStyle = filterStyle(filters[index] as PageFilter);
      const isFocused = index === focusedIndex;
      return (
        <View style={{ height: ITEM_HEIGHT, justifyContent: 'center', alignItems: 'center', paddingVertical: 16, paddingHorizontal: 24 }}>
          <View style={[
            styles.pageCard,
            { opacity: isFocused ? 1 : 0.35, transform: [{ scale: isFocused ? 1 : 0.88 }] },
            isFocused && { borderColor: colors.accent, borderWidth: 2 },
          ]}>
            <Image
              source={{ uri }}
              style={[styles.pageImage, fStyle ? ({ filter: fStyle } as any) : undefined]}
              resizeMode="contain"
            />
          </View>
        </View>
      );
    }}
  />
  {/* Page counter */}
  <View style={styles.pageCounter}>
    <Text style={styles.pageCounterText}>{focusedIndex + 1} / {pages.length}</Text>
  </View>
</View>
```

Add these styles to `StyleSheet.create`:

```tsx
pageCard: {
  flex: 1,
  width: '100%',
  borderRadius: 6,
  overflow: 'hidden',
  backgroundColor: '#fff',
},
pageImage: {
  width: '100%',
  height: '100%',
},
pageCounter: {
  position: 'absolute',
  bottom: 12,
  right: 12,
  backgroundColor: 'rgba(0,0,0,0.55)',
  borderRadius: 10,
  paddingHorizontal: 10,
  paddingVertical: 3,
},
pageCounterText: {
  color: '#fff',
  fontSize: 12,
},
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd /Users/abdellah/Desktop/Programming/scan-kit && npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 3: Commit**

```bash
git add app/review.tsx
git commit -m "feat: add vertical snapping page pager to review screen"
```

---

## Task 6: Add filter strip

**Files:**
- Modify: `app/review.tsx`

- [ ] **Step 1: Replace the placeholder filter strip View**

Replace the `{/* ③ Filter strip */}` section:

```tsx
{/* ③ Filter strip */}
<View style={[styles.filterStrip, { backgroundColor: isDark ? 'rgba(18,18,18,0.95)' : 'rgba(248,248,248,0.95)', borderTopColor: colors.border }]}>
  <Text style={[styles.filterLabel, { color: colors.muted }]}>
    FILTER — Page {focusedIndex + 1}
  </Text>
  <FlatList
    data={FILTERS}
    keyExtractor={f => f.value}
    horizontal
    showsHorizontalScrollIndicator={false}
    contentContainerStyle={{ paddingHorizontal: 12, gap: 10 }}
    renderItem={({ item: f }) => {
      const isSelected = filters[focusedIndex] === f.value;
      const fStyle = filterStyle(f.value as PageFilter);
      const thumbUri = pages[focusedIndex];
      return (
        <Pressable
          onPress={() => setFilters(prev => {
            const next = [...prev];
            next[focusedIndex] = f.value;
            return next;
          })}
          style={styles.filterItem}
        >
          <View style={[
            styles.filterThumb,
            { borderColor: isSelected ? colors.accent : colors.border, borderWidth: isSelected ? 2 : 1 },
          ]}>
            <Image
              source={{ uri: thumbUri }}
              style={[styles.filterThumbImage, fStyle ? ({ filter: fStyle } as any) : undefined]}
              resizeMode="cover"
            />
          </View>
          <Text style={[styles.filterItemLabel, { color: isSelected ? colors.accent : colors.muted }]}>
            {f.label}
          </Text>
        </Pressable>
      );
    }}
  />
</View>
```

Add these styles:

```tsx
filterStrip: {
  borderTopWidth: StyleSheet.hairlineWidth,
  paddingTop: 8,
  paddingBottom: 6,
},
filterLabel: {
  fontSize: 10,
  fontWeight: '700',
  letterSpacing: 0.6,
  marginLeft: 14,
  marginBottom: 6,
},
filterItem: {
  alignItems: 'center',
  gap: 4,
},
filterThumb: {
  width: 52,
  height: 52,
  borderRadius: 8,
  overflow: 'hidden',
},
filterThumbImage: {
  width: '100%',
  height: '100%',
},
filterItemLabel: {
  fontSize: 10,
},
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd /Users/abdellah/Desktop/Programming/scan-kit && npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 3: Commit**

```bash
git add app/review.tsx
git commit -m "feat: add per-page filter strip to review screen"
```

---

## Task 7: Add action row

**Files:**
- Modify: `app/review.tsx`

- [ ] **Step 1: Replace the placeholder action row View**

Replace the `{/* ④ Action row */}` section:

```tsx
{/* ④ Action row */}
<View style={[styles.actionRow, { backgroundColor: isDark ? 'rgba(18,18,18,0.95)' : 'rgba(248,248,248,0.95)', borderTopColor: colors.border, paddingBottom: insets.bottom + 8 }]}>
  {/* Retake */}
  <Pressable style={styles.actionBtn} onPress={handleRetake}>
    <Text style={styles.actionIcon}>↩</Text>
    <Text style={[styles.actionLabel, { color: colors.muted }]}>Retake</Text>
  </Pressable>

  {/* Rotate */}
  <Pressable style={styles.actionBtn} onPress={handleRotate} disabled={rotating}>
    <Text style={[styles.actionIcon, rotating && { opacity: 0.4 }]}>
      {rotating ? '⏳' : '🔄'}
    </Text>
    <Text style={[styles.actionLabel, { color: colors.muted }]}>Rotate</Text>
  </Pressable>

  {/* Crop (re-scan this page) */}
  <Pressable style={styles.actionBtn} onPress={handleCrop}>
    <Text style={styles.actionIcon}>✂️</Text>
    <Text style={[styles.actionLabel, { color: colors.muted }]}>Crop</Text>
  </Pressable>

  {/* Delete */}
  <Pressable style={styles.actionBtn} onPress={handleDeletePage}>
    <Text style={styles.actionIcon}>🗑️</Text>
    <Text style={[styles.actionLabel, { color: colors.muted }]}>Delete</Text>
  </Pressable>

  {/* Add Page */}
  <Pressable style={styles.actionBtn} onPress={handleAddPage}>
    <Text style={styles.actionIcon}>📷</Text>
    <Text style={[styles.actionLabel, { color: colors.muted }]}>Add Page</Text>
  </Pressable>
</View>
```

- [ ] **Step 2: Add the action handlers above the return statement**

Add these `useCallback` functions after the `handleSave` definition (before `if (pendingPdfUri)`):

```tsx
const handleRetake = useCallback(() => {
  clearPending();
  router.back();
  setTimeout(triggerScan, 350);
}, [clearPending, router, triggerScan]);

const handleRotate = useCallback(async () => {
  if (rotating) return;
  setRotating(true);
  try {
    const result = await manipulateAsync(
      pages[focusedIndex],
      [{ rotate: 90 }],
      { compress: pendingQuality, format: SaveFormat.JPEG }
    );
    setPages(prev => {
      const next = [...prev];
      next[focusedIndex] = result.uri;
      return next;
    });
  } catch (err) {
    console.error('Rotate failed', err);
  } finally {
    setRotating(false);
  }
}, [rotating, pages, focusedIndex, pendingQuality]);

const handleCrop = useCallback(async () => {
  try {
    const { scannedImages } = await DocumentScanner.scanDocument({ letUserAdjustCrop: true });
    if (!scannedImages?.length) return;
    setPages(prev => {
      const next = [...prev];
      next[focusedIndex] = scannedImages[0];
      return next;
    });
  } catch (err) {
    console.error('Crop failed', err);
  }
}, [focusedIndex]);

const handleDeletePage = useCallback(() => {
  if (pages.length === 1) {
    clearPending();
    router.back();
    return;
  }
  setPages(prev => prev.filter((_, i) => i !== focusedIndex));
  setFilters(prev => prev.filter((_, i) => i !== focusedIndex));
  setFocused(prev => Math.min(prev, pages.length - 2));
}, [pages.length, focusedIndex, clearPending, router]);

const handleAddPage = useCallback(async () => {
  try {
    const { scannedImages } = await DocumentScanner.scanDocument({ letUserAdjustCrop: true });
    if (!scannedImages?.length) return;
    const prevLength = pages.length;
    setPages(prev => [...prev, ...scannedImages]);
    setFilters(prev => [...prev, ...scannedImages.map(() => pendingDefaultFilter)]);
    setFocused(prevLength);
    setTimeout(() => {
      pagerRef.current?.scrollToIndex({ index: prevLength, animated: true });
    }, 100);
  } catch (err) {
    console.error('Add page failed', err);
  }
}, [pages.length, pendingDefaultFilter]);
```

- [ ] **Step 3: Add action row styles**

```tsx
actionRow: {
  flexDirection: 'row',
  justifyContent: 'space-around',
  borderTopWidth: StyleSheet.hairlineWidth,
  paddingTop: 10,
},
actionBtn: {
  alignItems: 'center',
  gap: 3,
  paddingHorizontal: 8,
},
actionIcon: {
  fontSize: 20,
},
actionLabel: {
  fontSize: 10,
},
```

- [ ] **Step 4: Verify TypeScript**

```bash
cd /Users/abdellah/Desktop/Programming/scan-kit && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 5: Full manual test**

Run the dev build and verify:
- Scan 1 page → review screen opens, page shown centred, filter strip shows "FILTER — Page 1", Done saves and goes to Files
- Scan 3 pages → scroll vertically between them, apply different filters to each, Done saves with correct per-page filters visible in the viewer
- Tap Delete on page 2 of 3 → page removed, focused index adjusts
- Tap Delete on last remaining page → screen dismisses, nothing saved
- Tap Add Page → scanner opens, new page appended, pager scrolls to it
- Tap ✕ → nothing saved, back to tabs
- Tap Rotate → page rotates 90°, spinner shown briefly
- Import PDF → simple preview shown, no filter strip, Done saves PDF

- [ ] **Step 6: Commit**

```bash
git add app/review.tsx
git commit -m "feat: add action row (Retake/Rotate/Crop/Delete/Add Page) to review screen"
```
