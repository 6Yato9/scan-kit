# Scan Kit v3a — Foundation: PDF Fix + CamScanner Navigation

**Goal:** Fix the PDF blank-pages bug, migrate to a CamScanner-style 5-tab bottom navigation, and implement the Home, Files, Tools grid shell, and Me tabs.

**Architecture:** Migrate from flat Stack to Expo Router `(tabs)` group. The outer Stack keeps `(tabs)` as the main entry and `viewer` as a fullScreenModal. A `ScanContext` at the tabs layout level shares the active scan flow across tabs. The existing `app/index.tsx` becomes `app/(tabs)/files.tsx` (full document manager). A new lightweight `app/(tabs)/index.tsx` shows recent docs. Two new packages: `expo-image-picker`, `expo-document-picker`.

**Tech Stack:** Expo 54, expo-router ~6, expo-image-picker, expo-document-picker, react-native-webview, react-native-safe-area-context (existing), AsyncStorage (existing), expo-file-system v19 class API (existing).

---

## 1. PDF Fix

### Problem
`lib/pdf.ts` embeds images as `file://` URIs in the HTML. When the PDF is shared externally (WhatsApp, Gmail, etc.), the receiver's device cannot resolve the sender's local file paths — pages appear blank.

### Fix
Before building the HTML, read each image as a base64 string using `expo-file-system`'s functional API and embed it as a `data:image/jpeg;base64,...` URI. The resulting PDF is fully self-contained.

```ts
// lib/pdf.ts
import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system';
import { PageFilter } from '../types/document';
import { filterCss } from './filters';

export async function generatePdf(pages: string[], filters?: PageFilter[]): Promise<string> {
  const imgTags = await Promise.all(
    pages.map(async (uri, i) => {
      const css = filterCss(filters?.[i]);
      const filterAttr = css !== 'none' ? `filter:${css};` : '';
      const b64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      return `<img src="data:image/jpeg;base64,${b64}" style="width:100%;display:block;page-break-after:always;${filterAttr}" />`;
    })
  );
  const html = `<html><body style="margin:0;padding:0;">${imgTags.join('')}</body></html>`;
  const { uri } = await Print.printToFileAsync({ html });
  return uri;
}
```

---

## 2. Navigation Architecture

### Current
Flat Stack: `app/_layout.tsx` → Stack → `index` + `viewer`

### New
```
app/
  _layout.tsx               ← Stack: (tabs) + viewer (fullScreenModal)
  (tabs)/
    _layout.tsx             ← Tabs: Home | Files | Scan | Tools | Me
    index.tsx               ← Home (recent docs)
    files.tsx               ← Files (full document manager, was app/index.tsx)
    scan.tsx                ← Scan trigger (auto-launches scanner, navigates away)
    tools.tsx               ← Tools grid
    me.tsx                  ← Me / Settings
  viewer.tsx                ← unchanged
  settings/
    scan-settings.tsx       ← Scan settings screen
    document-settings.tsx   ← Document settings screen
    printer.tsx             ← Printer settings screen
    about.tsx               ← About screen
```

### `app/_layout.tsx`
```tsx
import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="viewer"
          options={{ presentation: 'fullScreenModal', headerShown: false }}
        />
        <Stack.Screen name="settings/scan-settings" options={{ title: 'Scan Settings', presentation: 'card' }} />
        <Stack.Screen name="settings/document-settings" options={{ title: 'Document Settings', presentation: 'card' }} />
        <Stack.Screen name="settings/printer" options={{ title: 'My Printer', presentation: 'card' }} />
        <Stack.Screen name="settings/about" options={{ title: 'About', presentation: 'card' }} />
      </Stack>
    </GestureHandlerRootView>
  );
}
```

### `app/(tabs)/_layout.tsx`
Custom tab bar button for the Scan tab — pressing it calls `handleScan()` from `ScanContext` instead of navigating to a screen. The tab has no visible screen; it never actually renders.

```tsx
import { Tabs, useRouter } from 'expo-router';
import { Pressable, StyleSheet, View, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScanProvider, useScan } from '@/contexts/scan-context';

function ScanTabButton({ children, style }: any) {
  const { triggerScan } = useScan();
  return (
    <Pressable onPress={triggerScan} style={[style, styles.scanBtn]}>
      <View style={styles.scanCircle}>
        <Text style={styles.scanIcon}>📷</Text>
      </View>
    </Pressable>
  );
}

export default function TabLayout() {
  return (
    <ScanProvider>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarStyle: styles.tabBar,
          tabBarActiveTintColor: '#0a7ea4',
          tabBarInactiveTintColor: '#666',
        }}
      >
        <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>🏠</Text> }} />
        <Tabs.Screen name="files" options={{ title: 'Files', tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>🗂</Text> }} />
        <Tabs.Screen name="scan" options={{ title: '', tabBarButton: (props) => <ScanTabButton {...props} /> }} />
        <Tabs.Screen name="tools" options={{ title: 'Tools', tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>🔧</Text> }} />
        <Tabs.Screen name="me" options={{ title: 'Me', tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>👤</Text> }} />
      </Tabs>
    </ScanProvider>
  );
}

const styles = StyleSheet.create({
  tabBar: { backgroundColor: '#1a1a1a', borderTopColor: '#222', height: 64 },
  scanBtn: { justifyContent: 'center', alignItems: 'center', top: -16 },
  scanCircle: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: '#0a7ea4',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#0a7ea4', shadowOpacity: 0.5, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  scanIcon: { fontSize: 24 },
});
```

### `contexts/scan-context.tsx`
Holds scan state (pendingPages, nameSheetVisible). Both the Scan tab button and the Home/Files tab screens share this context so scanned images flow into a name sheet.

```tsx
import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import DocumentScanner from 'react-native-document-scanner-plugin';

type ScanContextType = {
  pendingPages: string[];
  nameSheetVisible: boolean;
  triggerScan: () => Promise<void>;
  clearPending: () => void;
  setNameSheetVisible: (v: boolean) => void;
};

const ScanContext = createContext<ScanContextType | null>(null);

export function ScanProvider({ children }: { children: ReactNode }) {
  const [pendingPages, setPendingPages] = useState<string[]>([]);
  const [nameSheetVisible, setNameSheetVisible] = useState(false);

  const triggerScan = useCallback(async () => {
    try {
      const { scannedImages } = await DocumentScanner.scanDocument();
      if (scannedImages?.length) {
        setPendingPages(scannedImages);
        setNameSheetVisible(true);
      }
    } catch (err) {
      console.error('Scan failed', err);
    }
  }, []);

  const clearPending = useCallback(() => {
    setPendingPages([]);
    setNameSheetVisible(false);
  }, []);

  return (
    <ScanContext.Provider value={{ pendingPages, nameSheetVisible, triggerScan, clearPending, setNameSheetVisible }}>
      {children}
    </ScanContext.Provider>
  );
  // NOTE: ScanNameSheet is rendered once inside app/(tabs)/_layout.tsx (wrapping the Tabs),
  // not inside individual tab screens. This means it appears over whichever tab is active
  // (Home, Files, or triggered from the Scan tab button) without duplicating logic.
  // handleSave in _layout reads pendingPages from ScanContext, saves the document,
  // and calls clearPending() when done.
}

export function useScan() {
  const ctx = useContext(ScanContext);
  if (!ctx) throw new Error('useScan must be used within ScanProvider');
  return ctx;
}
```

### `app/(tabs)/scan.tsx`
Empty placeholder — the Scan tab never actually renders its screen. The custom `tabBarButton` intercepts the press.
```tsx
import { View } from 'react-native';
export default function ScanScreen() {
  return <View style={{ flex: 1, backgroundColor: '#000' }} />;
}
```

---

## 3. Home Tab (`app/(tabs)/index.tsx`)

Lightweight recent-documents view. Shows the last 10 documents (sorted by `updatedAt` desc). Tapping a card opens the viewer. Long-press opens DocActionsSheet. The ScanNameSheet from ScanContext is rendered here.

```
┌─────────────────────────────┐
│ Scan Kit          ↕ Sort    │  ← header (sort moves here from Files)
│ ┌─────────────────────────┐ │
│ │ 🔍 Search documents…    │ │
│ └─────────────────────────┘ │
│ RECENT (last 10)            │
│ ┌──────────────────────────┐│
│ │ [thumb] Invoice Jan      ││  ← list rows (not grid)
│ │         3 pages · Today  ││
│ └──────────────────────────┘│
│ [more rows...]               │
└─────────────────────────────┘
```

List row: 48×64 thumbnail on left, doc name + page count + date on right, chevron.
Uses `useFocusEffect` to reload + re-apply sort on focus.

---

## 4. Files Tab (`app/(tabs)/files.tsx`)

Full document manager. This is `app/index.tsx` (v2) moved here, with these additions:

### 4a. Quick Action Bar
Three buttons pinned below the search bar:
- **Import Images** — `expo-image-picker`: opens photo library (multi-select). Each picked image is copied to storage as a page. ScanNameSheet opens to name the new document.
- **Import Files** — `expo-document-picker`: opens Files app filtered to PDF and images. Picked file is copied to app storage. If image: saved as 1-page document. If PDF: saved as a PDF document (see §4b).
- **New Folder** — inline text prompt (`Alert.prompt` on iOS, custom modal on Android). Creates a folder (persisted as a unique entry in AsyncStorage key `@scan_kit_folders`). Documents can then be moved into it.

### 4b. PDF Documents
When a PDF is imported, a new `Document` is created with `pdfUri: string` set and `pages: []`. In the document grid, PDF documents show a PDF icon instead of a thumbnail. Tapping opens the viewer, which detects `pdfUri` and shows a `WebView` rendering the PDF instead of the JPEG pager. PDF documents are not editable (no rotate, filter, reorder, thumbnail strip — the viewer shows a simplified toolbar: Back + Share).

`Document` type update:
```ts
export type Document = {
  id: string;
  name: string;
  pages: string[];
  filters?: PageFilter[];
  folder?: string;       // NEW: folder name, undefined = no folder
  pdfUri?: string;       // NEW: if set, this is an imported PDF document
  createdAt: number;
  updatedAt: number;
};
```

### 4c. Folder Filter
When folders exist, a horizontal chip row appears below the quick action bar:
- "All" chip (always first, active by default)
- One chip per folder name
- Tapping a chip filters the document grid to that folder
- Active chip is highlighted (blue border + text)

Folders are derived from `document.folder` values — they don't have their own storage entry. `New Folder` creates a folder name in `@scan_kit_folders` so empty folders can exist before docs are moved into them.

### 4d. Move to Folder
DocActionsSheet gets a new **"Move to Folder"** option. Tapping opens `MoveFolderSheet` — a bottom sheet listing all folders with radio-style selection. Selecting a folder updates `document.folder` and calls `updateDocument`.

### New `lib/storage.ts` additions
```ts
export async function getFolders(): Promise<string[]>  // reads @scan_kit_folders, returns sorted names
export async function saveFolder(name: string): Promise<void>  // appends to @scan_kit_folders
export async function deleteFolder(name: string): Promise<void>  // removes from list, clears folder on all docs
```

---

## 5. Tools Tab (`app/(tabs)/tools.tsx`)

Scrollable grid, dark background. Sections: **Scan**, **Import**, **Edit**, **Utilities**. Each tool is a tappable 80×90pt card (icon + label). Tapping navigates to the tool's screen (or to the Files tab for Import shortcuts). Tools not yet built (v3b) are greyed out with "Coming Soon" badge.

```
┌─────────────────────────────┐
│         Tools               │
│                             │
│  SCAN                       │
│  ┌──────┐ ┌──────┐         │
│  │  🪪  │ │  ⏰  │         │
│  │ID Card│ │Timest│ *grey*  │
│  └──────┘ └──────┘         │
│                             │
│  IMPORT                     │
│  ┌──────┐ ┌──────┐         │
│  │  📥  │ │  🖼  │         │
│  │ Files │ │Images│         │
│  └──────┘ └──────┘         │
│                             │
│  EDIT                       │
│  [Sign] [Watermark]         │
│  [Extract] [Compress] [Lock]│
│                             │
│  UTILITIES                  │
│  [Print] [QR Code]          │
└─────────────────────────────┘
```

In v3a, all tools are greyed out with "Soon" badges except **Import Images** and **Import Files** (which navigate to Files tab and trigger the import action) and **Print** (which is a direct `Print.printAsync` prompt asking which document to print — navigates to a simple document picker list).

---

## 6. Me Tab (`app/(tabs)/me.tsx`)

Settings list matching the CamScanner Me screen layout.

```tsx
const ROWS = [
  { icon: '📷', label: 'Scan Settings',     route: '/settings/scan-settings' },
  { icon: '📄', label: 'Document Settings', route: '/settings/document-settings' },
  { icon: '🖨', label: 'My Printer',         route: '/settings/printer' },
  { icon: '↕️', label: 'Sort Preference',    action: 'sort' },  // opens SortSheet inline
  { icon: '❓', label: 'Help',               action: 'help' },  // opens Alert with instructions
  { icon: 'ℹ️', label: 'About',              route: '/settings/about' },
];
```

Each row: icon + label + chevron. Tapping a `route` row calls `router.push(route)`. Tapping `sort` action opens the existing `SortSheet`. Tapping `help` opens an `Alert` with a short usage guide.

### `app/settings/scan-settings.tsx`
Settings stored in AsyncStorage (`@scan_kit_scan_settings`):
- **Scan quality**: Low / Medium / High radio — maps to `compress: 0.5 / 0.75 / 0.9` passed to `copyPageToStorage`
- **Auto-crop**: toggle (passed to `DocumentScanner.scanDocument({ letUserAdjustCrop })`)
- **Color mode default**: Color / Grayscale / B&W — pre-selects filter for all new scans

Settings are read by `ScanContext.triggerScan()` before launching the scanner.

```ts
// lib/storage.ts additions
export type ScanSettings = {
  quality: 'low' | 'medium' | 'high';
  autoCrop: boolean;
  defaultFilter: PageFilter | 'original';
};
export async function getScanSettings(): Promise<ScanSettings>
export async function saveScanSettings(s: ScanSettings): Promise<void>
```

### `app/settings/document-settings.tsx`
Settings stored in `@scan_kit_doc_settings`:
- **Default document name prefix**: TextInput (default: "Scan")
- **PDF page size**: A4 / Letter radio (used in `generatePdf` HTML width/height — A4 = 210mm×297mm, Letter = 215.9mm×279.4mm as CSS `@page` size)
- **PDF image quality**: Standard / High — maps to base64 JPEG `compress: 0.75` (Standard) or `0.95` (High) passed into `generatePdf`

`generatePdf(pages, filters, settings?)` — `DocSettings` is passed in (or read from AsyncStorage inside the function if not provided) so page size and quality are applied.

```ts
export type DocSettings = {
  namePrefix: string;
  pdfPageSize: 'A4' | 'Letter';
  pdfQuality: 'standard' | 'high';
};
export async function getDocSettings(): Promise<DocSettings>
export async function saveDocSettings(s: DocSettings): Promise<void>
```

### `app/settings/printer.tsx`
Simple text note — iOS/Android use the system print dialog from `expo-print`, so there's nothing to configure app-side. Shows a note: "Printer selection is managed by your device. Tap Export → Print from any document to print." No settings stored.

### `app/settings/about.tsx`
App name, version (from `expo-constants`), and a short description.

---

## 7. New & Modified Files Summary

### New files
| File | Purpose |
|---|---|
| `app/(tabs)/_layout.tsx` | Tab navigator with custom Scan button |
| `app/(tabs)/index.tsx` | Home — recent docs list |
| `app/(tabs)/files.tsx` | Files — full doc manager (moved from `app/index.tsx`) |
| `app/(tabs)/scan.tsx` | Scan placeholder screen |
| `app/(tabs)/tools.tsx` | Tools grid |
| `app/(tabs)/me.tsx` | Me / Settings list |
| `app/settings/scan-settings.tsx` | Scan settings screen |
| `app/settings/document-settings.tsx` | Document settings screen |
| `app/settings/printer.tsx` | Printer info screen |
| `app/settings/about.tsx` | About screen |
| `contexts/scan-context.tsx` | Shared scan state + trigger |
| `components/move-folder-sheet.tsx` | Folder picker bottom sheet |

### Modified files
| File | Change |
|---|---|
| `app/_layout.tsx` | Replace Stack screens with `(tabs)` + `viewer` + settings screens |
| `lib/pdf.ts` | Base64 encode images before HTML generation |
| `lib/storage.ts` | Add `getFolders`, `saveFolder`, `deleteFolder`, `getScanSettings`, `saveScanSettings`, `getDocSettings`, `saveDocSettings` |
| `types/document.ts` | Add `folder?: string`, `pdfUri?: string` |
| `components/doc-actions-sheet.tsx` | Add "Move to Folder" option |

### Deleted files
| File | Replacement |
|---|---|
| `app/index.tsx` | `app/(tabs)/files.tsx` (moved) |

### New packages
- `expo-image-picker` (Expo SDK 54 compatible)
- `expo-document-picker` (Expo SDK 54 compatible)
- `react-native-webview` (for PDF document viewer)

---

## 8. Edge Cases

- **Scan from Tools Import shortcuts**: tapping Import Images / Import Files in the Tools tab navigates to `/(tabs)/files` and triggers the respective import action via URL params (`?action=importImages` / `?action=importFiles`).
- **Empty folders**: folders stored in `@scan_kit_folders` can exist without docs assigned. `deleteFolder` removes the entry and unsets `folder` on all docs that had it.
- **PDF document in viewer**: if `document.pdfUri` is set, viewer shows a WebView instead of FlatList + ThumbnailStrip. Header shows: Back + doc name + Share button only (no Export/Reorder/Page Actions).
- **Scan settings quality** applied to: new scans via `triggerScan`, import images via expo-image-picker (compress applied before copying). Does NOT retroactively affect existing pages.
- **Default filter** from scan settings: applied to all pages of a new scan (sets `document.filters` array). Does not affect imports.
- **Import image multiple selection**: expo-image-picker with `allowsMultipleSelection: true`. Each selected image becomes one page of a single new document (not separate documents).
- **Import PDF**: `expo-document-picker` with `type: ['application/pdf']`. Copies file to `scan-kit/{docId}/document.pdf`. Sets `pdfUri` on Document. `pages` remains empty.
