# Scan Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a CamScanner-style document scanner app (single/batch scan, persistent grid, PDF/JPEG export) on top of the existing Expo 54 scaffold.

**Architecture:** Single home screen (`app/index.tsx`) with modal overlays — no tabs. Scanner launches via `react-native-document-scanner-plugin`, pages are persisted as JPEGs in `FileSystem.documentDirectory`, metadata in AsyncStorage. PDF generated on-demand via `expo-print` for sharing.

**Tech Stack:** Expo 54, Expo Router v6, `react-native-document-scanner-plugin`, `expo-file-system`, `@react-native-async-storage/async-storage`, `expo-print`, `expo-sharing`, `expo-crypto`, jest-expo

---

## File Map

| Path | Action | Responsibility |
|------|--------|---------------|
| `types/document.ts` | Create | Document type |
| `lib/auto-name.ts` | Create | Date-based auto-name |
| `lib/storage.ts` | Create | AsyncStorage CRUD |
| `lib/files.ts` | Create | Copy/delete page images on disk |
| `lib/pdf.ts` | Create | Generate PDF from JPEG URIs |
| `components/bottom-sheet.tsx` | Create | Reusable slide-up sheet (Modal wrapper) |
| `components/document-card.tsx` | Create | Grid card: thumbnail, name, pages, date |
| `components/empty-state.tsx` | Create | "No scans yet" placeholder |
| `components/scan-name-sheet.tsx` | Create | Post-scan name prompt sheet |
| `components/rename-sheet.tsx` | Create | Rename + delete sheet |
| `components/export-sheet.tsx` | Create | PDF / JPEG export options sheet |
| `app/index.tsx` | Create | Home screen: grid + FAB |
| `app/viewer.tsx` | Create | Full-screen document viewer modal |
| `app/_layout.tsx` | Modify | Replace tabs with flat stack |
| `app.json` | Modify | Add scanner plugin + camera permissions |
| `package.json` | Modify | Add jest config + test script |
| `__tests__/auto-name.test.ts` | Create | Unit tests for auto-name |
| `__tests__/storage.test.ts` | Create | Unit tests for storage CRUD |
| `app/(tabs)/index.tsx` | Delete | Replaced by `app/index.tsx` |
| `app/(tabs)/_layout.tsx` | Delete | Replaced by flat stack |
| `app/(tabs)/explore.tsx` | Delete | Not needed |
| `app/modal.tsx` | Delete | Not needed |

---

## Task 1: Install runtime dependencies

**Files:**
- Modify: `package.json`
- Modify: `app.json`

- [ ] **Step 1: Install scanner and storage packages**

```bash
npx expo install react-native-document-scanner-plugin @react-native-async-storage/async-storage expo-print expo-sharing expo-crypto expo-file-system
```

Expected: all packages added to `node_modules` and `package.json` dependencies.

- [ ] **Step 2: Install test framework**

```bash
npx expo install jest-expo -- --save-dev
npm install --save-dev @testing-library/react-native
```

- [ ] **Step 3: Add jest config and test script to `package.json`**

Open `package.json`. Add `"test": "jest"` to `scripts` and add a `jest` block:

```json
"scripts": {
  "start": "expo start",
  "reset-project": "node ./scripts/reset-project.js",
  "android": "expo start --android",
  "ios": "expo start --ios",
  "web": "expo start --web",
  "lint": "expo lint",
  "test": "jest"
},
"jest": {
  "preset": "jest-expo"
}
```

- [ ] **Step 4: Add scanner plugin and camera permissions to `app.json`**

In the `plugins` array and add `infoPlist` for iOS camera permission:

```json
"plugins": [
  "expo-router",
  "react-native-document-scanner-plugin",
  [
    "expo-splash-screen",
    {
      "image": "./assets/images/splash-icon.png",
      "imageWidth": 200,
      "resizeMode": "contain",
      "backgroundColor": "#ffffff",
      "dark": {
        "backgroundColor": "#000000"
      }
    }
  ]
],
```

Also add under `"ios"`:
```json
"ios": {
  "supportsTablet": true,
  "infoPlist": {
    "NSCameraUsageDescription": "Scan Kit needs camera access to scan documents."
  }
}
```

And under `"android"`:
```json
"android": {
  "adaptiveIcon": { ... },
  "edgeToEdgeEnabled": true,
  "predictiveBackGestureEnabled": false,
  "permissions": ["android.permission.CAMERA"]
}
```

- [ ] **Step 5: Verify install**

```bash
npx expo-doctor
```

Expected: no critical errors. If `react-native-document-scanner-plugin` has new architecture compatibility warnings, add `"newArchEnabled": false` under `"expo"` in `app.json` temporarily.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json app.json
git commit -m "chore: install scan-kit dependencies and configure permissions"
```

---

## Task 2: Document type

**Files:**
- Create: `types/document.ts`

- [ ] **Step 1: Create the type file**

```ts
// types/document.ts
export type Document = {
  id: string;
  name: string;
  pages: string[];    // local file:// URIs, persisted JPEGs
  createdAt: number;  // ms timestamp
  updatedAt: number;
};
```

- [ ] **Step 2: Commit**

```bash
git add types/document.ts
git commit -m "feat: add Document type"
```

---

## Task 3: Auto-name utility (TDD)

**Files:**
- Create: `lib/auto-name.ts`
- Create: `__tests__/auto-name.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/auto-name.test.ts
import { autoName } from '../lib/auto-name';

test('generates name with Scan prefix and formatted date', () => {
  const date = new Date(2026, 3, 10); // April 10 2026 (month is 0-indexed)
  expect(autoName(date)).toBe('Scan Apr 10, 2026');
});

test('defaults to current date and matches pattern', () => {
  expect(autoName()).toMatch(/^Scan \w+ \d+, \d{4}$/);
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npm test -- --testPathPattern=auto-name
```

Expected: FAIL — "Cannot find module '../lib/auto-name'"

- [ ] **Step 3: Implement auto-name**

```ts
// lib/auto-name.ts
export function autoName(date: Date = new Date()): string {
  const formatted = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `Scan ${formatted}`;
}
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
npm test -- --testPathPattern=auto-name
```

Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/auto-name.ts __tests__/auto-name.test.ts
git commit -m "feat: add auto-name utility"
```

---

## Task 4: Storage layer (TDD)

**Files:**
- Create: `lib/storage.ts`
- Create: `__tests__/storage.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// __tests__/storage.test.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDocuments, saveDocument, updateDocument, deleteDocument } from '../lib/storage';
import { Document } from '../types/document';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const doc: Document = {
  id: 'test-id',
  name: 'Scan Apr 10, 2026',
  pages: ['file:///page1.jpg'],
  createdAt: 1000,
  updatedAt: 1000,
};

beforeEach(() => AsyncStorage.clear());

test('getDocuments returns empty array when nothing stored', async () => {
  expect(await getDocuments()).toEqual([]);
});

test('saveDocument prepends document to list', async () => {
  await saveDocument(doc);
  const docs = await getDocuments();
  expect(docs).toHaveLength(1);
  expect(docs[0]).toEqual(doc);
});

test('saveDocument prepends newest first', async () => {
  const doc2: Document = { ...doc, id: 'test-id-2', name: 'Scan Apr 11, 2026' };
  await saveDocument(doc);
  await saveDocument(doc2);
  const docs = await getDocuments();
  expect(docs[0].id).toBe('test-id-2');
});

test('updateDocument replaces matching document by id', async () => {
  await saveDocument(doc);
  await updateDocument({ ...doc, name: 'Renamed' });
  const docs = await getDocuments();
  expect(docs[0].name).toBe('Renamed');
});

test('deleteDocument removes document by id', async () => {
  await saveDocument(doc);
  await deleteDocument(doc.id);
  expect(await getDocuments()).toHaveLength(0);
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- --testPathPattern=storage
```

Expected: FAIL — "Cannot find module '../lib/storage'"

- [ ] **Step 3: Implement storage layer**

```ts
// lib/storage.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Document } from '../types/document';

const KEY = '@scan_kit_documents';

export async function getDocuments(): Promise<Document[]> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return [];
  return JSON.parse(raw);
}

export async function saveDocument(doc: Document): Promise<void> {
  const docs = await getDocuments();
  await AsyncStorage.setItem(KEY, JSON.stringify([doc, ...docs]));
}

export async function updateDocument(doc: Document): Promise<void> {
  const docs = await getDocuments();
  await AsyncStorage.setItem(
    KEY,
    JSON.stringify(docs.map(d => (d.id === doc.id ? doc : d)))
  );
}

export async function deleteDocument(id: string): Promise<void> {
  const docs = await getDocuments();
  await AsyncStorage.setItem(KEY, JSON.stringify(docs.filter(d => d.id !== id)));
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- --testPathPattern=storage
```

Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/storage.ts __tests__/storage.test.ts
git commit -m "feat: add storage layer with AsyncStorage"
```

---

## Task 5: File system helpers

**Files:**
- Create: `lib/files.ts`

- [ ] **Step 1: Create file helpers**

```ts
// lib/files.ts
import * as FileSystem from 'expo-file-system';

export async function copyPageToStorage(
  tempUri: string,
  docId: string,
  pageIndex: number
): Promise<string> {
  const dir = `${FileSystem.documentDirectory}scan-kit/${docId}/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const dest = `${dir}page-${pageIndex}.jpg`;
  await FileSystem.copyAsync({ from: tempUri, to: dest });
  return dest;
}

export async function deleteDocumentFiles(docId: string): Promise<void> {
  const dir = `${FileSystem.documentDirectory}scan-kit/${docId}/`;
  const info = await FileSystem.getInfoAsync(dir);
  if (info.exists) {
    await FileSystem.deleteAsync(dir, { idempotent: true });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/files.ts
git commit -m "feat: add file system helpers for page storage"
```

---

## Task 6: PDF generation

**Files:**
- Create: `lib/pdf.ts`

- [ ] **Step 1: Create PDF generator**

```ts
// lib/pdf.ts
import * as Print from 'expo-print';

export async function generatePdf(pages: string[]): Promise<string> {
  const imgTags = pages
    .map(
      uri =>
        `<img src="${uri}" style="width:100%;display:block;page-break-after:always;" />`
    )
    .join('');
  const html = `<html><body style="margin:0;padding:0;">${imgTags}</body></html>`;
  const { uri } = await Print.printToFileAsync({ html });
  return uri;
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/pdf.ts
git commit -m "feat: add PDF generation via expo-print"
```

---

## Task 7: Strip tabs and scaffold navigation

**Files:**
- Modify: `app/_layout.tsx`
- Create: `app/index.tsx` (placeholder)
- Delete: `app/(tabs)/index.tsx`, `app/(tabs)/_layout.tsx`, `app/(tabs)/explore.tsx`, `app/modal.tsx`

- [ ] **Step 1: Replace `app/_layout.tsx`**

```tsx
// app/_layout.tsx
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';
import { useColorScheme } from '@/hooks/use-color-scheme';

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen
          name="viewer"
          options={{ presentation: 'fullScreenModal', headerShown: false }}
        />
      </Stack>
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}
```

- [ ] **Step 2: Create placeholder `app/index.tsx`**

```tsx
// app/index.tsx
import { Text, View } from 'react-native';

export default function HomeScreen() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text>Scan Kit</Text>
    </View>
  );
}
```

- [ ] **Step 3: Delete tab files**

```bash
rm app/\(tabs\)/index.tsx app/\(tabs\)/_layout.tsx app/\(tabs\)/explore.tsx app/modal.tsx
rmdir app/\(tabs\)
```

- [ ] **Step 4: Verify app launches**

```bash
npx expo start --ios
```

Expected: app opens to a white screen showing "Scan Kit" — no tab bar.

- [ ] **Step 5: Commit**

```bash
git add app/_layout.tsx app/index.tsx
git commit -m "feat: replace tab navigation with flat stack"
```

---

## Task 8: BottomSheet component

**Files:**
- Create: `components/bottom-sheet.tsx`

- [ ] **Step 1: Create the component**

```tsx
// components/bottom-sheet.tsx
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';

type Props = {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
};

export function BottomSheet({ visible, onClose, children }: Props) {
  return (
    <Modal
      transparent
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable
          style={styles.backdrop}
          onPress={() => {
            Keyboard.dismiss();
            onClose();
          }}
        />
        <View style={styles.sheet}>{children}</View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 44,
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add components/bottom-sheet.tsx
git commit -m "feat: add reusable BottomSheet component"
```

---

## Task 9: DocumentCard component

**Files:**
- Create: `components/document-card.tsx`

- [ ] **Step 1: Create the component**

```tsx
// components/document-card.tsx
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Document } from '@/types/document';

type Props = {
  document: Document;
  onPress: () => void;
  onLongPress: () => void;
};

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function DocumentCard({ document, onPress, onLongPress }: Props) {
  return (
    <Pressable style={styles.card} onPress={onPress} onLongPress={onLongPress}>
      {document.pages[0] ? (
        <Image source={{ uri: document.pages[0] }} style={styles.thumbnail} />
      ) : (
        <View style={[styles.thumbnail, styles.thumbnailPlaceholder]} />
      )}
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={2}>
          {document.name}
        </Text>
        <Text style={styles.meta}>
          {document.pages.length} page{document.pages.length !== 1 ? 's' : ''} ·{' '}
          {formatDate(document.createdAt)}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    margin: 6,
    borderRadius: 12,
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
    overflow: 'hidden',
  },
  thumbnail: {
    width: '100%',
    aspectRatio: 0.75,
  },
  thumbnailPlaceholder: {
    backgroundColor: '#e8e8e8',
  },
  info: {
    padding: 10,
  },
  name: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1a1a1a',
    marginBottom: 3,
  },
  meta: {
    fontSize: 11,
    color: '#999',
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add components/document-card.tsx
git commit -m "feat: add DocumentCard grid component"
```

---

## Task 10: EmptyState component

**Files:**
- Create: `components/empty-state.tsx`

- [ ] **Step 1: Create the component**

```tsx
// components/empty-state.tsx
import { StyleSheet, Text, View } from 'react-native';

export function EmptyState() {
  return (
    <View style={styles.container}>
      <Text style={styles.icon}>📄</Text>
      <Text style={styles.title}>No scans yet</Text>
      <Text style={styles.subtitle}>
        Tap the button below to scan your first document
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 48,
  },
  icon: {
    fontSize: 72,
    marginBottom: 20,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 15,
    color: '#999',
    textAlign: 'center',
    lineHeight: 22,
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add components/empty-state.tsx
git commit -m "feat: add EmptyState component"
```

---

## Task 11: ScanNameSheet component

**Files:**
- Create: `components/scan-name-sheet.tsx`

- [ ] **Step 1: Create the component**

```tsx
// components/scan-name-sheet.tsx
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { BottomSheet } from '@/components/bottom-sheet';
import { autoName } from '@/lib/auto-name';

type Props = {
  visible: boolean;
  pageCount: number;
  onSave: (name: string) => void;
  onRetake: () => void;
  onClose: () => void;
};

export function ScanNameSheet({ visible, pageCount, onSave, onRetake, onClose }: Props) {
  const [name, setName] = useState('');
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible) {
      setName(autoName());
      // delay focus until sheet animation completes
      const t = setTimeout(() => inputRef.current?.focus(), 400);
      return () => clearTimeout(t);
    }
  }, [visible]);

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={styles.label}>
        {pageCount} page{pageCount !== 1 ? 's' : ''} scanned
      </Text>
      <TextInput
        ref={inputRef}
        style={styles.input}
        value={name}
        onChangeText={setName}
        selectTextOnFocus
        returnKeyType="done"
        onSubmitEditing={() => name.trim() && onSave(name.trim())}
      />
      <View style={styles.row}>
        <Pressable style={styles.secondaryBtn} onPress={onRetake}>
          <Text style={styles.secondaryText}>Retake</Text>
        </Pressable>
        <Pressable
          style={[styles.primaryBtn, !name.trim() && styles.disabledBtn]}
          onPress={() => name.trim() && onSave(name.trim())}
        >
          <Text style={styles.primaryText}>Save</Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, color: '#888', marginBottom: 10 },
  input: {
    borderWidth: 1.5,
    borderColor: '#ddd',
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    marginBottom: 18,
    color: '#1a1a1a',
  },
  row: { flexDirection: 'row', gap: 12 },
  primaryBtn: {
    flex: 1,
    backgroundColor: '#0a7ea4',
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
  },
  disabledBtn: { opacity: 0.4 },
  primaryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  secondaryBtn: {
    flex: 1,
    backgroundColor: '#f0f0f0',
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
  },
  secondaryText: { color: '#1a1a1a', fontWeight: '600', fontSize: 16 },
});
```

- [ ] **Step 2: Commit**

```bash
git add components/scan-name-sheet.tsx
git commit -m "feat: add ScanNameSheet post-scan naming component"
```

---

## Task 12: RenameSheet component

**Files:**
- Create: `components/rename-sheet.tsx`

- [ ] **Step 1: Create the component**

```tsx
// components/rename-sheet.tsx
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { BottomSheet } from '@/components/bottom-sheet';
import { Document } from '@/types/document';

type Props = {
  visible: boolean;
  document: Document | null;
  onRename: (doc: Document, newName: string) => void;
  onDelete: (doc: Document) => void;
  onClose: () => void;
};

export function RenameSheet({ visible, document, onRename, onDelete, onClose }: Props) {
  const [name, setName] = useState('');
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible && document) {
      setName(document.name);
      const t = setTimeout(() => inputRef.current?.focus(), 400);
      return () => clearTimeout(t);
    }
  }, [visible, document]);

  function handleDelete() {
    if (!document) return;
    Alert.alert('Delete document?', `"${document.name}" will be permanently deleted.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => onDelete(document),
      },
    ]);
  }

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={styles.heading}>Rename document</Text>
      <TextInput
        ref={inputRef}
        style={styles.input}
        value={name}
        onChangeText={setName}
        selectTextOnFocus
        returnKeyType="done"
        onSubmitEditing={() => document && name.trim() && onRename(document, name.trim())}
      />
      <View style={styles.row}>
        <Pressable style={styles.deleteBtn} onPress={handleDelete}>
          <Text style={styles.deleteText}>Delete</Text>
        </Pressable>
        <Pressable
          style={[styles.primaryBtn, !name.trim() && styles.disabledBtn]}
          onPress={() => document && name.trim() && onRename(document, name.trim())}
        >
          <Text style={styles.primaryText}>Save</Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 17, fontWeight: '700', marginBottom: 14, color: '#1a1a1a' },
  input: {
    borderWidth: 1.5,
    borderColor: '#ddd',
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    marginBottom: 18,
    color: '#1a1a1a',
  },
  row: { flexDirection: 'row', gap: 12 },
  primaryBtn: {
    flex: 1,
    backgroundColor: '#0a7ea4',
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
  },
  disabledBtn: { opacity: 0.4 },
  primaryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  deleteBtn: {
    flex: 1,
    backgroundColor: '#fff0f0',
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#ffc5c5',
  },
  deleteText: { color: '#cc0000', fontWeight: '600', fontSize: 16 },
});
```

- [ ] **Step 2: Commit**

```bash
git add components/rename-sheet.tsx
git commit -m "feat: add RenameSheet component with delete confirmation"
```

---

## Task 13: ExportSheet component

**Files:**
- Create: `components/export-sheet.tsx`

- [ ] **Step 1: Create the component**

```tsx
// components/export-sheet.tsx
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';
import * as Sharing from 'expo-sharing';
import { generatePdf } from '@/lib/pdf';
import { BottomSheet } from '@/components/bottom-sheet';
import { Document } from '@/types/document';

type Props = {
  visible: boolean;
  document: Document;
  onClose: () => void;
};

export function ExportSheet({ visible, document, onClose }: Props) {
  const [loading, setLoading] = useState(false);

  async function handleExportPdf() {
    setLoading(true);
    onClose();
    try {
      const uri = await generatePdf(document.pages);
      await Sharing.shareAsync(uri, {
        mimeType: 'application/pdf',
        dialogTitle: document.name,
        UTI: 'com.adobe.pdf',
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleExportJpeg() {
    onClose();
    for (const pageUri of document.pages) {
      await Sharing.shareAsync(pageUri, {
        mimeType: 'image/jpeg',
        dialogTitle: document.name,
      });
    }
  }

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={styles.heading}>Export</Text>
      {loading ? (
        <ActivityIndicator style={{ marginVertical: 24 }} />
      ) : (
        <>
          <Pressable style={styles.option} onPress={handleExportPdf}>
            <Text style={styles.optionTitle}>Export as PDF</Text>
            <Text style={styles.optionSub}>All {document.pages.length} pages in one file</Text>
          </Pressable>
          <Pressable style={styles.option} onPress={handleExportJpeg}>
            <Text style={styles.optionTitle}>Export as JPEG</Text>
            <Text style={styles.optionSub}>Share individual page images</Text>
          </Pressable>
        </>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 18, fontWeight: '700', marginBottom: 16, color: '#1a1a1a' },
  option: {
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e8e8e8',
  },
  optionTitle: { fontSize: 16, fontWeight: '600', color: '#1a1a1a' },
  optionSub: { fontSize: 13, color: '#999', marginTop: 3 },
});
```

- [ ] **Step 2: Commit**

```bash
git add components/export-sheet.tsx
git commit -m "feat: add ExportSheet with PDF and JPEG sharing"
```

---

## Task 14: Home screen

**Files:**
- Modify: `app/index.tsx`

- [ ] **Step 1: Replace placeholder with full home screen**

```tsx
// app/index.tsx
import { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DocumentScanner from 'react-native-document-scanner-plugin';
import * as Crypto from 'expo-crypto';
import { Document } from '@/types/document';
import { getDocuments, saveDocument, updateDocument, deleteDocument } from '@/lib/storage';
import { copyPageToStorage, deleteDocumentFiles } from '@/lib/files';
import { autoName } from '@/lib/auto-name';
import { DocumentCard } from '@/components/document-card';
import { EmptyState } from '@/components/empty-state';
import { ScanNameSheet } from '@/components/scan-name-sheet';
import { RenameSheet } from '@/components/rename-sheet';

export default function HomeScreen() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [pendingPages, setPendingPages] = useState<string[]>([]);
  const [nameSheetVisible, setNameSheetVisible] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Document | null>(null);
  const insets = useSafeAreaInsets();
  const router = useRouter();

  useEffect(() => {
    getDocuments().then(setDocuments);
  }, []);

  const handleScan = useCallback(async () => {
    const { scannedImages } = await DocumentScanner.scanDocument();
    if (!scannedImages?.length) return;
    setPendingPages(scannedImages);
    setNameSheetVisible(true);
  }, []);

  const handleSave = useCallback(
    async (name: string) => {
      const id = Crypto.randomUUID();
      const now = Date.now();
      const savedPages = await Promise.all(
        pendingPages.map((uri, i) => copyPageToStorage(uri, id, i))
      );
      const doc: Document = { id, name, pages: savedPages, createdAt: now, updatedAt: now };
      await saveDocument(doc);
      setDocuments(prev => [doc, ...prev]);
      setNameSheetVisible(false);
      setPendingPages([]);
    },
    [pendingPages]
  );

  const handleRetake = useCallback(() => {
    setNameSheetVisible(false);
    setPendingPages([]);
    handleScan();
  }, [handleScan]);

  const handleRename = useCallback(async (doc: Document, newName: string) => {
    const updated = { ...doc, name: newName, updatedAt: Date.now() };
    await updateDocument(updated);
    setDocuments(prev => prev.map(d => (d.id === doc.id ? updated : d)));
    setRenameTarget(null);
  }, []);

  const handleDelete = useCallback(async (doc: Document) => {
    await deleteDocument(doc.id);
    await deleteDocumentFiles(doc.id);
    setDocuments(prev => prev.filter(d => d.id !== doc.id));
    setRenameTarget(null);
  }, []);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Scan Kit</Text>
      </View>

      <FlatList
        data={documents}
        keyExtractor={d => d.id}
        numColumns={2}
        contentContainerStyle={
          documents.length === 0 ? styles.emptyContent : styles.gridContent
        }
        ListEmptyComponent={<EmptyState />}
        renderItem={({ item }) => (
          <DocumentCard
            document={item}
            onPress={() =>
              router.push({ pathname: '/viewer', params: { id: item.id } })
            }
            onLongPress={() => setRenameTarget(item)}
          />
        )}
      />

      <Pressable
        style={[styles.fab, { bottom: insets.bottom + 24 }]}
        onPress={handleScan}
      >
        <Text style={styles.fabIcon}>+</Text>
      </Pressable>

      <ScanNameSheet
        visible={nameSheetVisible}
        pageCount={pendingPages.length}
        onSave={handleSave}
        onRetake={handleRetake}
        onClose={() => {
          setNameSheetVisible(false);
          setPendingPages([]);
        }}
      />

      <RenameSheet
        visible={renameTarget !== null}
        document={renameTarget}
        onRename={handleRename}
        onDelete={handleDelete}
        onClose={() => setRenameTarget(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  header: { paddingHorizontal: 20, paddingVertical: 14 },
  title: { fontSize: 30, fontWeight: '800', color: '#1a1a1a', letterSpacing: -0.5 },
  gridContent: { padding: 10, paddingBottom: 100 },
  emptyContent: { flex: 1 },
  fab: {
    position: 'absolute',
    alignSelf: 'center',
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#0a7ea4',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0a7ea4',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  fabIcon: { fontSize: 34, color: '#fff', lineHeight: 40, marginTop: -2 },
});
```

- [ ] **Step 2: Commit**

```bash
git add app/index.tsx
git commit -m "feat: implement home screen with grid and scanner integration"
```

---

## Task 15: Viewer screen

**Files:**
- Create: `app/viewer.tsx`

- [ ] **Step 1: Create the viewer**

```tsx
// app/viewer.tsx
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Dimensions,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getDocuments } from '@/lib/storage';
import { Document } from '@/types/document';
import { ExportSheet } from '@/components/export-sheet';

const SCREEN_WIDTH = Dimensions.get('window').width;

export default function ViewerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [document, setDocument] = useState<Document | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [exportVisible, setExportVisible] = useState(false);
  const insets = useSafeAreaInsets();
  const router = useRouter();

  useEffect(() => {
    getDocuments().then(docs => {
      setDocument(docs.find(d => d.id === id) ?? null);
    });
  }, [id]);

  if (!document) return null;

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.counter}>
          {currentPage + 1} / {document.pages.length}
        </Text>
        <Pressable onPress={() => setExportVisible(true)} hitSlop={12}>
          <Text style={styles.exportBtn}>Export</Text>
        </Pressable>
      </View>

      <FlatList
        data={document.pages}
        keyExtractor={(_, i) => String(i)}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={e => {
          setCurrentPage(
            Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH)
          );
        }}
        renderItem={({ item }) => (
          <View style={styles.page}>
            <Image
              source={{ uri: item }}
              style={styles.pageImage}
              resizeMode="contain"
            />
          </View>
        )}
      />

      <ExportSheet
        visible={exportVisible}
        document={document}
        onClose={() => setExportVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  back: { fontSize: 22, color: '#fff', fontWeight: '300' },
  counter: { fontSize: 15, color: '#ccc', fontWeight: '600' },
  exportBtn: { fontSize: 16, color: '#4ec6e0', fontWeight: '600' },
  page: {
    width: SCREEN_WIDTH,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  pageImage: { width: SCREEN_WIDTH - 32, flex: 1 },
});
```

- [ ] **Step 2: Commit**

```bash
git add app/viewer.tsx
git commit -m "feat: implement document viewer with page swipe and export"
```

---

## Task 16: Build and smoke test

- [ ] **Step 1: Run all unit tests**

```bash
npm test
```

Expected: all tests pass (auto-name: 2, storage: 5)

- [ ] **Step 2: Build development client for device testing**

```bash
# iOS (requires Xcode + Apple Developer account or simulator)
npx expo run:ios

# Android (requires Android Studio or connected device)
npx expo run:android
```

Note: `react-native-document-scanner-plugin` requires a development build — it will NOT work in Expo Go. Use `npx expo run:ios` or `npx expo run:android` to create a local build.

- [ ] **Step 3: Manual smoke test checklist**

- [ ] App opens to home screen with "Scan Kit" title and empty state
- [ ] Tap FAB → scanner launches with auto edge detection
- [ ] Scan one page → name sheet appears with auto-filled name + "1 page scanned"
- [ ] Edit name and tap Save → document appears in 2-column grid
- [ ] Tap FAB again → scan multiple pages → tap Done → name sheet shows correct count
- [ ] Save batch → card shows correct page count
- [ ] Tap document card → viewer opens with horizontal page swipe
- [ ] Page counter updates on swipe
- [ ] Tap Export → sheet shows PDF and JPEG options
- [ ] Export PDF → system share sheet opens with PDF
- [ ] Long-press card → rename sheet opens with current name
- [ ] Rename → grid updates
- [ ] Long-press → Delete → confirmation alert → document removed from grid
- [ ] Restart app → all documents still present (persistence check)

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete Scan Kit v1 — scanner, grid, viewer, export"
```

---

## Notes

- **New Architecture:** If `react-native-document-scanner-plugin` throws bridge-related errors at runtime, set `"newArchEnabled": false` in `app.json` under `"expo"` and rebuild.
- **Development build required:** The scanner plugin uses native camera APIs unavailable in Expo Go. Always test on a device or simulator with `npx expo run:ios` / `npx expo run:android`.
- **PDF quality:** `expo-print` renders HTML, so PDF output quality matches the original JPEG resolution. No post-processing needed.
