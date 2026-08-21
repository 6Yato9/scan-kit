# Seamless Scan Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.


> **Status: implemented (2026-08-21).** All code tasks are done and committed on
> `feat/seamless-scan-flow`. Verified on the iPhone 16 Pro Max simulator: rename
> from the viewer header, Crop in the page-actions sheet, and the viewer opening a
> document.
>
> **Not verified end-to-end:** the auto-save → viewer flow itself. It cannot be
> driven here — the simulator has no camera for `DocumentScanner`, and the system
> photo/document pickers run out-of-process so injected taps never reach them.
> Documents were seeded directly into the app container instead. Needs a real
> device (or a hand-driven picker) to confirm.

**Goal:** Finishing a capture saves the document and opens it in the viewer, with zero app-level taps.

**Architecture:** The review screen is deleted. `ScanContext` gains a `saveScan()` that writes pages, saves the document, and returns its id; every entry point calls it and then routes to `/viewer`. Rename and Crop move into the viewer so it becomes the single place documents are refined.

**Tech Stack:** Expo SDK 54, expo-router, React Native 0.81, AsyncStorage, expo-crypto, expo-image-manipulator.

**Scope note:** Filter baking is a separate plan (`2026-08-12-filter-baking.md`). This plan leaves `DEFAULT_SCAN_SETTINGS.defaultFilter` at `'original'` — flipping it to `'enhanced'` before baking exists would be a silent no-op on iOS.

---

### Task 1: Extract the save path into `saveScan()`

The save logic currently lives inside `app/review.tsx` `handleSave` (lines 105–169) and is about to be deleted with it. Move it to `lib/save-scan.ts` first, unchanged in behaviour, so it survives and is unit-testable.

**Files:**
- Create: `lib/save-scan.ts`
- Test: `__tests__/save-scan.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/save-scan.test.ts
import { saveScan } from '../lib/save-scan';

jest.mock('expo-crypto', () => ({ randomUUID: () => 'fixed-id' }));
jest.mock('../lib/files', () => ({
  copyPageWithQuality: jest.fn(async (_uri: string, docId: string, i: number) =>
    `file:///docs/${docId}/page-${i}.jpg`),
  copyPdfToStorage: jest.fn(() => 'file:///docs/fixed-id/document.pdf'),
  deleteDocumentFiles: jest.fn(),
}));
jest.mock('../lib/storage', () => ({ saveDocument: jest.fn(async () => {}) }));

const { saveDocument } = require('../lib/storage');
const { deleteDocumentFiles, copyPageWithQuality } = require('../lib/files');

beforeEach(() => jest.clearAllMocks());

test('saves pages in order and returns the new document id', async () => {
  const id = await saveScan({ pages: ['a.jpg', 'b.jpg'], name: 'Doc', quality: 0.9 });
  expect(id).toBe('fixed-id');
  const doc = (saveDocument as jest.Mock).mock.calls[0][0];
  expect(doc.pages).toEqual([
    'file:///docs/fixed-id/page-0.jpg',
    'file:///docs/fixed-id/page-1.jpg',
  ]);
  expect(doc.name).toBe('Doc');
});

test('cleans up partial files when a page fails', async () => {
  (copyPageWithQuality as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
  await expect(saveScan({ pages: ['a.jpg'], name: 'Doc', quality: 0.9 }))
    .rejects.toThrow('Page 1: disk full');
  expect(deleteDocumentFiles).toHaveBeenCalledWith('fixed-id');
  expect(saveDocument).not.toHaveBeenCalled();
});

test('a pdf import stores the pdf and saves no pages', async () => {
  const id = await saveScan({ pdfUri: 'tmp.pdf', name: 'Scanned PDF', quality: 0.9 });
  const doc = (saveDocument as jest.Mock).mock.calls[0][0];
  expect(id).toBe('fixed-id');
  expect(doc.pages).toEqual([]);
  expect(doc.pdfUri).toBe('file:///docs/fixed-id/document.pdf');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/save-scan.test.ts`
Expected: FAIL — `Cannot find module '../lib/save-scan'`

- [ ] **Step 3: Write the implementation**

```ts
// lib/save-scan.ts
import * as Crypto from 'expo-crypto';
import { Document, PageFilter } from '../types/document';
import { saveDocument } from './storage';
import { copyPageWithQuality, copyPdfToStorage, deleteDocumentFiles } from './files';

export type SaveScanInput = {
  pages?: string[];
  pdfUri?: string;
  name: string;
  quality: number;
  filters?: (PageFilter | 'original')[];
};

/**
 * Writes a scan to storage and returns the new document id.
 *
 * Pages are copied sequentially so a failure names the offending page and peak
 * memory stays bounded — Promise.all would run every manipulator pass at once.
 * On any failure the partially-written directory is removed so a retry starts clean.
 */
export async function saveScan(input: SaveScanInput): Promise<string> {
  const { pages = [], pdfUri, name, quality, filters } = input;
  const id = Crypto.randomUUID();
  const now = Date.now();

  try {
    if (pdfUri) {
      const storedUri = copyPdfToStorage(pdfUri, id);
      const doc: Document = {
        id, name, pages: [], pdfUri: storedUri, createdAt: now, updatedAt: now,
      };
      await saveDocument(doc);
      return id;
    }

    const savedPages: string[] = [];
    for (let i = 0; i < pages.length; i++) {
      try {
        savedPages.push(await copyPageWithQuality(pages[i], id, i, quality));
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        throw new Error(`Page ${i + 1}: ${m}`);
      }
    }

    const allOriginal = !filters || filters.every(f => f === 'original');
    const doc: Document = {
      id,
      name,
      pages: savedPages,
      filters: allOriginal ? undefined : (filters as PageFilter[]),
      createdAt: now,
      updatedAt: now,
    };
    await saveDocument(doc);
    return id;
  } catch (err) {
    try { deleteDocumentFiles(id); } catch { /* secondary failure — keep the original error */ }
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/save-scan.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add lib/save-scan.ts __tests__/save-scan.test.ts
git commit -m "refactor: extract saveScan from the review screen"
```

---

### Task 2: Index OCR text after a save

`handleSave` also fire-and-forgets OCR indexing (review.tsx:144–154). Preserve it as its own function so Task 1's `saveScan` stays synchronous in intent and this stays independently testable.

**Files:**
- Modify: `lib/save-scan.ts`
- Test: `__tests__/save-scan.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `__tests__/save-scan.test.ts`:

```ts
jest.mock('../lib/ocr', () => ({
  ocrAvailable: () => true,
  extractDocText: jest.fn(async () => 'recognised text'),
}));

test('indexDocText skips a document deleted during indexing', async () => {
  const { indexDocText } = require('../lib/save-scan');
  const storage = require('../lib/storage');
  storage.getDocuments = jest.fn(async () => []);
  storage.updateDocument = jest.fn(async () => {});

  await indexDocText('gone-id', ['p0.jpg']);
  expect(storage.updateDocument).not.toHaveBeenCalled();
});

test('indexDocText writes ocrText onto the current document', async () => {
  const { indexDocText } = require('../lib/save-scan');
  const storage = require('../lib/storage');
  storage.getDocuments = jest.fn(async () => [{ id: 'doc-1', name: 'Renamed', pages: [] }]);
  storage.updateDocument = jest.fn(async () => {});

  await indexDocText('doc-1', ['p0.jpg']);
  expect(storage.updateDocument).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'doc-1', name: 'Renamed', ocrText: 'recognised text' }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/save-scan.test.ts -t indexDocText`
Expected: FAIL — `indexDocText is not a function`

- [ ] **Step 3: Write the implementation**

Add to `lib/save-scan.ts`:

```ts
import { getDocuments, updateDocument } from './storage';
import { ocrAvailable, extractDocText } from './ocr';

/**
 * Fire-and-forget content index so search can match recognised text.
 *
 * Re-reads the document by id when OCR lands so we neither resurrect a document
 * the user deleted meanwhile nor clobber a rename or reorder made during the pass.
 */
export async function indexDocText(id: string, pages: string[]): Promise<void> {
  if (!ocrAvailable()) return;
  const text = await extractDocText(pages);
  if (!text) return;
  const current = (await getDocuments()).find(d => d.id === id);
  if (!current) return;
  await updateDocument({ ...current, ocrText: text });
}
```

Update the `saveScan` import line to pull `saveDocument` alongside the two new imports:

```ts
import { saveDocument, getDocuments, updateDocument } from './storage';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/save-scan.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add lib/save-scan.ts __tests__/save-scan.test.ts
git commit -m "refactor: extract indexDocText from the review screen"
```

---

### Task 3: Add `saveAndOpen` to ScanContext

Replace the pending-review machinery with a single call that saves and reports the new id. The caller navigates, so the context stays free of routing.

**Files:**
- Modify: `contexts/scan-context.tsx`

- [ ] **Step 1: Replace the context type and state**

Replace the `ScanContextType` block (lines 15–27) with:

```tsx
type SaveInput = {
  pages?: string[];
  pdfUri?: string;
  defaultFilter?: PageFilter | 'original';
};

type ScanContextType = {
  lastSaved: number;
  scanning: boolean;
  /** Scans, saves, and returns the new document id — or null if cancelled. */
  triggerScan: () => Promise<string | null>;
  /** Saves imported pages or a PDF, returning the new document id. */
  saveAndOpen: (input: SaveInput) => Promise<string | null>;
  bumpLastSaved: () => void;
};
```

Delete the `pendingPages`, `pendingPdfUri`, `pendingQuality`, `pendingDefaultFilter`,
`reviewVisible` state, the `latestRef` block, both `useEffect`s that restore and persist
pending state (lines 51–118), and `clearPending`.

- [ ] **Step 2: Implement `saveAndOpen` and rewrite `triggerScan`**

```tsx
const [lastSaved, setLastSaved] = useState(0);
const [scanning, setScanning] = useState(false);
const scanningRef = useRef(false);

const saveAndOpen = useCallback(async (input: SaveInput): Promise<string | null> => {
  const [scan, docSettings] = await Promise.all([getScanSettings(), getDocSettings()]);
  const filter = input.defaultFilter ?? scan.defaultFilter;
  const count = input.pages?.length ?? 0;
  try {
    const id = await saveScan({
      pages: input.pages,
      pdfUri: input.pdfUri,
      name: autoName(new Date(), docSettings.namePrefix),
      quality: QUALITY_MAP[scan.quality],
      filters: input.pages ? Array.from({ length: count }, () => filter) : undefined,
    });
    setLastSaved(Date.now());
    notifySuccess();
    return id;
  } catch (err) {
    notifyError();
    const msg = err instanceof Error ? err.message : 'Could not save the scan.';
    Alert.alert('Save failed', msg);
    return null;
  }
}, []);
```

- [ ] **Step 3: Rewrite `triggerScan` to save**

```tsx
const triggerScan = useCallback(async (): Promise<string | null> => {
  if (scanningRef.current) return null;
  scanningRef.current = true;
  setScanning(true);
  try {
    const settings = await getScanSettings();
    const { scannedImages } = await DocumentScanner.scanDocument({
      croppedImageQuality: SCAN_QUALITY_MAP[settings.quality],
      letUserAdjustCrop: settings.autoCrop,
    } as any);
    if (!scannedImages?.length) return null;
    return await saveAndOpen({ pages: scannedImages });
  } catch (err) {
    console.error('Scan failed', err);
    const msg = err instanceof Error ? err.message : String(err);
    if (/cancel|user.+(stop|dismiss)/i.test(msg)) return null;
    if (/permission|denied|not.+granted/i.test(msg)) {
      notifyError();
      Alert.alert(
        'Camera access needed',
        'Scan Kit needs Camera permission to scan documents. Open Settings to enable it.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => Linking.openSettings() },
        ],
      );
      return null;
    }
    notifyError();
    Alert.alert('Scan failed', 'Could not start the scanner. Try again.');
    return null;
  } finally {
    scanningRef.current = false;
    setScanning(false);
  }
}, [saveAndOpen]);
```

Update the imports at the top of the file:

```tsx
import { saveScan } from '@/lib/save-scan';
import { autoName } from '@/lib/auto-name';
import { getScanSettings, getDocSettings } from '@/lib/storage';
import { notifySuccess, notifyError } from '@/lib/haptics';
```

Remove the now-unused `File` import from `expo-file-system` and the
`clearPendingState`, `getPendingState`, `setPendingState`, `PendingState` imports.

Update the `useMemo` value to `{ lastSaved, scanning, triggerScan, saveAndOpen, bumpLastSaved }`
with matching deps.

- [ ] **Step 4: Typecheck**

Run: `node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`
Expected: errors only in files not yet updated (`app/review.tsx`, `app/(tabs)/_layout.tsx`,
`app/(tabs)/files.tsx`, `app/tools/book.tsx`, `app/tools/whiteboard.tsx`). Those are fixed in
Tasks 6–8.

- [ ] **Step 5: Commit**

```bash
git add contexts/scan-context.tsx
git commit -m "feat: ScanContext saves scans directly instead of staging a review"
```

---

### Task 4: Kick off OCR indexing after a save

**Files:**
- Modify: `contexts/scan-context.tsx`

- [ ] **Step 1: Index after a successful save**

In `saveAndOpen`, insert this immediately after `notifySuccess();` and before `return id;`:

```tsx
    if (input.pages?.length) {
      const stored = Array.from(
        { length: input.pages.length },
        (_, i) => `${Paths.document.uri}scan-kit/${id}/page-${i}.jpg`,
      );
      indexDocText(id, stored).catch(() => {});
    }
```

Add the imports:

```tsx
import { Paths } from 'expo-file-system';
import { saveScan, indexDocText } from '@/lib/save-scan';
```

- [ ] **Step 2: Typecheck**

Run: `node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`
Expected: no new errors in `contexts/scan-context.tsx`

- [ ] **Step 3: Commit**

```bash
git add contexts/scan-context.tsx
git commit -m "feat: index OCR text after an auto-saved scan"
```

---

### Task 5: Rename from the viewer

The viewer has no rename, and after auto-save it is where the user lands. `RenameSheet`
already exists and is used from the Files list; reuse it.

**Files:**
- Modify: `app/viewer.tsx`

- [ ] **Step 1: Import the sheet and add state**

```tsx
import { RenameSheet } from '@/components/rename-sheet';
```

Beside the other `useState` calls in `ViewerScreen`:

```tsx
const [renameVisible, setRenameVisible] = useState(false);
```

- [ ] **Step 2: Make the title tappable**

In the JPEG pager branch, replace the title line:

```tsx
        <Text style={styles.title} numberOfLines={1}>{document.name}</Text>
```

with:

```tsx
        <Pressable
          style={{ flex: 1 }}
          onPress={() => setRenameVisible(true)}
          accessibilityRole="button"
          accessibilityLabel={`Rename ${document.name}`}
        >
          <Text style={styles.title} numberOfLines={1}>{document.name}</Text>
        </Pressable>
```

Apply the same replacement in the PDF branch.

- [ ] **Step 3: Render the sheet**

Beside the other sheets near the end of the JPEG branch:

```tsx
      <RenameSheet
        visible={renameVisible}
        document={document}
        onRename={async (doc, newName) => {
          await saveDoc({ ...doc, name: newName, updatedAt: Date.now() });
          setRenameVisible(false);
        }}
        onDelete={async doc => {
          setRenameVisible(false);
          await deleteDocument(doc.id);
          deleteDocumentFiles(doc.id);
          router.back();
        }}
        onClose={() => setRenameVisible(false)}
      />
```

- [ ] **Step 4: Verify**

Run: `node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`
Expected: no new errors in `app/viewer.tsx`

- [ ] **Step 5: Commit**

```bash
git add app/viewer.tsx
git commit -m "feat: rename a document from the viewer header"
```

---

### Task 6: Crop from the page actions sheet

`CropModal`'s only consumer is `app/review.tsx`, which is deleted in Task 8. Move it to the
viewer so cropping survives.

**Files:**
- Modify: `components/page-actions-sheet.tsx`
- Modify: `app/viewer.tsx`

- [ ] **Step 1: Add an `onCrop` prop**

In `components/page-actions-sheet.tsx`, add to the props type:

```tsx
  onCrop: () => void;
```

Destructure `onCrop` alongside the other props, and add a Crop button immediately after
the Rotate R button, matching the existing action markup:

```tsx
            <Pressable style={styles.action} onPress={onCrop}>
              <Ionicons name="crop" size={22} color={colors.subtext} />
              <Text allowFontScaling={false} style={[styles.actionLabel, { color: colors.subtext }]}>Crop</Text>
            </Pressable>
```

- [ ] **Step 2: Wire it in the viewer**

In `app/viewer.tsx`:

```tsx
import { CropModal } from '@/components/crop-modal';
```

```tsx
const [cropVisible, setCropVisible] = useState(false);
```

Pass to `PageActionsSheet`:

```tsx
        onCrop={() => { setActionsVisible(false); setCropVisible(true); }}
```

And render the modal, replacing the current page with the cropped result:

```tsx
      {document.pages[currentPage] && (
        <CropModal
          visible={cropVisible}
          uri={document.pages[currentPage]}
          onCancel={() => setCropVisible(false)}
          onDone={async croppedUri => {
            const stored = replacePage(croppedUri, document.id, currentPage);
            const pages = [...document.pages];
            pages[currentPage] = stored;
            await saveDoc({ ...document, pages, updatedAt: Date.now() });
            setCropVisible(false);
          }}
        />
      )}
```

Add `replacePage` to the existing `@/lib/files` import.

`CropModal`'s props are `visible`, `uri`, `onCancel`, `onDone` (`components/crop-modal.tsx:20-25`),
and `saveDoc` already exists at `app/viewer.tsx:69`. `replacePage` is the atomic
copy-then-promote helper the rotate path already uses.

- [ ] **Step 3: Typecheck**

Run: `node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`
Expected: no new errors in `app/viewer.tsx` or `components/page-actions-sheet.tsx`

- [ ] **Step 4: Commit**

```bash
git add app/viewer.tsx components/page-actions-sheet.tsx
git commit -m "feat: crop a page from the viewer"
```

---

### Task 7: Route every entry point to the viewer

**Files:**
- Modify: `app/(tabs)/_layout.tsx`
- Modify: `app/(tabs)/files.tsx:110-150`
- Modify: `app/(tabs)/index.tsx`
- Modify: `app/tools/book.tsx:50-60`
- Modify: `app/tools/whiteboard.tsx:25-35`

- [ ] **Step 1: Remove the review redirect**

In `app/(tabs)/_layout.tsx`, delete the `reviewVisible` effect and its `useScan()` call:

```tsx
  const { reviewVisible } = useScan();
  useEffect(() => {
    if (reviewVisible) {
      router.push('/review');
    }
  }, [reviewVisible, router]);
```

Remove the now-unused `useScan`, `useEffect` and `useRouter` imports if nothing else in the
file uses them.

- [ ] **Step 2: Open the viewer after a scan**

Wherever `triggerScan` is invoked (the tab bar camera button in `app/(tabs)/_layout.tsx` and
the "Scan a document" button in `app/(tabs)/index.tsx`), await the id and navigate:

```tsx
  const id = await triggerScan();
  if (id) router.push({ pathname: '/viewer', params: { id } });
```

- [ ] **Step 3: Update the Files tab importers**

In `app/(tabs)/files.tsx`, change the `openImport` call:

```tsx
      const id = await saveAndOpen({ pages: result.assets.map(a => a.uri) });
      if (id) router.push({ pathname: '/viewer', params: { id } });
```

and the document picker branch:

```tsx
        const id = asset.mimeType === 'application/pdf'
          ? await saveAndOpen({ pdfUri: asset.uri })
          : await saveAndOpen({ pages: [asset.uri] });
        if (id) router.push({ pathname: '/viewer', params: { id } });
```

Update the destructure to `const { lastSaved, saveAndOpen } = useScan();`.

- [ ] **Step 4: Update the tools**

`app/tools/book.tsx`:

```tsx
      const id = await saveAndOpen({ pages: [leftResult.uri, rightResult.uri] });
      if (id) router.replace({ pathname: '/viewer', params: { id } });
```

`app/tools/whiteboard.tsx`:

```tsx
      const id = await saveAndOpen({ pages: scannedImages, defaultFilter: 'enhanced' });
      if (id) router.replace({ pathname: '/viewer', params: { id } });
```

Both change their destructure to `const { saveAndOpen } = useScan();`.

- [ ] **Step 5: Typecheck**

Run: `node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`
Expected: the only remaining errors are in `app/review.tsx`, deleted next.

- [ ] **Step 6: Commit**

```bash
git add "app/(tabs)/_layout.tsx" "app/(tabs)/files.tsx" "app/(tabs)/index.tsx" app/tools/book.tsx app/tools/whiteboard.tsx
git commit -m "feat: open the new document after scanning or importing"
```

---

### Task 8: Delete the review screen and the pending-state machinery

**Files:**
- Delete: `app/review.tsx`
- Modify: `lib/storage.ts:342-368`

- [ ] **Step 1: Delete the screen**

```bash
git rm app/review.tsx
```

- [ ] **Step 2: Remove pending-state storage**

In `lib/storage.ts`, delete the `PENDING_KEY` constant (line 14), the `PendingState` type,
and `getPendingState`, `setPendingState`, `clearPendingState` (lines 342–368).

- [ ] **Step 3: Confirm nothing references them**

Run: `grep -rn "PendingState\|getPendingState\|setPendingState\|clearPendingState\|reviewVisible\|/review" app components lib contexts`
Expected: no output.

- [ ] **Step 4: Full verification**

Run: `node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`
Expected: exit 0, no output

Run: `node node_modules/eslint/bin/eslint.js app components lib contexts types`
Expected: 0 errors

Run: `npx jest`
Expected: all suites pass

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: retire the review screen in favour of auto-save"
```

---

### Task 9: Verify the flow on the simulator

Static checks cannot confirm the flow. The iPhone 16 Pro Max (iOS 18.5, x86_64) is the only
usable simulator — ML Kit ships x86_64-only simulator slices, so iOS 26 devices cannot run
this app.

**Files:** none

- [ ] **Step 1: Build and launch**

```bash
node node_modules/expo/node_modules/@expo/cli/build/bin/cli run:ios --device 951A2AAD-8441-4685-87FA-56FBAE882DBA
```

- [ ] **Step 2: Confirm the import path**

The simulator has no camera, so `DocumentScanner` cannot be exercised. Use Files →
Import Images instead. Note that the system photo picker runs out-of-process and does not
accept injected taps — drive it by hand, or seed a document into the app container.

Expected: choosing images returns straight to the viewer on a new document, with no review
screen in between.

- [ ] **Step 3: Confirm rename and crop**

Expected: tapping the viewer title opens the rename sheet and the new name persists;
the page actions sheet offers Crop, and cropping replaces the current page.

- [ ] **Step 4: Commit nothing**

This task changes no files. Record the outcome in the PR description instead.

---

## Follow-on

`docs/superpowers/plans/2026-08-12-filter-baking.md` covers the WebView bake pipeline,
`page-N.orig.jpg`, the v2→v3 migration, removal of filter re-application across the 11 call
sites, and flipping `DEFAULT_SCAN_SETTINGS.defaultFilter` to `'enhanced'`.
