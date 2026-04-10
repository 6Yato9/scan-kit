# Scan Kit v2 — Full CamScanner Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add all offline CamScanner features: export fix (spinner kept visible + print option), page rotation via expo-image-manipulator, display-only filters via RN 0.81.5 `filter` style prop, page reorder/delete, thumbnail strip + add-more-pages in viewer, home screen search/sort/multi-select, and duplicate/merge documents.

**Architecture:** Sheet-first pattern. Filters are stored as `PageFilter[]` metadata on `Document` and displayed via React Native's `filter` style prop — no file modification. CSS filters applied in PDF HTML. Only rotation physically overwrites files via expo-image-manipulator. New packages: `expo-image-manipulator`, `react-native-draggable-flatlist`. Home screen reloads on focus via `useFocusEffect`.

**Tech Stack:** Expo 54, expo-image-manipulator (`manipulateAsync`), react-native-draggable-flatlist, react-native-gesture-handler (existing ~2.28.0), react-native-reanimated (existing ~4.1.1), expo-print (existing), expo-sharing (existing), AsyncStorage (existing), expo-file-system v19 (`Directory`, `File`, `Paths`), React Native 0.81.5 `filter` style prop.

**Key API facts for implementers:**
- `expo-file-system` v19 is **synchronous** class-based: `new Directory(Paths.document, 'scan-kit', docId)`, `dir.create({intermediates:true, idempotent:true})`, `new File(dir, 'name.jpg')`, `src.copy(dest)`, `file.delete()`, `file.exists`.
- `manipulateAsync(uri, [{rotate: 90}], {compress: 0.9, format: SaveFormat.JPEG})` returns `{uri, width, height}`. Creates a new temp file.
- `DraggableFlatList` from react-native-draggable-flatlist: `renderItem` receives `{item, drag, isActive}`, wrap with `<ScaleDecorator>`, use `onLongPress={drag}` on the touchable, `onDragEnd={({data}) => ...}` on the list.
- RN 0.81.5 `filter` style: string like `'grayscale(1)'`, `'grayscale(1) contrast(2)'`. Use `(style as any)` if TypeScript complains.

---

### Task 1: Install packages

**Files:**
- Modify: `package.json` (via install commands)

- [ ] **Step 1: Install expo-image-manipulator**

```bash
npx expo install expo-image-manipulator
```

Expected: package added to `dependencies` in package.json.

- [ ] **Step 2: Install react-native-draggable-flatlist**

```bash
npm install react-native-draggable-flatlist --legacy-peer-deps
```

Expected: package added to `dependencies`. Use `--legacy-peer-deps` to bypass React 19 peer dep warnings.

- [ ] **Step 3: Verify existing tests still pass**

```bash
npm test
```

Expected: 7 tests pass, 0 failures.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add expo-image-manipulator and react-native-draggable-flatlist"
```

---

### Task 2: Add PageFilter type, lib/filters.ts, update Document type

**Files:**
- Modify: `types/document.ts`
- Create: `lib/filters.ts`
- Create: `__tests__/filters.test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/filters.test.ts`:

```ts
import { filterStyle, filterCss } from '../lib/filters';

describe('filterStyle', () => {
  it('returns undefined for original', () => {
    expect(filterStyle('original')).toBeUndefined();
  });
  it('returns undefined when filter is undefined', () => {
    expect(filterStyle(undefined)).toBeUndefined();
  });
  it('returns grayscale(1) for grayscale', () => {
    expect(filterStyle('grayscale')).toBe('grayscale(1)');
  });
  it('returns grayscale(1) contrast(2) for bw', () => {
    expect(filterStyle('bw')).toBe('grayscale(1) contrast(2)');
  });
  it('returns contrast(1.3) saturate(1.3) for enhanced', () => {
    expect(filterStyle('enhanced')).toBe('contrast(1.3) saturate(1.3)');
  });
});

describe('filterCss', () => {
  it('returns none for original', () => {
    expect(filterCss('original')).toBe('none');
  });
  it('returns none when undefined', () => {
    expect(filterCss(undefined)).toBe('none');
  });
  it('returns grayscale(100%) for grayscale', () => {
    expect(filterCss('grayscale')).toBe('grayscale(100%)');
  });
  it('returns grayscale + contrast for bw', () => {
    expect(filterCss('bw')).toBe('grayscale(100%) contrast(200%)');
  });
  it('returns contrast + saturate for enhanced', () => {
    expect(filterCss('enhanced')).toBe('contrast(130%) saturate(130%)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --testPathPattern=filters
```

Expected: FAIL — "Cannot find module '../lib/filters'"

- [ ] **Step 3: Update types/document.ts**

```ts
// types/document.ts
export type PageFilter = 'original' | 'grayscale' | 'bw' | 'enhanced';

export type Document = {
  id: string;
  name: string;
  pages: string[];       // local file:// URIs, persisted JPEGs
  filters?: PageFilter[]; // per-page display filter; absent = all 'original'
  createdAt: number;     // ms timestamp
  updatedAt: number;
};
```

- [ ] **Step 4: Create lib/filters.ts**

```ts
// lib/filters.ts
import { PageFilter } from '../types/document';

/** Returns a React Native `filter` style string, or undefined for 'original'. */
export function filterStyle(filter?: PageFilter): string | undefined {
  switch (filter) {
    case 'grayscale': return 'grayscale(1)';
    case 'bw':        return 'grayscale(1) contrast(2)';
    case 'enhanced':  return 'contrast(1.3) saturate(1.3)';
    default:          return undefined;
  }
}

/** Returns a CSS filter string for use in PDF HTML <img> tags. */
export function filterCss(filter?: PageFilter): string {
  switch (filter) {
    case 'grayscale': return 'grayscale(100%)';
    case 'bw':        return 'grayscale(100%) contrast(200%)';
    case 'enhanced':  return 'contrast(130%) saturate(130%)';
    default:          return 'none';
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm test -- --testPathPattern=filters
```

Expected: 10 tests pass.

- [ ] **Step 6: Run full suite**

```bash
npm test
```

Expected: 17 tests pass (7 existing + 10 new).

- [ ] **Step 7: Commit**

```bash
git add types/document.ts lib/filters.ts __tests__/filters.test.ts
git commit -m "feat: add PageFilter type and filter style/css helpers"
```

---

### Task 3: lib/image.ts — rotatePage

**Files:**
- Create: `lib/image.ts`
- Create: `__tests__/image.test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/image.test.ts`:

```ts
jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn().mockResolvedValue({
    uri: 'file:///tmp/rotated.jpg',
    width: 200,
    height: 400,
  }),
  SaveFormat: { JPEG: 'jpeg' },
}));

jest.mock('expo-file-system', () => ({
  File: jest.fn().mockImplementation(() => ({
    exists: true,
    delete: jest.fn(),
    copy: jest.fn(),
    uri: 'file:///documents/scan-kit/doc1/page-0.jpg',
  })),
  Directory: jest.fn(),
  Paths: { document: 'file:///documents' },
}));

import { rotatePage } from '../lib/image';
import { manipulateAsync } from 'expo-image-manipulator';

describe('rotatePage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls manipulateAsync with rotate: 90 for cw', async () => {
    await rotatePage('file:///original.jpg', 'cw', 'doc1', 0);
    expect(manipulateAsync).toHaveBeenCalledWith(
      'file:///original.jpg',
      [{ rotate: 90 }],
      expect.objectContaining({ format: 'jpeg' })
    );
  });

  it('calls manipulateAsync with rotate: -90 for ccw', async () => {
    await rotatePage('file:///original.jpg', 'ccw', 'doc1', 0);
    expect(manipulateAsync).toHaveBeenCalledWith(
      'file:///original.jpg',
      [{ rotate: -90 }],
      expect.any(Object)
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --testPathPattern=image
```

Expected: FAIL — "Cannot find module '../lib/image'"

- [ ] **Step 3: Create lib/image.ts**

```ts
// lib/image.ts
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { Directory, File, Paths } from 'expo-file-system';

/**
 * Rotates a stored page JPEG by 90° and overwrites the original file.
 * Returns the same URI (file content replaced).
 */
export async function rotatePage(
  uri: string,
  direction: 'cw' | 'ccw',
  docId: string,
  pageIndex: number
): Promise<string> {
  const degrees = direction === 'cw' ? 90 : -90;
  const result = await manipulateAsync(uri, [{ rotate: degrees }], {
    compress: 0.9,
    format: SaveFormat.JPEG,
  });
  // Overwrite the original file with the rotated result
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  const dest = new File(dir, `page-${pageIndex}.jpg`);
  if (dest.exists) dest.delete();
  const src = new File(result.uri);
  src.copy(dest);
  return dest.uri;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- --testPathPattern=image
```

Expected: 2 tests pass.

- [ ] **Step 5: Run full suite**

```bash
npm test
```

Expected: 19 tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/image.ts __tests__/image.test.ts
git commit -m "feat: add rotatePage using expo-image-manipulator"
```

---

### Task 4: lib/files.ts — add replacePage, appendPages, deleteSinglePage, reorderPages, copyDocumentFiles

**Files:**
- Modify: `lib/files.ts`
- Create: `__tests__/files.test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/files.test.ts`:

```ts
const mockFileInstances: Record<string, any> = {};
const mockCopy = jest.fn();
const mockDelete = jest.fn();

jest.mock('expo-file-system', () => {
  return {
    File: jest.fn().mockImplementation((dirOrUri: any, name?: string) => {
      const uri = name ? `${dirOrUri.uri || dirOrUri}/${name}` : String(dirOrUri);
      if (!mockFileInstances[uri]) {
        mockFileInstances[uri] = { uri, exists: true, copy: mockCopy, delete: mockDelete };
      }
      return mockFileInstances[uri];
    }),
    Directory: jest.fn().mockImplementation((...parts: string[]) => ({
      uri: parts.join('/'),
      create: jest.fn(),
      delete: jest.fn(),
      exists: true,
    })),
    Paths: { document: 'file:///documents' },
  };
});

import { deleteSinglePage, appendPages, reorderPages, copyDocumentFiles } from '../lib/files';

describe('appendPages', () => {
  beforeEach(() => jest.clearAllMocks());

  it('copies each temp URI to storage and returns URIs', () => {
    const uris = appendPages(['file:///tmp/a.jpg', 'file:///tmp/b.jpg'], 'doc1', 2);
    expect(mockCopy).toHaveBeenCalledTimes(2);
    expect(uris).toHaveLength(2);
  });
});

describe('deleteSinglePage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes target file and copies subsequent files down', () => {
    deleteSinglePage('doc1', 1, 3);
    // page-1 deleted, page-2 copied to page-1, page-2 deleted
    expect(mockDelete).toHaveBeenCalled();
    expect(mockCopy).toHaveBeenCalled();
  });
});

describe('reorderPages', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns correct number of URIs for new order', () => {
    const result = reorderPages('doc1', [2, 0, 1]);
    expect(result).toHaveLength(3);
  });
});

describe('copyDocumentFiles', () => {
  beforeEach(() => jest.clearAllMocks());

  it('copies each page file and returns destination URIs', () => {
    const pages = ['file:///docs/scan-kit/src/page-0.jpg', 'file:///docs/scan-kit/src/page-1.jpg'];
    const uris = copyDocumentFiles('src', 'dest', pages);
    expect(mockCopy).toHaveBeenCalledTimes(2);
    expect(uris).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --testPathPattern=files
```

Expected: FAIL — "appendPages is not exported from '../lib/files'"

- [ ] **Step 3: Update lib/files.ts with new functions**

```ts
// lib/files.ts
import { Directory, File, Paths } from 'expo-file-system';

export function copyPageToStorage(
  tempUri: string,
  docId: string,
  pageIndex: number
): string {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  dir.create({ intermediates: true, idempotent: true });
  const dest = new File(dir, `page-${pageIndex}.jpg`);
  const src = new File(tempUri);
  src.copy(dest);
  return dest.uri;
}

export function deleteDocumentFiles(docId: string): void {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  if (dir.exists) {
    dir.delete();
  }
}

/** Overwrites a stored page with a new file (e.g. after rotation). */
export function replacePage(newUri: string, docId: string, pageIndex: number): string {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  const dest = new File(dir, `page-${pageIndex}.jpg`);
  if (dest.exists) dest.delete();
  const src = new File(newUri);
  src.copy(dest);
  return dest.uri;
}

/** Copies an array of temp URIs into a doc's storage, starting at startIndex. */
export function appendPages(
  tempUris: string[],
  docId: string,
  startIndex: number
): string[] {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  dir.create({ intermediates: true, idempotent: true });
  return tempUris.map((uri, i) => {
    const dest = new File(dir, `page-${startIndex + i}.jpg`);
    const src = new File(uri);
    src.copy(dest);
    return dest.uri;
  });
}

/**
 * Deletes a single page file and shifts subsequent pages down by one index.
 * After calling this, update document.pages in the caller.
 */
export function deleteSinglePage(
  docId: string,
  pageIndex: number,
  totalPages: number
): void {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  const target = new File(dir, `page-${pageIndex}.jpg`);
  if (target.exists) target.delete();
  for (let i = pageIndex + 1; i < totalPages; i++) {
    const src = new File(dir, `page-${i}.jpg`);
    const dest = new File(dir, `page-${i - 1}.jpg`);
    if (src.exists) {
      src.copy(dest);
      src.delete();
    }
  }
}

/**
 * Reorders page files according to newOrderIndices.
 * newOrderIndices[i] = old index that should become new index i.
 * Returns the new URIs in new order.
 */
export function reorderPages(docId: string, newOrderIndices: number[]): string[] {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  const n = newOrderIndices.length;
  // Step 1: copy originals to temp names
  for (let i = 0; i < n; i++) {
    const src = new File(dir, `page-${newOrderIndices[i]}.jpg`);
    const tmp = new File(dir, `page-tmp-${i}.jpg`);
    src.copy(tmp);
  }
  // Step 2: delete old files
  for (let i = 0; i < n; i++) {
    const old = new File(dir, `page-${i}.jpg`);
    if (old.exists) old.delete();
  }
  // Step 3: move temp to final
  for (let i = 0; i < n; i++) {
    const tmp = new File(dir, `page-tmp-${i}.jpg`);
    const dest = new File(dir, `page-${i}.jpg`);
    tmp.copy(dest);
    tmp.delete();
  }
  return Array.from({ length: n }, (_, i) => new File(dir, `page-${i}.jpg`).uri);
}

/** Copies all page files from sourceId to a new destId directory. */
export function copyDocumentFiles(
  sourceId: string,
  destId: string,
  pages: string[]
): string[] {
  const destDir = new Directory(Paths.document, 'scan-kit', destId);
  destDir.create({ intermediates: true, idempotent: true });
  return pages.map((_, i) => {
    const src = new File(new Directory(Paths.document, 'scan-kit', sourceId), `page-${i}.jpg`);
    const dest = new File(destDir, `page-${i}.jpg`);
    src.copy(dest);
    return dest.uri;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- --testPathPattern=files
```

Expected: 4 tests pass.

- [ ] **Step 5: Run full suite**

```bash
npm test
```

Expected: 23 tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/files.ts __tests__/files.test.ts
git commit -m "feat: add replacePage, appendPages, deleteSinglePage, reorderPages, copyDocumentFiles to lib/files"
```

---

### Task 5: lib/storage.ts — add SortKey, getSortPreference, saveSortPreference

**Files:**
- Modify: `lib/storage.ts`
- Modify: `__tests__/storage.test.ts`

- [ ] **Step 1: Add tests for new functions to __tests__/storage.test.ts**

Open `__tests__/storage.test.ts` and append these tests after the existing ones:

```ts
// Add this import at the top of the file if not already there:
// import { getDocuments, saveDocument, updateDocument, deleteDocument, getSortPreference, saveSortPreference } from '../lib/storage';

describe('getSortPreference', () => {
  it('returns dateAdded by default when nothing stored', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockResolvedValueOnce(null);
    const key = await getSortPreference();
    expect(key).toBe('dateAdded');
  });

  it('returns stored value when valid', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockResolvedValueOnce('nameAZ');
    const key = await getSortPreference();
    expect(key).toBe('nameAZ');
  });

  it('returns dateAdded for unknown stored value', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockResolvedValueOnce('invalid');
    const key = await getSortPreference();
    expect(key).toBe('dateAdded');
  });
});

describe('saveSortPreference', () => {
  it('saves the sort key to AsyncStorage', async () => {
    const spy = jest.spyOn(AsyncStorage, 'setItem').mockResolvedValueOnce();
    await saveSortPreference('dateModified');
    expect(spy).toHaveBeenCalledWith('@scan_kit_sort', 'dateModified');
  });
});
```

- [ ] **Step 2: Run test to verify new tests fail**

```bash
npm test -- --testPathPattern=storage
```

Expected: existing 5 pass, new 4 fail — "getSortPreference is not a function"

- [ ] **Step 3: Update lib/storage.ts**

```ts
// lib/storage.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Document } from '../types/document';

const KEY = '@scan_kit_documents';
const SORT_KEY = '@scan_kit_sort';

export type SortKey = 'dateAdded' | 'dateModified' | 'nameAZ';

export async function getDocuments(): Promise<Document[]> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
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

export async function getSortPreference(): Promise<SortKey> {
  const raw = await AsyncStorage.getItem(SORT_KEY);
  if (raw === 'dateModified' || raw === 'nameAZ') return raw;
  return 'dateAdded';
}

export async function saveSortPreference(key: SortKey): Promise<void> {
  await AsyncStorage.setItem(SORT_KEY, key);
}
```

- [ ] **Step 4: Update import in __tests__/storage.test.ts**

Change the import line at the top of `__tests__/storage.test.ts` to:

```ts
import {
  getDocuments,
  saveDocument,
  updateDocument,
  deleteDocument,
  getSortPreference,
  saveSortPreference,
} from '../lib/storage';
```

- [ ] **Step 5: Run test to verify all pass**

```bash
npm test -- --testPathPattern=storage
```

Expected: 9 tests pass.

- [ ] **Step 6: Run full suite**

```bash
npm test
```

Expected: 27 tests pass.

- [ ] **Step 7: Commit**

```bash
git add lib/storage.ts __tests__/storage.test.ts
git commit -m "feat: add SortKey, getSortPreference, saveSortPreference to storage"
```

---

### Task 6: lib/pdf.ts — apply CSS filters in PDF export

**Files:**
- Modify: `lib/pdf.ts`

> No test needed: this is a pure HTML template change verified visually.

- [ ] **Step 1: Update lib/pdf.ts to accept optional filters**

```ts
// lib/pdf.ts
import * as Print from 'expo-print';
import { PageFilter } from '../types/document';
import { filterCss } from './filters';

export async function generatePdf(pages: string[], filters?: PageFilter[]): Promise<string> {
  const imgTags = pages
    .map((uri, i) => {
      const css = filterCss(filters?.[i]);
      const filterAttr = css !== 'none' ? `filter:${css};` : '';
      return `<img src="${uri}" style="width:100%;display:block;page-break-after:always;${filterAttr}" />`;
    })
    .join('');
  const html = `<html><body style="margin:0;padding:0;">${imgTags}</body></html>`;
  const { uri } = await Print.printToFileAsync({ html });
  return uri;
}
```

- [ ] **Step 2: Run full suite to verify nothing broke**

```bash
npm test
```

Expected: 27 tests pass.

- [ ] **Step 3: Commit**

```bash
git add lib/pdf.ts
git commit -m "feat: apply CSS filters per page in PDF generation"
```

---

### Task 7: Fix components/export-sheet.tsx — keep spinner visible + add Print

**Files:**
- Modify: `components/export-sheet.tsx`

- [ ] **Step 1: Replace the entire file**

```tsx
// components/export-sheet.tsx
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { useState } from 'react';
import * as Sharing from 'expo-sharing';
import * as Print from 'expo-print';
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
    try {
      const uri = await generatePdf(document.pages, document.filters);
      await Sharing.shareAsync(uri, {
        mimeType: 'application/pdf',
        dialogTitle: document.name,
        UTI: 'com.adobe.pdf',
      });
    } finally {
      setLoading(false);
      onClose();
    }
  }

  async function handleExportJpeg() {
    setLoading(true);
    try {
      for (const pageUri of document.pages) {
        await Sharing.shareAsync(pageUri, {
          mimeType: 'image/jpeg',
          dialogTitle: document.name,
        });
      }
    } finally {
      setLoading(false);
      onClose();
    }
  }

  async function handlePrint() {
    setLoading(true);
    try {
      const imgTags = document.pages
        .map((uri, i) => {
          const { filterCss } = require('@/lib/filters');
          const css = filterCss(document.filters?.[i]);
          const filterAttr = css !== 'none' ? `filter:${css};` : '';
          return `<img src="${uri}" style="width:100%;display:block;page-break-after:always;${filterAttr}" />`;
        })
        .join('');
      const html = `<html><body style="margin:0;padding:0;">${imgTags}</body></html>`;
      await Print.printAsync({ html });
    } finally {
      setLoading(false);
      onClose();
    }
  }

  return (
    <BottomSheet visible={visible} onClose={loading ? undefined : onClose}>
      <Text style={styles.heading}>Export</Text>
      {loading ? (
        <ActivityIndicator size="large" style={{ marginVertical: 32 }} />
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
          <Pressable style={styles.option} onPress={handlePrint}>
            <Text style={styles.optionTitle}>Print</Text>
            <Text style={styles.optionSub}>Send to a printer</Text>
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

Also update `components/bottom-sheet.tsx` to allow `onClose` to be optional (so it can't be dismissed while loading):

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
  onClose?: () => void;
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
            if (!onClose) return;
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
  container: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 44,
  },
});
```

- [ ] **Step 2: Run full suite**

```bash
npm test
```

Expected: 27 tests pass.

- [ ] **Step 3: Commit**

```bash
git add components/export-sheet.tsx components/bottom-sheet.tsx
git commit -m "fix: keep export sheet open during PDF generation; add Print option"
```

---

### Task 8: components/thumbnail-strip.tsx

**Files:**
- Create: `components/thumbnail-strip.tsx`

- [ ] **Step 1: Create the component**

```tsx
// components/thumbnail-strip.tsx
import { useEffect, useRef } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { PageFilter } from '@/types/document';
import { filterStyle } from '@/lib/filters';

type Props = {
  pages: string[];
  filters?: PageFilter[];
  currentPage: number;
  onPagePress: (index: number) => void;
  onAddPress: () => void;
  bottomInset: number;
};

export function ThumbnailStrip({
  pages,
  filters,
  currentPage,
  onPagePress,
  onAddPress,
  bottomInset,
}: Props) {
  const listRef = useRef<FlatList>(null);

  useEffect(() => {
    if (pages.length > 0) {
      listRef.current?.scrollToIndex({ index: currentPage, animated: true, viewPosition: 0.5 });
    }
  }, [currentPage, pages.length]);

  return (
    <View style={[styles.container, { paddingBottom: bottomInset + 8 }]}>
      <FlatList
        ref={listRef}
        data={pages}
        keyExtractor={(_, i) => String(i)}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.content}
        onScrollToIndexFailed={() => {}}
        renderItem={({ item, index }) => {
          const fStyle = filterStyle(filters?.[index]);
          return (
            <Pressable
              style={[styles.thumb, index === currentPage && styles.thumbActive]}
              onPress={() => onPagePress(index)}
            >
              <Image
                source={{ uri: item }}
                style={[styles.thumbImage, fStyle ? ({ filter: fStyle } as any) : undefined]}
                resizeMode="cover"
              />
            </Pressable>
          );
        }}
        ListFooterComponent={
          <Pressable style={styles.addBtn} onPress={onAddPress}>
            <Text style={styles.addIcon}>＋</Text>
            <Text style={styles.addLabel}>Add</Text>
          </Pressable>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#1a1a1a',
    paddingTop: 8,
  },
  content: {
    paddingHorizontal: 8,
    gap: 6,
  },
  thumb: {
    width: 48,
    height: 64,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: 'transparent',
    overflow: 'hidden',
  },
  thumbActive: {
    borderColor: '#0a7ea4',
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  addBtn: {
    width: 48,
    height: 64,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: '#555',
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addIcon: { fontSize: 18, color: '#999' },
  addLabel: { fontSize: 9, color: '#999', marginTop: 2 },
});
```

- [ ] **Step 2: Run full suite**

```bash
npm test
```

Expected: 27 tests pass.

- [ ] **Step 3: Commit**

```bash
git add components/thumbnail-strip.tsx
git commit -m "feat: add ThumbnailStrip component with add-pages button"
```

---

### Task 9: components/page-actions-sheet.tsx

**Files:**
- Create: `components/page-actions-sheet.tsx`

- [ ] **Step 1: Create the component**

```tsx
// components/page-actions-sheet.tsx
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';
import { BottomSheet } from '@/components/bottom-sheet';
import { PageFilter } from '@/types/document';
import { filterStyle } from '@/lib/filters';

type Props = {
  visible: boolean;
  uri: string;
  filter: PageFilter;
  onRotate: (direction: 'cw' | 'ccw') => Promise<void>;
  onFilter: (filter: PageFilter) => void;
  onDelete: () => void;
  onShare: () => void;
  onClose: () => void;
};

const FILTERS: { key: PageFilter; label: string }[] = [
  { key: 'original', label: 'Original' },
  { key: 'grayscale', label: 'Grayscale' },
  { key: 'bw', label: 'B&W' },
  { key: 'enhanced', label: 'Enhanced' },
];

export function PageActionsSheet({
  visible,
  uri,
  filter,
  onRotate,
  onFilter,
  onDelete,
  onShare,
  onClose,
}: Props) {
  const [rotating, setRotating] = useState(false);

  async function rotate(direction: 'cw' | 'ccw') {
    setRotating(true);
    try {
      await onRotate(direction);
    } finally {
      setRotating(false);
    }
  }

  const fStyle = filterStyle(filter);

  return (
    <BottomSheet visible={visible} onClose={rotating ? undefined : onClose}>
      <Text style={styles.heading}>Page Actions</Text>

      {/* Preview */}
      <View style={styles.previewRow}>
        <Image
          source={{ uri }}
          style={[styles.preview, fStyle ? ({ filter: fStyle } as any) : undefined]}
          resizeMode="contain"
        />
      </View>

      {/* Rotate row */}
      <View style={styles.row}>
        {rotating ? (
          <ActivityIndicator style={{ flex: 1 }} />
        ) : (
          <>
            <Pressable style={styles.actionBtn} onPress={() => rotate('ccw')}>
              <Text style={styles.actionIcon}>↺</Text>
              <Text style={styles.actionLabel}>Rotate L</Text>
            </Pressable>
            <Pressable style={styles.actionBtn} onPress={() => rotate('cw')}>
              <Text style={styles.actionIcon}>↻</Text>
              <Text style={styles.actionLabel}>Rotate R</Text>
            </Pressable>
            <Pressable style={styles.actionBtn} onPress={onShare}>
              <Text style={styles.actionIcon}>↑</Text>
              <Text style={styles.actionLabel}>Share</Text>
            </Pressable>
            <Pressable style={[styles.actionBtn, styles.deleteAction]} onPress={onDelete}>
              <Text style={[styles.actionIcon, styles.deleteIcon]}>✕</Text>
              <Text style={[styles.actionLabel, styles.deleteLabel]}>Delete</Text>
            </Pressable>
          </>
        )}
      </View>

      {/* Filter strip */}
      <View style={styles.filterRow}>
        {FILTERS.map(({ key, label }) => {
          const fs = filterStyle(key);
          return (
            <Pressable
              key={key}
              style={[styles.filterTile, filter === key && styles.filterTileActive]}
              onPress={() => onFilter(key)}
            >
              <Image
                source={{ uri }}
                style={[styles.filterPreview, fs ? ({ filter: fs } as any) : undefined]}
                resizeMode="cover"
              />
              <Text style={[styles.filterLabel, filter === key && styles.filterLabelActive]}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 17, fontWeight: '700', marginBottom: 12, color: '#1a1a1a' },
  previewRow: { alignItems: 'center', marginBottom: 12 },
  preview: { width: 80, height: 100, borderRadius: 4, backgroundColor: '#f0f0f0' },
  row: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  actionBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    backgroundColor: '#f5f5f5',
    borderRadius: 10,
  },
  actionIcon: { fontSize: 22, color: '#1a1a1a' },
  actionLabel: { fontSize: 11, color: '#555', marginTop: 2 },
  deleteAction: { backgroundColor: '#fff0f0' },
  deleteIcon: { color: '#cc0000' },
  deleteLabel: { color: '#cc0000' },
  filterRow: { flexDirection: 'row', gap: 8 },
  filterTile: {
    flex: 1,
    alignItems: 'center',
    borderRadius: 8,
    padding: 4,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  filterTileActive: { borderColor: '#0a7ea4' },
  filterPreview: { width: '100%', aspectRatio: 0.75, borderRadius: 4, backgroundColor: '#e8e8e8' },
  filterLabel: { fontSize: 10, color: '#888', marginTop: 4 },
  filterLabelActive: { color: '#0a7ea4', fontWeight: '600' },
});
```

- [ ] **Step 2: Run full suite**

```bash
npm test
```

Expected: 27 tests pass.

- [ ] **Step 3: Commit**

```bash
git add components/page-actions-sheet.tsx
git commit -m "feat: add PageActionsSheet with rotate, filter strip, delete, share"
```

---

### Task 10: components/reorder-modal.tsx

**Files:**
- Create: `components/reorder-modal.tsx`

- [ ] **Step 1: Create the component**

```tsx
// components/reorder-modal.tsx
import { Modal, Pressable, SafeAreaView, StyleSheet, Text, View, Image } from 'react-native';
import { useState } from 'react';
import DraggableFlatList, {
  ScaleDecorator,
  RenderItemParams,
} from 'react-native-draggable-flatlist';
import { PageFilter } from '@/types/document';
import { filterStyle } from '@/lib/filters';

type PageItem = {
  index: number;
  uri: string;
  filter?: PageFilter;
};

type Props = {
  visible: boolean;
  pages: string[];
  filters?: PageFilter[];
  onConfirm: (newOrderIndices: number[]) => void;
  onCancel: () => void;
};

export function ReorderModal({ visible, pages, filters, onConfirm, onCancel }: Props) {
  const [items, setItems] = useState<PageItem[]>([]);

  // Reset when opened
  function handleShow() {
    setItems(pages.map((uri, index) => ({ index, uri, filter: filters?.[index] })));
  }

  function handleConfirm() {
    onConfirm(items.map(item => item.index));
  }

  const renderItem = ({ item, drag, isActive }: RenderItemParams<PageItem>) => {
    const fStyle = filterStyle(item.filter);
    return (
      <ScaleDecorator>
        <Pressable
          style={[styles.row, isActive && styles.rowActive]}
          onLongPress={drag}
          delayLongPress={100}
        >
          <Image
            source={{ uri: item.uri }}
            style={[styles.thumb, fStyle ? ({ filter: fStyle } as any) : undefined]}
            resizeMode="cover"
          />
          <Text style={styles.pageLabel}>Page {items.indexOf(item) + 1}</Text>
          <Text style={styles.dragHandle}>☰</Text>
        </Pressable>
      </ScaleDecorator>
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onShow={handleShow}
      onRequestClose={onCancel}
    >
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={onCancel} hitSlop={12}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>Reorder Pages</Text>
          <Pressable onPress={handleConfirm} hitSlop={12}>
            <Text style={styles.done}>Done</Text>
          </Pressable>
        </View>
        <DraggableFlatList
          data={items}
          onDragEnd={({ data }) => setItems(data)}
          keyExtractor={item => String(item.index)}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e8e8e8',
  },
  title: { fontSize: 17, fontWeight: '600', color: '#1a1a1a' },
  cancel: { fontSize: 16, color: '#888' },
  done: { fontSize: 16, color: '#0a7ea4', fontWeight: '600' },
  list: { paddingVertical: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#fff',
    gap: 14,
  },
  rowActive: { backgroundColor: '#f0f8ff' },
  thumb: {
    width: 44,
    height: 58,
    borderRadius: 4,
    backgroundColor: '#e8e8e8',
  },
  pageLabel: { flex: 1, fontSize: 15, color: '#1a1a1a' },
  dragHandle: { fontSize: 20, color: '#ccc' },
});
```

- [ ] **Step 2: Run full suite**

```bash
npm test
```

Expected: 27 tests pass.

- [ ] **Step 3: Commit**

```bash
git add components/reorder-modal.tsx
git commit -m "feat: add ReorderModal with DraggableFlatList"
```

---

### Task 11: app/viewer.tsx — full rewrite with all new features

**Files:**
- Modify: `app/viewer.tsx`

- [ ] **Step 1: Replace the entire file**

```tsx
// app/viewer.tsx
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Dimensions,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Sharing from 'expo-sharing';
import DocumentScanner from 'react-native-document-scanner-plugin';
import { getDocuments, updateDocument, deleteDocument } from '@/lib/storage';
import { appendPages, deleteSinglePage, reorderPages, deleteDocumentFiles } from '@/lib/files';
import { rotatePage } from '@/lib/image';
import { filterStyle } from '@/lib/filters';
import { Document, PageFilter } from '@/types/document';
import { ExportSheet } from '@/components/export-sheet';
import { PageActionsSheet } from '@/components/page-actions-sheet';
import { ThumbnailStrip } from '@/components/thumbnail-strip';
import { ReorderModal } from '@/components/reorder-modal';

const SCREEN_WIDTH = Dimensions.get('window').width;

export default function ViewerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [document, setDocument] = useState<Document | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [exportVisible, setExportVisible] = useState(false);
  const [actionsVisible, setActionsVisible] = useState(false);
  const [reorderVisible, setReorderVisible] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const insets = useSafeAreaInsets();
  const router = useRouter();

  useEffect(() => {
    getDocuments().then(docs => {
      setDocument(docs.find(d => d.id === id) ?? null);
    });
  }, [id]);

  const saveDoc = useCallback(async (updated: Document) => {
    setDocument(updated);
    await updateDocument(updated);
  }, []);

  const handleRotate = useCallback(async (direction: 'cw' | 'ccw') => {
    if (!document) return;
    const newUri = await rotatePage(
      document.pages[currentPage],
      direction,
      document.id,
      currentPage
    );
    const newPages = [...document.pages];
    newPages[currentPage] = newUri;
    await saveDoc({ ...document, pages: newPages, updatedAt: Date.now() });
  }, [document, currentPage, saveDoc]);

  const handleFilter = useCallback(async (filter: PageFilter) => {
    if (!document) return;
    const newFilters: PageFilter[] = [
      ...(document.filters ?? document.pages.map(() => 'original' as PageFilter)),
    ];
    newFilters[currentPage] = filter;
    const allOriginal = newFilters.every(f => f === 'original');
    await saveDoc({
      ...document,
      filters: allOriginal ? undefined : newFilters,
      updatedAt: Date.now(),
    });
  }, [document, currentPage, saveDoc]);

  const handleDeletePage = useCallback(async () => {
    if (!document) return;
    if (document.pages.length === 1) {
      Alert.alert(
        'Delete document?',
        'This is the last page. The whole document will be deleted.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              await deleteDocument(document.id);
              deleteDocumentFiles(document.id);
              router.back();
            },
          },
        ]
      );
      return;
    }
    deleteSinglePage(document.id, currentPage, document.pages.length);
    const newPages = document.pages.filter((_, i) => i !== currentPage);
    const newFilters = document.filters?.filter((_, i) => i !== currentPage);
    const safePage = Math.min(currentPage, newPages.length - 1);
    await saveDoc({
      ...document,
      pages: newPages,
      filters: newFilters?.length ? newFilters : undefined,
      updatedAt: Date.now(),
    });
    setCurrentPage(safePage);
    setActionsVisible(false);
  }, [document, currentPage, saveDoc, router]);

  const handleSharePage = useCallback(async () => {
    if (!document) return;
    setActionsVisible(false);
    await Sharing.shareAsync(document.pages[currentPage], {
      mimeType: 'image/jpeg',
      dialogTitle: `${document.name} — Page ${currentPage + 1}`,
    });
  }, [document, currentPage]);

  const handleAddMore = useCallback(async () => {
    if (!document) return;
    try {
      const { scannedImages } = await DocumentScanner.scanDocument();
      if (!scannedImages?.length) return;
      const startIndex = document.pages.length;
      const newUris = appendPages(scannedImages, document.id, startIndex);
      await saveDoc({
        ...document,
        pages: [...document.pages, ...newUris],
        updatedAt: Date.now(),
      });
    } catch (err) {
      console.error('Add pages failed', err);
    }
  }, [document, saveDoc]);

  const handleReorder = useCallback(async (newOrderIndices: number[]) => {
    if (!document) return;
    const newUris = reorderPages(document.id, newOrderIndices);
    const oldFilters = document.filters ?? document.pages.map(() => 'original' as PageFilter);
    const newFilters = newOrderIndices.map(i => oldFilters[i]);
    const allOriginal = newFilters.every(f => f === 'original');
    await saveDoc({
      ...document,
      pages: newUris,
      filters: allOriginal ? undefined : newFilters,
      updatedAt: Date.now(),
    });
    setReorderVisible(false);
    setCurrentPage(0);
    flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [document, saveDoc]);

  const handleThumbnailPress = useCallback((index: number) => {
    setCurrentPage(index);
    flatListRef.current?.scrollToIndex({ index, animated: true });
  }, []);

  if (!document) return null;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>{document.name}</Text>
        <View style={styles.headerRight}>
          <Pressable onPress={() => setReorderVisible(true)} hitSlop={12} style={styles.headerBtn}>
            <Text style={styles.headerBtnText}>⇅</Text>
          </Pressable>
          <Pressable onPress={() => setActionsVisible(true)} hitSlop={12} style={styles.headerBtn}>
            <Text style={styles.headerBtnText}>•••</Text>
          </Pressable>
          <Pressable onPress={() => setExportVisible(true)} hitSlop={12}>
            <Text style={styles.exportBtn}>Export</Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        ref={flatListRef}
        data={document.pages}
        keyExtractor={(_, i) => String(i)}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={e => {
          setCurrentPage(Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH));
        }}
        onScrollToIndexFailed={() => {}}
        renderItem={({ item, index }) => {
          const fStyle = filterStyle(document.filters?.[index]);
          return (
            <View style={styles.page}>
              <Image
                source={{ uri: item }}
                style={[styles.pageImage, fStyle ? ({ filter: fStyle } as any) : undefined]}
                resizeMode="contain"
              />
            </View>
          );
        }}
      />

      <ThumbnailStrip
        pages={document.pages}
        filters={document.filters}
        currentPage={currentPage}
        onPagePress={handleThumbnailPress}
        onAddPress={handleAddMore}
        bottomInset={insets.bottom}
      />

      <ExportSheet
        visible={exportVisible}
        document={document}
        onClose={() => setExportVisible(false)}
      />

      <PageActionsSheet
        visible={actionsVisible}
        uri={document.pages[currentPage]}
        filter={document.filters?.[currentPage] ?? 'original'}
        onRotate={handleRotate}
        onFilter={handleFilter}
        onDelete={handleDeletePage}
        onShare={handleSharePage}
        onClose={() => setActionsVisible(false)}
      />

      <ReorderModal
        visible={reorderVisible}
        pages={document.pages}
        filters={document.filters}
        onConfirm={handleReorder}
        onCancel={() => setReorderVisible(false)}
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
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  back: { fontSize: 22, color: '#fff', fontWeight: '300' },
  title: { flex: 1, fontSize: 15, color: '#ccc', fontWeight: '600', textAlign: 'center', marginHorizontal: 8 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerBtn: { paddingHorizontal: 6 },
  headerBtnText: { fontSize: 16, color: '#fff' },
  exportBtn: { fontSize: 15, color: '#4ec6e0', fontWeight: '600' },
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

- [ ] **Step 2: Run full suite**

```bash
npm test
```

Expected: 27 tests pass.

- [ ] **Step 3: Commit**

```bash
git add app/viewer.tsx
git commit -m "feat: full viewer update — thumbnail strip, page actions, reorder, add more, filters"
```

---

### Task 12: components/sort-sheet.tsx

**Files:**
- Create: `components/sort-sheet.tsx`

- [ ] **Step 1: Create the component**

```tsx
// components/sort-sheet.tsx
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BottomSheet } from '@/components/bottom-sheet';
import { SortKey } from '@/lib/storage';

type Props = {
  visible: boolean;
  current: SortKey;
  onSort: (key: SortKey) => void;
  onClose: () => void;
};

const OPTIONS: { key: SortKey; label: string; sub: string }[] = [
  { key: 'dateAdded', label: 'Date Added', sub: 'Newest first' },
  { key: 'dateModified', label: 'Last Modified', sub: 'Recently edited first' },
  { key: 'nameAZ', label: 'Name A–Z', sub: 'Alphabetical order' },
];

export function SortSheet({ visible, current, onSort, onClose }: Props) {
  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={styles.heading}>Sort by</Text>
      {OPTIONS.map(({ key, label, sub }) => (
        <Pressable
          key={key}
          style={styles.option}
          onPress={() => { onSort(key); onClose(); }}
        >
          <View style={styles.optionText}>
            <Text style={styles.optionLabel}>{label}</Text>
            <Text style={styles.optionSub}>{sub}</Text>
          </View>
          {current === key && <Text style={styles.check}>✓</Text>}
        </Pressable>
      ))}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 18, fontWeight: '700', marginBottom: 12, color: '#1a1a1a' },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e8e8e8',
  },
  optionText: { flex: 1 },
  optionLabel: { fontSize: 16, fontWeight: '500', color: '#1a1a1a' },
  optionSub: { fontSize: 12, color: '#999', marginTop: 2 },
  check: { fontSize: 18, color: '#0a7ea4', fontWeight: '700' },
});
```

- [ ] **Step 2: Run full suite**

```bash
npm test
```

Expected: 27 tests pass.

- [ ] **Step 3: Commit**

```bash
git add components/sort-sheet.tsx
git commit -m "feat: add SortSheet component"
```

---

### Task 13: components/doc-actions-sheet.tsx

**Files:**
- Create: `components/doc-actions-sheet.tsx`

- [ ] **Step 1: Create the component**

```tsx
// components/doc-actions-sheet.tsx
import { Pressable, StyleSheet, Text } from 'react-native';
import { BottomSheet } from '@/components/bottom-sheet';
import { Document } from '@/types/document';

type Props = {
  visible: boolean;
  document: Document | null;
  onRename: (doc: Document) => void;
  onDuplicate: (doc: Document) => void;
  onMerge: (doc: Document) => void;
  onSelect: (doc: Document) => void;
  onDelete: (doc: Document) => void;
  onClose: () => void;
};

export function DocActionsSheet({
  visible,
  document,
  onRename,
  onDuplicate,
  onMerge,
  onSelect,
  onDelete,
  onClose,
}: Props) {
  if (!document) return null;

  function wrap(fn: (doc: Document) => void) {
    return () => { onClose(); fn(document!); };
  }

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={styles.docName} numberOfLines={2}>{document.name}</Text>

      <Pressable style={styles.option} onPress={wrap(onRename)}>
        <Text style={styles.optionText}>Rename</Text>
      </Pressable>

      <Pressable style={styles.option} onPress={wrap(onDuplicate)}>
        <Text style={styles.optionText}>Duplicate</Text>
      </Pressable>

      <Pressable style={styles.option} onPress={wrap(onMerge)}>
        <Text style={styles.optionText}>Merge with…</Text>
      </Pressable>

      <Pressable style={styles.option} onPress={wrap(onSelect)}>
        <Text style={styles.optionText}>Select</Text>
      </Pressable>

      <Pressable style={[styles.option, styles.optionLast]} onPress={wrap(onDelete)}>
        <Text style={[styles.optionText, styles.deleteText]}>Delete</Text>
      </Pressable>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  docName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#888',
    marginBottom: 12,
  },
  option: {
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e8e8e8',
  },
  optionLast: { borderBottomWidth: 0 },
  optionText: { fontSize: 17, color: '#1a1a1a' },
  deleteText: { color: '#cc0000' },
});
```

- [ ] **Step 2: Run full suite**

```bash
npm test
```

Expected: 27 tests pass.

- [ ] **Step 3: Commit**

```bash
git add components/doc-actions-sheet.tsx
git commit -m "feat: add DocActionsSheet (rename, duplicate, merge, select, delete)"
```

---

### Task 14: components/merge-sheet.tsx

**Files:**
- Create: `components/merge-sheet.tsx`

- [ ] **Step 1: Create the component**

```tsx
// components/merge-sheet.tsx
import { FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { BottomSheet } from '@/components/bottom-sheet';
import { Document } from '@/types/document';

type Props = {
  visible: boolean;
  targetDoc: Document | null;
  allDocs: Document[];
  onMerge: (targetDoc: Document, sourceDoc: Document) => void;
  onClose: () => void;
};

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

export function MergeSheet({ visible, targetDoc, allDocs, onMerge, onClose }: Props) {
  const sources = allDocs.filter(d => d.id !== targetDoc?.id);

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={styles.heading}>Merge with…</Text>
      <Text style={styles.sub}>Pages will be appended to "{targetDoc?.name}"</Text>
      {sources.length === 0 ? (
        <Text style={styles.empty}>No other documents to merge with.</Text>
      ) : (
        <FlatList
          data={sources}
          keyExtractor={d => d.id}
          scrollEnabled={sources.length > 4}
          style={{ maxHeight: 280 }}
          renderItem={({ item }) => (
            <Pressable
              style={styles.docRow}
              onPress={() => { onClose(); onMerge(targetDoc!, item); }}
            >
              {item.pages[0] ? (
                <Image source={{ uri: item.pages[0] }} style={styles.thumb} />
              ) : (
                <View style={[styles.thumb, styles.thumbPlaceholder]} />
              )}
              <View style={styles.docInfo}>
                <Text style={styles.docName} numberOfLines={2}>{item.name}</Text>
                <Text style={styles.docMeta}>
                  {item.pages.length} page{item.pages.length !== 1 ? 's' : ''} · {formatDate(item.createdAt)}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 18, fontWeight: '700', marginBottom: 4, color: '#1a1a1a' },
  sub: { fontSize: 13, color: '#888', marginBottom: 14 },
  empty: { fontSize: 14, color: '#999', paddingVertical: 24, textAlign: 'center' },
  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e8e8e8',
    gap: 12,
  },
  thumb: { width: 40, height: 52, borderRadius: 4, backgroundColor: '#e8e8e8' },
  thumbPlaceholder: { backgroundColor: '#e8e8e8' },
  docInfo: { flex: 1 },
  docName: { fontSize: 14, fontWeight: '600', color: '#1a1a1a' },
  docMeta: { fontSize: 12, color: '#999', marginTop: 2 },
});
```

- [ ] **Step 2: Run full suite**

```bash
npm test
```

Expected: 27 tests pass.

- [ ] **Step 3: Commit**

```bash
git add components/merge-sheet.tsx
git commit -m "feat: add MergeSheet component"
```

---

### Task 15: app/index.tsx — search, sort, multi-select, duplicate, merge

**Files:**
- Modify: `app/index.tsx`
- Modify: `components/document-card.tsx`

- [ ] **Step 1: Update components/document-card.tsx to support multi-select**

```tsx
// components/document-card.tsx
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Document } from '@/types/document';

type Props = {
  document: Document;
  onPress: () => void;
  onLongPress: () => void;
  isSelected?: boolean;
  isMultiSelectMode?: boolean;
};

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

export function DocumentCard({ document, onPress, onLongPress, isSelected, isMultiSelectMode }: Props) {
  return (
    <Pressable style={styles.card} onPress={onPress} onLongPress={onLongPress}>
      {document.pages[0] ? (
        <Image source={{ uri: document.pages[0] }} style={styles.thumbnail} />
      ) : (
        <View style={[styles.thumbnail, styles.thumbnailPlaceholder]} />
      )}
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={2}>{document.name}</Text>
        <Text style={styles.meta}>
          {document.pages.length} page{document.pages.length !== 1 ? 's' : ''} · {formatDate(document.createdAt)}
        </Text>
      </View>
      {isMultiSelectMode && (
        <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
          {isSelected && <Text style={styles.checkmark}>✓</Text>}
        </View>
      )}
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
  thumbnail: { width: '100%', aspectRatio: 0.75 },
  thumbnailPlaceholder: { backgroundColor: '#e8e8e8' },
  info: { padding: 10 },
  name: { fontSize: 13, fontWeight: '600', color: '#1a1a1a', marginBottom: 3 },
  meta: { fontSize: 11, color: '#999' },
  checkbox: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#fff',
    backgroundColor: 'rgba(0,0,0,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxSelected: {
    backgroundColor: '#0a7ea4',
    borderColor: '#0a7ea4',
  },
  checkmark: { color: '#fff', fontSize: 13, fontWeight: '700' },
});
```

- [ ] **Step 2: Replace app/index.tsx**

```tsx
// app/index.tsx
import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DocumentScanner from 'react-native-document-scanner-plugin';
import * as Crypto from 'expo-crypto';
import { Document, PageFilter } from '@/types/document';
import {
  getDocuments,
  saveDocument,
  updateDocument,
  deleteDocument,
  getSortPreference,
  saveSortPreference,
  SortKey,
} from '@/lib/storage';
import {
  copyPageToStorage,
  deleteDocumentFiles,
  appendPages,
  copyDocumentFiles,
} from '@/lib/files';
import { DocumentCard } from '@/components/document-card';
import { EmptyState } from '@/components/empty-state';
import { ScanNameSheet } from '@/components/scan-name-sheet';
import { RenameSheet } from '@/components/rename-sheet';
import { SortSheet } from '@/components/sort-sheet';
import { DocActionsSheet } from '@/components/doc-actions-sheet';
import { MergeSheet } from '@/components/merge-sheet';

function sortDocuments(docs: Document[], key: SortKey): Document[] {
  const sorted = [...docs];
  switch (key) {
    case 'dateModified':
      return sorted.sort((a, b) => b.updatedAt - a.updatedAt);
    case 'nameAZ':
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
    default:
      return sorted.sort((a, b) => b.createdAt - a.createdAt);
  }
}

export default function HomeScreen() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [pendingPages, setPendingPages] = useState<string[]>([]);
  const [nameSheetVisible, setNameSheetVisible] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('dateAdded');
  const [sortSheetVisible, setSortSheetVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [docActionsTarget, setDocActionsTarget] = useState<Document | null>(null);
  const [renameTarget, setRenameTarget] = useState<Document | null>(null);
  const [mergeTarget, setMergeTarget] = useState<Document | null>(null);
  const insets = useSafeAreaInsets();
  const router = useRouter();

  useFocusEffect(
    useCallback(() => {
      async function load() {
        const [docs, sort] = await Promise.all([getDocuments(), getSortPreference()]);
        setDocuments(docs);
        setSortKey(sort);
      }
      load();
      // Clear multi-select when coming back into focus
      setSelectedIds(new Set());
    }, [])
  );

  const displayedDocuments = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = q ? documents.filter(d => d.name.toLowerCase().includes(q)) : documents;
    return sortDocuments(filtered, sortKey);
  }, [documents, searchQuery, sortKey]);

  const isMultiSelectMode = selectedIds.size > 0;

  const handleScan = useCallback(async () => {
    try {
      const { scannedImages } = await DocumentScanner.scanDocument();
      if (!scannedImages?.length) return;
      setPendingPages(scannedImages);
      setNameSheetVisible(true);
    } catch (err) {
      console.error('Scan failed', err);
    }
  }, []);

  const handleSave = useCallback(
    async (name: string) => {
      try {
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
      } catch (err) {
        console.error('Save failed', err);
      }
    },
    [pendingPages]
  );

  const handleRetake = useCallback(() => {
    setNameSheetVisible(false);
    setPendingPages([]);
    setTimeout(handleScan, 350);
  }, [handleScan]);

  const handleCardPress = useCallback((doc: Document) => {
    if (isMultiSelectMode) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(doc.id)) next.delete(doc.id);
        else next.add(doc.id);
        return next;
      });
    } else {
      router.push({ pathname: '/viewer', params: { id: doc.id } });
    }
  }, [isMultiSelectMode, router]);

  const handleCardLongPress = useCallback((doc: Document) => {
    if (isMultiSelectMode) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(doc.id)) next.delete(doc.id);
        else next.add(doc.id);
        return next;
      });
    } else {
      setDocActionsTarget(doc);
    }
  }, [isMultiSelectMode]);

  const handleRename = useCallback(async (doc: Document, newName: string) => {
    const updated = { ...doc, name: newName, updatedAt: Date.now() };
    await updateDocument(updated);
    setDocuments(prev => prev.map(d => (d.id === doc.id ? updated : d)));
    setRenameTarget(null);
  }, []);

  const handleDelete = useCallback(async (doc: Document) => {
    Alert.alert('Delete document?', `"${doc.name}" will be permanently deleted.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteDocument(doc.id);
          deleteDocumentFiles(doc.id);
          setDocuments(prev => prev.filter(d => d.id !== doc.id));
        },
      },
    ]);
  }, []);

  const handleDuplicate = useCallback(async (doc: Document) => {
    const newId = Crypto.randomUUID();
    const now = Date.now();
    const newPages = copyDocumentFiles(doc.id, newId, doc.pages);
    const newDoc: Document = {
      id: newId,
      name: `Copy of ${doc.name}`,
      pages: newPages,
      filters: doc.filters ? [...doc.filters] : undefined,
      createdAt: now,
      updatedAt: now,
    };
    await saveDocument(newDoc);
    setDocuments(prev => [newDoc, ...prev]);
  }, []);

  const handleMerge = useCallback(async (targetDoc: Document, sourceDoc: Document) => {
    const newPageUris = appendPages(sourceDoc.pages, targetDoc.id, targetDoc.pages.length);
    const targetFilters: PageFilter[] = targetDoc.filters ?? targetDoc.pages.map(() => 'original');
    const sourceFilters: PageFilter[] = sourceDoc.filters ?? sourceDoc.pages.map(() => 'original');
    const combined = [...targetFilters, ...sourceFilters];
    const allOriginal = combined.every(f => f === 'original');
    const updated: Document = {
      ...targetDoc,
      pages: [...targetDoc.pages, ...newPageUris],
      filters: allOriginal ? undefined : combined,
      updatedAt: Date.now(),
    };
    await updateDocument(updated);
    setDocuments(prev => prev.map(d => (d.id === updated.id ? updated : d)));
  }, []);

  const handleSelect = useCallback((doc: Document) => {
    setSelectedIds(new Set([doc.id]));
  }, []);

  const handleSort = useCallback(async (key: SortKey) => {
    setSortKey(key);
    await saveSortPreference(key);
  }, []);

  const handleBatchDelete = useCallback(() => {
    Alert.alert(
      `Delete ${selectedIds.size} document${selectedIds.size !== 1 ? 's' : ''}?`,
      'This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const ids = Array.from(selectedIds);
            for (const id of ids) {
              await deleteDocument(id);
              deleteDocumentFiles(id);
            }
            setDocuments(prev => prev.filter(d => !ids.includes(d.id)));
            setSelectedIds(new Set());
          },
        },
      ]
    );
  }, [selectedIds]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Scan Kit</Text>
        <Pressable onPress={() => setSortSheetVisible(true)} hitSlop={12}>
          <Text style={styles.sortBtn}>↕ Sort</Text>
        </Pressable>
      </View>

      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search documents…"
          placeholderTextColor="#aaa"
          value={searchQuery}
          onChangeText={setSearchQuery}
          clearButtonMode="while-editing"
          returnKeyType="search"
        />
      </View>

      <FlatList
        data={displayedDocuments}
        keyExtractor={d => d.id}
        numColumns={2}
        contentContainerStyle={
          displayedDocuments.length === 0 ? styles.emptyContent : styles.gridContent
        }
        ListEmptyComponent={
          searchQuery.trim() ? (
            <View style={styles.noResults}>
              <Text style={styles.noResultsText}>No results for "{searchQuery.trim()}"</Text>
            </View>
          ) : (
            <EmptyState />
          )
        }
        renderItem={({ item }) => (
          <DocumentCard
            document={item}
            onPress={() => handleCardPress(item)}
            onLongPress={() => handleCardLongPress(item)}
            isSelected={selectedIds.has(item.id)}
            isMultiSelectMode={isMultiSelectMode}
          />
        )}
      />

      {/* Multi-select action bar */}
      {isMultiSelectMode && (
        <View style={[styles.multiBar, { paddingBottom: insets.bottom + 12 }]}>
          <Pressable style={styles.cancelBtn} onPress={() => setSelectedIds(new Set())}>
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.deleteBtn} onPress={handleBatchDelete}>
            <Text style={styles.deleteBtnText}>
              Delete ({selectedIds.size})
            </Text>
          </Pressable>
        </View>
      )}

      {/* FAB — hidden in multi-select */}
      {!isMultiSelectMode && (
        <Pressable
          style={[styles.fab, { bottom: insets.bottom + 24 }]}
          onPress={handleScan}
        >
          <Text style={styles.fabIcon}>+</Text>
        </Pressable>
      )}

      <ScanNameSheet
        visible={nameSheetVisible}
        pageCount={pendingPages.length}
        onSave={handleSave}
        onRetake={handleRetake}
        onClose={() => { setNameSheetVisible(false); setPendingPages([]); }}
      />

      <SortSheet
        visible={sortSheetVisible}
        current={sortKey}
        onSort={handleSort}
        onClose={() => setSortSheetVisible(false)}
      />

      <DocActionsSheet
        visible={docActionsTarget !== null}
        document={docActionsTarget}
        onRename={doc => setRenameTarget(doc)}
        onDuplicate={handleDuplicate}
        onMerge={doc => setMergeTarget(doc)}
        onSelect={handleSelect}
        onDelete={handleDelete}
        onClose={() => setDocActionsTarget(null)}
      />

      <RenameSheet
        visible={renameTarget !== null}
        document={renameTarget}
        onRename={handleRename}
        onDelete={handleDelete}
        onClose={() => setRenameTarget(null)}
      />

      <MergeSheet
        visible={mergeTarget !== null}
        targetDoc={mergeTarget}
        allDocs={documents}
        onMerge={handleMerge}
        onClose={() => setMergeTarget(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 8,
  },
  title: { fontSize: 30, fontWeight: '800', color: '#1a1a1a', letterSpacing: -0.5 },
  sortBtn: { fontSize: 14, color: '#0a7ea4', fontWeight: '600' },
  searchRow: { paddingHorizontal: 14, paddingBottom: 10 },
  searchInput: {
    backgroundColor: '#ebebeb',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 9,
    fontSize: 15,
    color: '#1a1a1a',
  },
  gridContent: { padding: 10, paddingBottom: 120 },
  emptyContent: { flex: 1 },
  noResults: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  noResultsText: { fontSize: 16, color: '#888' },
  multiBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#fff',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 14,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: -4 },
    elevation: 8,
  },
  cancelBtn: {
    flex: 1,
    backgroundColor: '#f0f0f0',
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
  },
  cancelBtnText: { fontSize: 16, fontWeight: '600', color: '#1a1a1a' },
  deleteBtn: {
    flex: 1,
    backgroundColor: '#fff0f0',
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#ffc5c5',
  },
  deleteBtnText: { fontSize: 16, fontWeight: '600', color: '#cc0000' },
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

- [ ] **Step 3: Run full suite**

```bash
npm test
```

Expected: 27 tests pass.

- [ ] **Step 4: Commit**

```bash
git add app/index.tsx components/document-card.tsx
git commit -m "feat: add search, sort, multi-select, duplicate, merge to home screen"
```

---

## Self-Review

### Spec coverage check

| Spec requirement | Task |
|---|---|
| Export fix: spinner kept visible during PDF gen | Task 7 |
| Export fix: onClose after shareAsync | Task 7 |
| Print option in export sheet | Task 7 |
| Thumbnail strip in viewer | Task 8 |
| Add Pages button in strip | Task 8 + Task 11 |
| Per-page ••• menu in viewer | Task 11 |
| Rotate CW/CCW | Tasks 3 + 9 + 11 |
| Filter strip (Original/Grayscale/B&W/Enhanced) | Tasks 2 + 9 + 11 |
| Filters display via RN filter style | Tasks 2 + 8 + 9 + 11 |
| Filters in PDF export via CSS | Tasks 6 + 7 |
| Delete single page | Tasks 4 + 9 + 11 |
| Reorder pages via drag | Tasks 10 + 11 |
| Viewer holds doc in state for live updates | Task 11 |
| Search bar on home screen | Task 15 |
| Sort by date/name with persistence | Tasks 5 + 12 + 15 |
| Multi-select mode with batch delete | Task 15 |
| Long-press → DocActionsSheet | Tasks 13 + 15 |
| Duplicate document | Tasks 4 + 13 + 15 |
| Merge documents | Tasks 4 + 14 + 15 |
| RenameSheet triggered from DocActionsSheet | Tasks 13 + 15 |
| Home screen reloads on focus | Task 15 (useFocusEffect) |
| Share individual page from viewer | Task 11 |
| PageFilter type + Document.filters field | Task 2 |
| lib/filters.ts filterStyle + filterCss | Task 2 |
| lib/storage SortKey, getSortPreference, saveSortPreference | Task 5 |
| lib/files replacePage, appendPages, deleteSinglePage, reorderPages, copyDocumentFiles | Task 4 |
| BottomSheet onClose optional (for loading lock) | Task 7 |

All requirements covered. ✓

### Type consistency check

- `PageFilter`: defined in `types/document.ts` Task 2, used in Tasks 3, 4, 8, 9, 10, 11, 15 — consistent.
- `SortKey`: exported from `lib/storage.ts` Task 5, imported in Tasks 12, 15 — consistent.
- `rotatePage(uri, direction, docId, pageIndex)`: defined Task 3, called Task 11 — matches.
- `appendPages(tempUris, docId, startIndex)`: defined Task 4, called Tasks 11, 15 — matches.
- `deleteSinglePage(docId, pageIndex, totalPages)`: defined Task 4, called Task 11 — matches.
- `reorderPages(docId, newOrderIndices)`: defined Task 4, called Task 11 — matches.
- `copyDocumentFiles(sourceId, destId, pages)`: defined Task 4, called Task 15 — matches.
- `generatePdf(pages, filters?)`: defined Task 6, called Task 7 — matches.
- `filterStyle(filter?)`: defined Task 2, called Tasks 8, 9, 10, 11 — matches.
- `filterCss(filter?)`: defined Task 2, called Tasks 6, 7 — matches.
- `getSortPreference()`: defined Task 5, called Task 15 — matches.
- `saveSortPreference(key)`: defined Task 5, called Task 15 — matches.
