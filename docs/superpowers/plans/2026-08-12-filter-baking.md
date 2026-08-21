# Filter Baking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.


> **Status: implemented (2026-08-21).** All code tasks are done and committed on
> `feat/seamless-scan-flow`. Verified on device: a colour page bakes to correctly
> luminance-weighted grey; `page-N.orig.jpg` is created and stays aligned through
> rotate, crop, delete and reorder; the v2→v3 migration bakes previously-recorded
> filters without losing documents; and the filter picker shows four genuinely
> different previews.
>
> **Not verified:** Enhanced applied to a *new* scan (needs a camera), and the
> "Enhancing…" progress pill — single bakes finish in about a second, faster than a
> screenshot round-trip, and the startup migration completes while the app is still
> on the splash screen.
>
> Two defects found only by running this, both fixed and both silent in the tests:
> `ctx.filter` is a no-op in this WebKit (the canvas re-encoded unchanged), and a
> baker mounted only at the root is buried under the viewer's `fullScreenModal`,
> so iOS never loads its WebView at all.

**Goal:** Make Grayscale, B&W and Enhanced actually change the image on iOS, and default new scans to Enhanced so they look like scans rather than photos.

**Architecture:** React Native 0.81's iOS `filter` style supports only `brightness` and `opacity`, so filters are baked into the pixels instead of applied at render. A hidden WebView draws the page to a canvas with `ctx.filter` set and returns JPEG bytes — the same pipeline `app/annotate.tsx` already uses. `page-N.orig.jpg` preserves the unfiltered source so filter changes never compound JPEG loss. Once pixels are baked, `document.filters` becomes a record of what is already in the image, and every render/export site stops re-applying it.

**Tech Stack:** react-native-webview, expo-file-system (legacy API for read/write), AsyncStorage, Jest.

**Prerequisite:** `docs/superpowers/plans/2026-08-12-seamless-scan-flow.md` is complete (branch `feat/seamless-scan-flow`).

---

## Why this shape

RN 0.81 `React/Fabric/Mounting/ComponentViews/View/RCTViewComponentView.mm`, the `// filter` block, loops over filter primitives and handles only `FilterType::Brightness` and `FilterType::Opacity`. `grayscale`, `contrast` and `saturate` are silently dropped. An earlier fix that swapped a CSS string for the array form could not have worked — the array parses fine, iOS ignores the primitives regardless.

WebKit supports all of them, which is also why PDF export (which injects real CSS into `expo-print` HTML) has been producing correctly filtered output the whole time while the screen showed nothing.

## Ordering constraint

Removing filter re-application before baking exists would visibly break filters on Android, where the RN `filter` style does work. Baking existing documents must therefore land BEFORE the removal, and the removal must land WITH the new-save wiring, or exports would double-apply. The task order below encodes that; do not reorder.

---

### Task 1: Pure bake HTML builder

**Files:**
- Create: `lib/bake-html.ts`
- Test: `__tests__/bake-html.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/bake-html.test.ts
import { buildBakeHtml } from '../lib/bake-html';

test('draws at natural size and applies the css filter', () => {
  const html = buildBakeHtml('file:///docs/d1/page-0.orig.jpg', 'grayscale(100%)');
  expect(html).toContain('file:///docs/d1/page-0.orig.jpg');
  expect(html).toContain("ctx.filter = 'grayscale(100%)'");
  expect(html).toContain('naturalWidth');
  expect(html).toContain("toDataURL('image/jpeg'");
});

test('escapes quotes in the css so it cannot break out of the string literal', () => {
  const html = buildBakeHtml('file:///a.jpg', "grayscale(1)'; alert('x');//");
  expect(html).not.toContain("alert('x')");
});

test('reports load failure back to the host instead of hanging', () => {
  const html = buildBakeHtml('file:///missing.jpg', 'none');
  expect(html).toContain('onerror');
  expect(html).toContain('BAKE_ERROR');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/bake-html.test.ts`
Expected: FAIL — `Cannot find module '../lib/bake-html'`

- [ ] **Step 3: Write the implementation**

```ts
// lib/bake-html.ts

/** Single-quote-safe embedding of a CSS filter string into a JS string literal. */
function escapeJsString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
}

/**
 * HTML that draws `fileSrc` to an offscreen canvas at its natural pixel size with
 * `css` applied, then posts the result back as a JPEG data URL.
 *
 * Mirrors the pipeline in app/annotate.tsx, which is the only proven way to get
 * transformed pixels back out of an image in this app: expo-image-manipulator does
 * geometry only (resize/rotate/flip/crop/extent) and cannot apply colour filters.
 *
 * The host MUST render the WebView with allowFileAccess, allowFileAccessFromFileURLs
 * and allowUniversalAccessFromFileURLs, or the canvas is tainted by the file:// image
 * and toDataURL throws a SecurityError.
 */
export function buildBakeHtml(fileSrc: string, css: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#000;">
<img id="src" src="${fileSrc}" crossorigin="anonymous" style="display:none" />
<script>
function post(msg) { window.ReactNativeWebView.postMessage(msg); }
var img = document.getElementById('src');
img.onerror = function () { post('BAKE_ERROR:load'); };
img.onload = function () {
  try {
    var w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) { post('BAKE_ERROR:empty'); return; }
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.filter = '${escapeJsString(css)}';
    ctx.drawImage(img, 0, 0, w, h);
    post(c.toDataURL('image/jpeg', 0.92));
  } catch (e) {
    post('BAKE_ERROR:' + (e && e.message ? e.message : 'unknown'));
  }
};
if (img.complete) img.onload();
</script>
</body>
</html>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/bake-html.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add lib/bake-html.ts __tests__/bake-html.test.ts
git commit -m "feat: pure HTML builder for canvas filter baking"
```

---

### Task 2: `.orig` source helpers

**Files:**
- Modify: `lib/files.ts`
- Test: `__tests__/files.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `__tests__/files.test.ts`, following that file's existing mocking style (it mocks `expo-file-system`, not first-party modules):

```ts
describe('originals', () => {
  test('ensureOriginal copies the page on first call and returns the .orig uri', () => {
    const uri = ensureOriginal('doc-1', 0);
    expect(uri).toContain('page-0.orig.jpg');
    // the page was copied to the .orig side file
    expect(copySpy).toHaveBeenCalled();
  });

  test('ensureOriginal is idempotent — an existing .orig is never overwritten', () => {
    ensureOriginal('doc-1', 0);
    copySpy.mockClear();
    ensureOriginal('doc-1', 0);
    expect(copySpy).not.toHaveBeenCalled();
  });

  test('originalUri points at the .orig side file without creating it', () => {
    expect(originalUri('doc-1', 2)).toContain('page-2.orig.jpg');
  });
});
```

Wire `copySpy` to whatever the file's existing `expo-file-system` mock exposes for `File.copy` — read the top of `__tests__/files.test.ts` and match it rather than inventing a new mock shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/files.test.ts`
Expected: FAIL — `ensureOriginal is not defined`

- [ ] **Step 3: Write the implementation**

Add to `lib/files.ts`:

```ts
/** URI of a page's pristine pre-bake source, whether or not it exists yet. */
export function originalUri(docId: string, pageIndex: number): string {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  return new File(dir, `page-${pageIndex}.orig.jpg`).uri;
}

/**
 * Ensures `page-N.orig.jpg` exists, creating it from the current page on first call.
 *
 * Called immediately before the first bake of a page, so the stored `.orig` is always
 * the unfiltered image. Idempotent: once it exists it is never rewritten, so repeated
 * filter changes always re-derive from the same pristine source instead of compounding
 * JPEG loss.
 */
export function ensureOriginal(docId: string, pageIndex: number): string {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  const orig = new File(dir, `page-${pageIndex}.orig.jpg`);
  if (!orig.exists) {
    new File(dir, `page-${pageIndex}.jpg`).copy(orig);
  }
  return orig.uri;
}
```

Also extend `STALE_TEMP` handling: `.orig.jpg` files are NOT temp files and must never be swept. Verify `garbageCollectOrphans`'s `STALE_TEMP` patterns do not match `page-N.orig.jpg` — `/\.new\.jpg$/`, `/\.tmp\.jpg$/`, `/\.shifting\.jpg$/` and `/^page-tmp-.*\.jpg$/` do not, so no change is needed. Add a test asserting that, so a future pattern change cannot silently start deleting originals:

```ts
test('garbageCollectOrphans never deletes .orig sources', async () => {
  // seed a valid doc dir containing page-0.jpg and page-0.orig.jpg, then:
  await garbageCollectOrphans(['doc-1']);
  // assert page-0.orig.jpg still exists
});
```

- [ ] **Step 4: Run tests**

Run: `npx jest __tests__/files.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/files.ts __tests__/files.test.ts
git commit -m "feat: .orig pristine-source helpers for filter baking"
```

---

### Task 3: Record a baked filter atomically

`document.filters` is an array, so recording one page's filter is a read-modify-write and needs the same single-lock treatment `patchDocument` already uses — otherwise a concurrent rename or a second page's bake clobbers it.

**Files:**
- Modify: `lib/storage.ts`
- Test: `__tests__/storage.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('setPageBaked', () => {
  test('records the filter for one page without disturbing the others', async () => {
    await saveDocument({ id: 'd1', name: 'D', pages: ['a', 'b', 'c'], createdAt: 1, updatedAt: 1 });
    await setPageBaked('d1', 1, 'grayscale', undefined);
    const doc = (await getDocuments()).find(d => d.id === 'd1')!;
    expect(doc.filters).toEqual(['original', 'grayscale', 'original']);
  });

  test('is a no-op for a document deleted mid-bake', async () => {
    await expect(setPageBaked('gone', 0, 'bw', undefined)).resolves.toBeUndefined();
  });

  test('preserves a concurrent rename', async () => {
    await saveDocument({ id: 'd1', name: 'Old', pages: ['a'], createdAt: 1, updatedAt: 1 });
    await updateDocument({ id: 'd1', name: 'New', pages: ['a'], createdAt: 1, updatedAt: 2 });
    await setPageBaked('d1', 0, 'enhanced', undefined);
    const doc = (await getDocuments()).find(d => d.id === 'd1')!;
    expect(doc.name).toBe('New');
    expect(doc.filters).toEqual(['enhanced']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/storage.test.ts -t setPageBaked`
Expected: FAIL — `setPageBaked is not a function`

- [ ] **Step 3: Write the implementation**

Add to `lib/storage.ts`, modelled directly on `patchDocument` (read + merge + write inside ONE `withDocsLock`):

```ts
/**
 * Record that page `pageIndex` now has `filter`/`adjustment` baked into its pixels.
 *
 * Read-modify-write of the filters/adjustments arrays happens inside a single lock
 * acquisition so concurrent bakes of sibling pages — and concurrent renames — cannot
 * clobber each other. No-op if the document was deleted mid-bake.
 */
export function setPageBaked(
  id: string,
  pageIndex: number,
  filter: PageFilter,
  adjustment: PageAdjustment | undefined,
): Promise<void> {
  return withDocsLock(async () => {
    await ensureMigrated();
    const raw = await AsyncStorage.getItem(docKey(id));
    if (raw == null) return;
    let doc: Document;
    try {
      doc = JSON.parse(raw) as Document;
    } catch {
      console.warn(`storage: corrupt doc ${id}, skipping setPageBaked`);
      return;
    }
    const filters = doc.filters ?? doc.pages.map(() => 'original' as PageFilter);
    filters[pageIndex] = filter;
    const allOriginal = filters.every(f => f === 'original');

    let adjustments = doc.adjustments;
    if (adjustment) {
      adjustments = adjustments ?? doc.pages.map(() => ({ brightness: 0, contrast: 0, saturation: 0 }));
      adjustments[pageIndex] = adjustment;
    }

    await AsyncStorage.setItem(docKey(id), JSON.stringify({
      ...doc,
      filters: allOriginal ? undefined : filters,
      adjustments,
      updatedAt: Date.now(),
    }));
  });
}
```

Import `PageAdjustment` alongside the existing `PageFilter` import if it is not already imported.

- [ ] **Step 4: Run tests**

Run: `npx jest __tests__/storage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/storage.ts __tests__/storage.test.ts
git commit -m "feat: setPageBaked records a baked filter under a single lock"
```

---

### Task 4: Bake job queue

Baking needs a WebView, which is a React component, but the callers (`ScanContext`, the viewer) are not always mounted where a WebView can live. A module-level queue decouples them: callers enqueue, a single host component drains.

**Files:**
- Create: `lib/bake-queue.ts`
- Test: `__tests__/bake-queue.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { enqueueBake, takeNextJob, completeJob, failJob, pendingCount } from '../lib/bake-queue';

beforeEach(() => { while (takeNextJob()) { /* drain */ } });

test('jobs come out in FIFO order', () => {
  enqueueBake({ docId: 'd', pageIndex: 0, src: 'a', css: 'none' });
  enqueueBake({ docId: 'd', pageIndex: 1, src: 'b', css: 'none' });
  expect(takeNextJob()!.pageIndex).toBe(0);
  expect(takeNextJob()!.pageIndex).toBe(1);
  expect(takeNextJob()).toBeNull();
});

test('completeJob resolves the enqueuer', async () => {
  const p = enqueueBake({ docId: 'd', pageIndex: 0, src: 'a', css: 'none' });
  const job = takeNextJob()!;
  completeJob(job.id, 'data:image/jpeg;base64,AAA');
  await expect(p).resolves.toBe('data:image/jpeg;base64,AAA');
});

test('failJob rejects the enqueuer', async () => {
  const p = enqueueBake({ docId: 'd', pageIndex: 0, src: 'a', css: 'none' });
  const job = takeNextJob()!;
  failJob(job.id, 'load');
  await expect(p).rejects.toThrow('load');
});

test('pendingCount reflects the queue', () => {
  expect(pendingCount()).toBe(0);
  enqueueBake({ docId: 'd', pageIndex: 0, src: 'a', css: 'none' });
  expect(pendingCount()).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/bake-queue.test.ts`
Expected: FAIL — `Cannot find module '../lib/bake-queue'`

- [ ] **Step 3: Write the implementation**

```ts
// lib/bake-queue.ts

export type BakeJobInput = {
  docId: string;
  pageIndex: number;
  /** file:// URI of the pristine source to bake from. */
  src: string;
  /** CSS filter string, or 'none'. */
  css: string;
};

export type BakeJob = BakeJobInput & { id: number };

type Pending = {
  job: BakeJob;
  resolve: (dataUrl: string) => void;
  reject: (err: Error) => void;
};

let _nextId = 1;
const _queue: Pending[] = [];
const _inFlight = new Map<number, Pending>();
let _notify: (() => void) | null = null;

/** Called by the host component so it knows to drain. */
export function setBakeNotifier(fn: (() => void) | null): void {
  _notify = fn;
}

/** Queue a bake. Resolves with the JPEG data URL, rejects if the bake failed. */
export function enqueueBake(input: BakeJobInput): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    _queue.push({ job: { ...input, id: _nextId++ }, resolve, reject });
    _notify?.();
  });
}

/** Host pulls the next job, or null when idle. */
export function takeNextJob(): BakeJob | null {
  const next = _queue.shift();
  if (!next) return null;
  _inFlight.set(next.job.id, next);
  return next.job;
}

export function completeJob(id: number, dataUrl: string): void {
  const p = _inFlight.get(id);
  if (!p) return;
  _inFlight.delete(id);
  p.resolve(dataUrl);
}

export function failJob(id: number, reason: string): void {
  const p = _inFlight.get(id);
  if (!p) return;
  _inFlight.delete(id);
  p.reject(new Error(reason));
}

export function pendingCount(): number {
  return _queue.length;
}
```

- [ ] **Step 4: Run tests**

Run: `npx jest __tests__/bake-queue.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add lib/bake-queue.ts __tests__/bake-queue.test.ts
git commit -m "feat: FIFO queue decoupling bake requests from the WebView host"
```

---

### Task 5: The hidden WebView baker

**Files:**
- Create: `components/filter-baker.tsx`
- Modify: `app/_layout.tsx`

- [ ] **Step 1: Write the component**

```tsx
// components/filter-baker.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import { buildBakeHtml } from '@/lib/bake-html';
import { BakeJob, completeJob, failJob, setBakeNotifier, takeNextJob } from '@/lib/bake-queue';

/**
 * Off-screen WebView that turns queued bake jobs into filtered JPEG bytes.
 *
 * Mounted once at the app root. RN 0.81's iOS `filter` style supports only
 * brightness/opacity, so grayscale/contrast/saturate have to be rendered by WebKit
 * and read back through a canvas — the same trick app/annotate.tsx uses.
 *
 * One job at a time: each job replaces the WebView's HTML, and the result arrives
 * via onMessage. The file-access props are load-bearing — without
 * allowUniversalAccessFromFileURLs the canvas is tainted by the file:// image and
 * toDataURL throws SecurityError.
 */
export function FilterBaker() {
  const [job, setJob] = useState<BakeJob | null>(null);
  const busyRef = useRef(false);

  const pump = useCallback(() => {
    if (busyRef.current) return;
    const next = takeNextJob();
    if (!next) return;
    busyRef.current = true;
    setJob(next);
  }, []);

  useEffect(() => {
    setBakeNotifier(pump);
    pump();
    return () => setBakeNotifier(null);
  }, [pump]);

  const handleMessage = useCallback((e: { nativeEvent: { data: string } }) => {
    const current = job;
    if (!current) return;
    const data = e.nativeEvent.data;
    if (data.startsWith('BAKE_ERROR:')) {
      failJob(current.id, data.slice('BAKE_ERROR:'.length));
    } else if (data.startsWith('data:image')) {
      completeJob(current.id, data);
    } else {
      failJob(current.id, 'unexpected message');
    }
    setJob(null);
    busyRef.current = false;
    pump();
  }, [job, pump]);

  if (!job) return null;

  return (
    <View style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }} pointerEvents="none">
      <WebView
        source={{ html: buildBakeHtml(job.src, job.css), baseUrl: 'file:///' }}
        onMessage={handleMessage}
        originWhitelist={['*']}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        javaScriptEnabled
        style={{ width: 1, height: 1 }}
      />
    </View>
  );
}
```

- [ ] **Step 2: Mount it at the root**

In `app/_layout.tsx`, render `<FilterBaker />` inside the provider tree, as a sibling of the existing `<LockGate>` block so it stays mounted across navigation. Import it from `@/components/filter-baker`.

- [ ] **Step 3: Typecheck**

Run: `node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`
Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add components/filter-baker.tsx app/_layout.tsx
git commit -m "feat: off-screen WebView host that bakes queued filter jobs"
```

---

### Task 6: `bakePage` orchestrator

**Files:**
- Create: `lib/bake.ts`
- Test: `__tests__/bake.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { bakePage } from '../lib/bake';

jest.mock('../lib/bake-queue', () => ({ enqueueBake: jest.fn(async () => 'data:image/jpeg;base64,QUJD') }));
jest.mock('../lib/files', () => ({
  ensureOriginal: jest.fn(() => 'file:///d/page-0.orig.jpg'),
  originalUri: jest.fn(() => 'file:///d/page-0.orig.jpg'),
}));
jest.mock('../lib/storage', () => ({ setPageBaked: jest.fn(async () => {}) }));
jest.mock('expo-file-system/legacy', () => ({ writeAsStringAsync: jest.fn(async () => {}) }));

const { setPageBaked } = require('../lib/storage');
const FS = require('expo-file-system/legacy');
const { enqueueBake } = require('../lib/bake-queue');

beforeEach(() => jest.clearAllMocks());

test('writes the baked bytes to the page and records the filter', async () => {
  await bakePage('d1', 0, 'grayscale', undefined);
  expect(FS.writeAsStringAsync).toHaveBeenCalledWith(
    expect.stringContaining('page-0.jpg'), 'QUJD', { encoding: 'base64' },
  );
  expect(setPageBaked).toHaveBeenCalledWith('d1', 0, 'grayscale', undefined);
});

test('records nothing when the bake fails, so pixels and metadata stay consistent', async () => {
  (enqueueBake as jest.Mock).mockRejectedValueOnce(new Error('load'));
  await expect(bakePage('d1', 0, 'bw', undefined)).rejects.toThrow('load');
  expect(FS.writeAsStringAsync).not.toHaveBeenCalled();
  expect(setPageBaked).not.toHaveBeenCalled();
});

test('an original filter with no adjustment still restores from .orig', async () => {
  await bakePage('d1', 0, 'original', undefined);
  expect(enqueueBake).toHaveBeenCalledWith(expect.objectContaining({ css: 'none' }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/bake.test.ts`
Expected: FAIL — `Cannot find module '../lib/bake'`

- [ ] **Step 3: Write the implementation**

```ts
// lib/bake.ts
import * as FileSystem from 'expo-file-system/legacy';
import { Directory, File, Paths } from 'expo-file-system';
import { PageAdjustment, PageFilter } from '../types/document';
import { combinedFilterCss } from './filters';
import { ensureOriginal } from './files';
import { enqueueBake } from './bake-queue';
import { setPageBaked } from './storage';

/**
 * Bake `filter` + `adjustment` into page `pageIndex`'s pixels.
 *
 * Always renders from `page-N.orig.jpg` (created on first bake) so repeated changes
 * re-derive from the pristine source instead of stacking JPEG loss — and so going
 * back to Original is possible.
 *
 * The filter is recorded ONLY after the write succeeds. Until then the document is
 * honestly unfiltered: pixels and metadata agree, so an export that races the bake
 * produces unenhanced output rather than wrong output.
 */
export async function bakePage(
  docId: string,
  pageIndex: number,
  filter: PageFilter,
  adjustment: PageAdjustment | undefined,
): Promise<void> {
  const src = ensureOriginal(docId, pageIndex);
  const css = combinedFilterCss(filter, adjustment);
  const dataUrl = await enqueueBake({ docId, pageIndex, src, css });
  const b64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
  const dest = new File(new Directory(Paths.document, 'scan-kit', docId), `page-${pageIndex}.jpg`);
  await FileSystem.writeAsStringAsync(dest.uri, b64, { encoding: 'base64' });
  await setPageBaked(docId, pageIndex, filter, adjustment);
}
```

- [ ] **Step 4: Run tests**

Run: `npx jest __tests__/bake.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add lib/bake.ts __tests__/bake.test.ts
git commit -m "feat: bakePage orchestrator writing filtered pixels from .orig"
```

---

### Task 7: Migrate existing documents (schema v3)

Existing documents store unfiltered pixels and rely on render-time filtering. Once that is removed they would silently appear unfiltered, so their recorded filters must be baked in first.

**Files:**
- Modify: `lib/storage.ts`
- Test: `__tests__/storage.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('v2 → v3 migration', () => {
  test('flags documents with a recorded filter as needing a bake', async () => {
    // seed a v2 doc with filters: ['grayscale']
    const pending = await pendingBakeMigrations();
    expect(pending).toEqual([{ docId: 'd1', pageIndex: 0, filter: 'grayscale', adjustment: undefined }]);
  });

  test('ignores documents whose pages are all original with default adjustments', async () => {
    const pending = await pendingBakeMigrations();
    expect(pending).toEqual([]);
  });

  test('is idempotent — a page already baked is not returned again', async () => {
    // after markBakeMigrationDone, the same doc yields nothing
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/storage.test.ts -t migration`
Expected: FAIL — `pendingBakeMigrations is not a function`

- [ ] **Step 3: Write the implementation**

Bump `CURRENT_SCHEMA_VERSION` from `'2'` to `'3'`.

The v3 step cannot bake inside `ensureMigrated` — baking needs the WebView, which is not mounted during a storage call, and `ensureMigrated` must not block reads. So v3 records WHAT needs baking and lets the app drain it:

```ts
/**
 * Pages whose recorded filter is not yet baked into their pixels.
 *
 * v3 moved filters from render-time to baked-in. Existing documents still hold
 * unfiltered pixels plus a filters array, so each such page needs one bake before
 * render-time filtering is removed, or they would silently appear unfiltered.
 *
 * Baking needs a mounted WebView, so this only reports the work; FilterBaker drains it.
 */
export async function pendingBakeMigrations(): Promise<
  { docId: string; pageIndex: number; filter: PageFilter; adjustment?: PageAdjustment }[]
>
```

Implement it by scanning all documents for pages with a non-`original` filter or a non-default adjustment, skipping any page whose `.orig` already exists (that page is already baked). Wrap each document in its own try/catch so one corrupt record cannot abort the sweep, matching `garbageCollectOrphans`.

- [ ] **Step 4: Drain it at startup**

In `app/_layout.tsx`, where `garbageCollectOrphans` is already called on mount, also call `pendingBakeMigrations()` and feed each entry to `bakePage`, sequentially, fire-and-forget with a `.catch`. Sequential matters: the baker handles one job at a time and a large library should not flood the queue.

- [ ] **Step 5: Run tests and commit**

Run: `npx jest`

```bash
git add lib/storage.ts app/_layout.tsx __tests__/storage.test.ts
git commit -m "feat: v3 migration bakes filters recorded by earlier versions"
```

---

### Task 8: Stop re-applying filters everywhere

Pixels are now baked, so any site that also applies the filter would double-apply it.

**Files:**
- Modify: `lib/pdf.ts`, `components/export-sheet.tsx`, `app/tools/watermark.tsx`, `app/tools/timestamp.tsx`, `app/tools/sign.tsx`
- Modify: `app/viewer.tsx`, `components/thumbnail-strip.tsx`, `components/reorder-modal.tsx`, `components/page-actions-sheet.tsx`
- Modify: `lib/filters.ts`
- Test: `__tests__/pdf.test.ts`, `__tests__/filters.test.ts`

- [ ] **Step 1: Write the failing regression test**

In `__tests__/pdf.test.ts`, assert the generated HTML carries NO `filter:` style, which is the guard against silently reintroducing double-application:

```ts
test('generated HTML does not re-apply filters — pixels are already baked', async () => {
  await generatePdf(['file:///d/page-0.jpg'], ['grayscale'], undefined, 'A4');
  const html = capturedHtml();
  expect(html).not.toContain('filter:');
});
```

Wire `capturedHtml()` to the existing `expo-print` mock in that file.

- [ ] **Step 2: Remove the CSS applications**

In each of `lib/pdf.ts` (both `generatePdf` and `generateSearchablePdf`), `components/export-sheet.tsx`, `app/tools/watermark.tsx`, `app/tools/timestamp.tsx`, `app/tools/sign.tsx`: delete the `combinedFilterCss(...)` call and the `filter:${css};` it injects. Leave every other style intact.

- [ ] **Step 3: Remove the RN style applications**

In `app/viewer.tsx`, `components/thumbnail-strip.tsx`, `components/reorder-modal.tsx`: delete the `combinedFilterRN(...)` call and the `filter` style it produced.

`components/page-actions-sheet.tsx` is the exception — its filter PREVIEW tiles must still show what each filter would look like BEFORE it is applied. Leave those tiles rendering from the RN style for now and add a comment noting they are previews of an unapplied filter, not a render of the stored page. (Making the previews accurate is follow-on work; on iOS they will continue to show the unfiltered image.)

- [ ] **Step 4: Delete `combinedFilterRN`**

It now has one remaining consumer (the preview tiles). Keep it, and update its doc comment to say it is preview-only and does not reflect stored pixels — it is NOT the render path any more.

Update `__tests__/filters.test.ts` accordingly.

- [ ] **Step 5: Verify and commit**

Run: `npx jest`, `node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`

```bash
git add -A
git commit -m "refactor: stop re-applying filters now that pixels are baked"
```

---

### Task 9: Bake on save, bake on change, default to Enhanced

**Files:**
- Modify: `contexts/scan-context.tsx`, `app/viewer.tsx`, `lib/storage.ts`

- [ ] **Step 1: Bake newly saved pages**

In `saveAndOpen`, after the save succeeds and alongside the existing `indexDocText` call, bake each page sequentially, fire-and-forget:

```tsx
if (pages.length && filter !== 'original') {
  (async () => {
    for (let i = 0; i < pages.length; i++) {
      try { await bakePage(id, i, filter as PageFilter, undefined); } catch { /* page keeps raw pixels */ }
    }
  })();
}
```

Sequential, not `Promise.all` — the baker processes one job at a time and a 20-page scan must not flood the queue. A failed page keeps its raw pixels and no recorded filter, which stays consistent.

- [ ] **Step 2: Re-bake when the user changes a filter or adjustment**

In `app/viewer.tsx`, `handleFilter` and `handleAdjust` currently write `filters`/`adjustments` straight to the document. Change both to call `bakePage(document.id, currentPage, filter, adjustment)` instead — `bakePage` records the metadata itself via `setPageBaked`, so remove the direct `saveDoc` write of those two fields to avoid two writers.

Keep `handleAdjust`'s 250 ms debounce, but debounce the BAKE rather than the write — a bake per slider frame would be pathological.

After a successful bake, refresh the viewer's `document` state from storage so the new `updatedAt` busts the `?v=` image cache and the user sees the change.

- [ ] **Step 3: Default new scans to Enhanced**

In `lib/storage.ts`, change `DEFAULT_SCAN_SETTINGS.defaultFilter` from `'original'` to `'enhanced'`.

- [ ] **Step 4: Verify and commit**

Run: `npx jest`, `node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`, `node node_modules/eslint/bin/eslint.js app components lib contexts types`

```bash
git add -A
git commit -m "feat: bake filters on save and on change, default to Enhanced"
```

---

### Task 10: Verify on device

**Files:** none

Static checks cannot prove any of this. The WebView bake pipeline in particular is entirely unexercised by the unit tests, which mock the queue.

- [ ] **Step 1: Get the app running**

The local toolchain currently fails at startup with `MessageQueue doesn't exist` — this is NOT caused by these changes (`main` fails identically). See the notes at the end of `2026-08-12-seamless-scan-flow.md`. Resolve that first.

- [ ] **Step 2: Check, in order**

1. A new scan/import saves, opens the viewer, and the page visibly becomes enhanced a moment later.
2. `page-N.orig.jpg` exists alongside `page-N.jpg` in the document's directory.
3. Switching Grayscale → B&W → Original in the viewer visibly changes the image, and Original restores the unfiltered look exactly.
4. Exported PDF matches what is on screen — not double-filtered, not unfiltered.
5. A document created before this change still shows its filter after the migration runs.

- [ ] **Step 3: Record the outcome in the PR description**
