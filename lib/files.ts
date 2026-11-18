// lib/files.ts
//
// CRASH SAFETY. Page files are only ever replaced by a rename (File.move), never
// by delete-then-copy, so an app kill can't leave a page with no copy at all.
// The few multi-step operations (replace, reorder) leave recognisable side files
// while they run; the startup sweep (garbageCollectOrphans) finishes or undoes
// an interrupted one from those files instead of deleting them.
import { Directory, File, Paths } from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { cappedSize, getImageSize } from './image-size';
import { forgetDocumentOcr, pruneDocumentOcr } from './ocr-cache';

/**
 * Moves `side` into `dest`'s place. The old `dest` is deleted first because
 * File.move refuses an existing destination; if the app dies in between, the
 * sweep promotes the orphaned side file (see recoverInterrupted).
 */
function swapIn(side: File, dest: File): void {
  if (dest.exists) dest.delete();
  side.move(dest);
}

/** Copies (or moves) `src` to a fresh side file next to `dest`, replacing a stale one. */
function stage(src: File, side: File, how: 'copy' | 'move' = 'copy'): void {
  if (side.exists) side.delete();
  if (how === 'move') src.move(side);
  else src.copy(side);
}

// Pages are stored by position, so "page 3" after a reorder or delete is a
// different page. Anything that remembers a page by its index across user
// actions (retake Undo) checks this counter, bumped by every operation here
// that moves pages, to tell whether the index still means the same page.
const layoutGenerations = new Map<string, number>();

/** Changes whenever pages of `docId` are reordered or deleted (this session). */
export function pageLayoutGeneration(docId: string): number {
  return layoutGenerations.get(docId) ?? 0;
}

function bumpLayout(docId: string): void {
  layoutGenerations.set(docId, pageLayoutGeneration(docId) + 1);
}

/**
 * Deletes a document's folder: its pages, their shadows and the text
 * recognised on them (lib/ocr-cache keeps it in the folder's ocr/), plus that
 * text's in-memory copy.
 */
export function deleteDocumentFiles(docId: string): void {
  forgetDocumentOcr(docId);
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  if (dir.exists) {
    dir.delete();
  }
}

/**
 * Overwrites a stored page with a new file (e.g. after rotation).
 * The new bytes are copied to `page-N.new.jpg` first (a failed copy leaves the
 * page untouched), then renamed over the page. `newUri` is left in place.
 */
export function replacePage(newUri: string, docId: string, pageIndex: number): string {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  const dest = new File(dir, `page-${pageIndex}.jpg`);
  stage(new File(stripQuery(newUri)), new File(dir, `page-${pageIndex}.new.jpg`));
  swapIn(new File(dir, `page-${pageIndex}.new.jpg`), dest);
  return dest.uri;
}

/**
 * Overwrites a page's `.orig` shadow with a new file (e.g. after compression),
 * the same way as replacePage. No-op when the page has no shadow. Returns true
 * when a shadow was replaced.
 */
export function replaceOriginal(newUri: string, docId: string, pageIndex: number): boolean {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  const dest = new File(dir, `page-${pageIndex}.orig.jpg`);
  if (!dest.exists) return false;
  stage(new File(stripQuery(newUri)), new File(dir, `page-${pageIndex}.orig.new.jpg`));
  swapIn(new File(dir, `page-${pageIndex}.orig.new.jpg`), dest);
  return true;
}

/** Removes the `?v=` cache-bust suffix the UI appends to page URIs. */
function stripQuery(uri: string): string {
  return uri.split('?')[0];
}

/**
 * The `.orig` shadow that belongs to a stored page URI, or null when the URI
 * is not a stored page (e.g. a scanner or picker temp file).
 */
export function shadowOf(pageUri: string): string | null {
  const clean = stripQuery(pageUri);
  if (!/\/page-\d+\.jpg$/.test(clean)) return null;
  return clean.replace(/\.jpg$/, '.orig.jpg');
}

/**
 * Puts a saved copy of a page (and its `.orig` shadow, when the copy has one)
 * back over page `pageIndex` of `docId` — Undo for a retake.
 *
 * Rename-only like replacePage: the copy must exist (it lives in Caches, which
 * iOS may purge) or nothing is touched, and both files are copied out before
 * anything stored changes, so a failed copy (disk full) leaves the page as it
 * is. The shadow is staged in Caches/page-undo rather than beside the page, so
 * the startup sweep can't promote it next to the wrong page (it just deletes it). The page's current
 * shadow is removed before the page is swapped: an interruption can leave the
 * page without a shadow (harmless), never paired with another image's.
 */
export function restorePageWithShadow(srcUri: string, docId: string, pageIndex: number): string {
  const src = new File(stripQuery(srcUri));
  if (!src.exists) throw new Error('restorePageWithShadow: saved copy is gone');
  const shadowUri = shadowOf(srcUri);
  const srcOrig = shadowUri ? new File(shadowUri) : null;
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  const dest = new File(dir, `page-${pageIndex}.jpg`);
  const destOrig = new File(dir, `page-${pageIndex}.orig.jpg`);
  const pageSide = new File(dir, `page-${pageIndex}.new.jpg`);
  // Staged in Caches/page-undo, which the startup sweep clears (TEMP_DIRS), so
  // an Undo interrupted between the two steps leaves nothing behind for good.
  let origSide: File | null = null;
  if (srcOrig && srcOrig.exists) {
    const staging = new Directory(Paths.cache, 'page-undo');
    staging.create({ intermediates: true, idempotent: true });
    origSide = new File(staging, `restore-${Date.now()}.orig.jpg`);
  }

  if (origSide) stage(srcOrig!, origSide);
  try {
    stage(src, pageSide);
  } catch (err) {
    if (origSide) {
      try { origSide.delete(); } catch {}
    }
    throw err;
  }

  if (destOrig.exists) destOrig.delete();
  swapIn(pageSide, dest);
  // A rename within the app's container: needs no free space.
  if (origSide) origSide.move(destOrig);
  return dest.uri;
}

/**
 * Copies one page into `destDocId` at `destIndex`, carrying its unfiltered
 * `.orig` shadow along when the source has one.
 *
 * Every tool that copies pages between documents must go through this: the
 * startup migration treats "no .orig" as "filter never baked", so a page copied
 * without its shadow but with its filter metadata gets the filter applied a
 * second time on the next launch, and its real original is lost for good.
 *
 * A stale `.orig` already sitting at the destination index is removed when the
 * source has none — otherwise the copied page would be paired with the wrong
 * image the next time a filter is baked.
 */
export function copyPageWithShadow(srcUri: string, destDocId: string, destIndex: number): string {
  const dir = new Directory(Paths.document, 'scan-kit', destDocId);
  dir.create({ intermediates: true, idempotent: true });
  const dest = new File(dir, `page-${destIndex}.jpg`);
  const destOrig = new File(dir, `page-${destIndex}.orig.jpg`);
  const src = new File(stripQuery(srcUri));
  if (dest.exists) dest.delete();
  src.copy(dest);

  const shadowUri = shadowOf(srcUri);
  const srcOrig = shadowUri ? new File(shadowUri) : null;
  if (destOrig.exists) {
    try { destOrig.delete(); } catch {}
  }
  if (srcOrig && srcOrig.exists) srcOrig.copy(destOrig);
  return dest.uri;
}

/**
 * Copies page URIs into a doc's storage, starting at startIndex. Accepts both
 * temp files (fresh scans) and another document's stored pages (merge), whose
 * `.orig` shadows are carried across — see copyPageWithShadow.
 */
export function appendPages(
  tempUris: string[],
  docId: string,
  startIndex: number
): string[] {
  return tempUris.map((uri, i) => copyPageWithShadow(uri, docId, startIndex + i));
}

/**
 * Deletes a single page file and shifts subsequent pages down by one index.
 * After calling this, update document.pages in the caller.
 *
 * Every step is a single rename (page-(i) → page-(i-1)), so there are no temp
 * copies and an interrupted delete can never lose a page that should survive:
 * at worst one index is empty until the shift is redone.
 */
export function deleteSinglePage(
  docId: string,
  pageIndex: number,
  totalPages: number
): void {
  bumpLayout(docId);
  const dir = new Directory(Paths.document, 'scan-kit', docId);

  // Runs the shift for one file family. Called for the pages themselves and
  // again for their page-N.orig.jpg shadows, which must move in lockstep: the
  // .orig is the unfiltered source every filter bake re-derives from, so if it
  // stays behind after a delete, page N's next bake silently swaps in the image
  // that used to be at N+1.
  const shift = (suffix: string) => {
    const name = (i: number) => `page-${i}${suffix}.jpg`;
    const target = new File(dir, name(pageIndex));
    if (target.exists) target.delete();
    for (let i = pageIndex + 1; i < totalPages; i++) {
      const src = new File(dir, name(i));
      // The slot below is free (it was the target or has just been moved
      // down), unless a page had no .orig while the one below did — clear it
      // so a shadow can never end up paired with the wrong page.
      const dest = new File(dir, name(i - 1));
      if (dest.exists) dest.delete();
      if (src.exists) src.move(new File(dir, name(i - 1)));
    }
  };

  shift('');
  shift('.orig');
  // The deleted page's recognised text must not stay behind in the folder.
  pruneDocumentOcr(docId);
}

/** Present in a doc folder while a reorder is promoting its temp copies. */
export const REORDER_COMMIT_MARKER = 'reorder.commit';

/**
 * Reorders page files according to newOrderIndices.
 * newOrderIndices[i] = old index that should become new index i.
 * Returns the new URIs in new order.
 *
 * Two-phase, so an interruption is always recoverable:
 *  1. copy every page to `page-tmp-<newIndex>.jpg` — the originals are untouched,
 *     so a crash here is undone by deleting the temps;
 *  2. write the `reorder.commit` marker, then rename each temp over its final
 *     name — a crash here is finished by promoting the remaining temps (every
 *     old page's bytes live on in a temp or in its new slot).
 * The startup sweep tells the two apart by the marker (see recoverInterrupted).
 */
export function reorderPages(docId: string, newOrderIndices: number[]): string[] {
  if (newOrderIndices.some((from, to) => from !== to)) bumpLayout(docId);
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  const n = newOrderIndices.length;
  // `required` is false for .orig: a page that has never been filtered has none.
  const families: { suffix: string; required: boolean }[] = [
    { suffix: '', required: true },
    { suffix: '.orig', required: false },
  ];
  const name = (suffix: string, i: number) => `page-${i}${suffix}.jpg`;
  const tmpName = (suffix: string, i: number) => `page-tmp-${i}${suffix}.jpg`;
  const removeTemps = () => {
    for (const { suffix } of families) {
      for (let i = 0; i < n; i++) {
        const tmp = new File(dir, tmpName(suffix, i));
        if (tmp.exists) {
          try { tmp.delete(); } catch {}
        }
      }
    }
  };

  // Phase 1: copies only.
  try {
    for (const { suffix, required } of families) {
      for (let i = 0; i < n; i++) {
        const src = new File(dir, name(suffix, newOrderIndices[i]));
        if (!src.exists) {
          if (!required) continue;
          throw new Error(`reorderPages: source ${name(suffix, newOrderIndices[i])} missing`);
        }
        stage(src, new File(dir, tmpName(suffix, i)));
      }
    }
  } catch (err) {
    removeTemps();
    throw err;
  }

  // Phase 2: commit. From here on the temps ARE the pages.
  const marker = new File(dir, REORDER_COMMIT_MARKER);
  if (!marker.exists) marker.create();
  for (const { suffix } of families) {
    for (let i = 0; i < n; i++) {
      const tmp = new File(dir, tmpName(suffix, i));
      const dest = new File(dir, name(suffix, i));
      if (tmp.exists) swapIn(tmp, dest);
      else if (dest.exists && suffix) dest.delete(); // its page has no shadow now
    }
  }
  marker.delete();

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
  const srcDir = new Directory(Paths.document, 'scan-kit', sourceId);
  return pages.map((_, i) => {
    const src = new File(srcDir, `page-${i}.jpg`);
    const dest = new File(destDir, `page-${i}.jpg`);
    src.copy(dest);
    // Carry the .orig shadow across too. Without it the duplicate has no
    // pristine source, so its first filter change would bake on top of pixels
    // that already have a filter in them.
    const srcOrig = new File(srcDir, `page-${i}.orig.jpg`);
    if (srcOrig.exists) srcOrig.copy(new File(destDir, `page-${i}.orig.jpg`));
    return dest.uri;
  });
}

/**
 * Copies a temp page URI to storage as `page-<pageIndex>.jpg`, recompressing to
 * `quality` (0–1) and shrinking anything larger than MAX_PAGE_EDGE on its long
 * edge (a 24 MP photo is 5712 px wide; the filter bake's WebKit canvas can't
 * hold it — see lib/bake-html.ts). quality === 1 with a small enough image is a
 * plain copy. A file already sitting at the destination (left by an earlier
 * failed attempt) is replaced. The source file is left in place.
 */
export async function copyPageWithQuality(
  tempUri: string,
  docId: string,
  pageIndex: number,
  quality: number
): Promise<string> {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  dir.create({ intermediates: true, idempotent: true });
  const dest = new File(dir, `page-${pageIndex}.jpg`);
  const srcUri = stripQuery(tempUri);
  const size = await getImageSize(srcUri);
  const capped = size ? cappedSize(size.width, size.height) : null;
  // Constrain only the long edge: the manipulator keeps the aspect ratio, so
  // the page can't be distorted even if the reported size ignored EXIF rotation.
  const resize = capped && size
    ? (size.width >= size.height ? { width: capped.width } : { height: capped.height })
    : null;
  if (dest.exists) dest.delete();
  if (quality === 1 && !resize) {
    new File(srcUri).copy(dest);
  } else {
    const result = await manipulateAsync(srcUri, resize ? [{ resize }] : [], { compress: quality, format: SaveFormat.JPEG });
    new File(stripQuery(result.uri)).move(dest);
  }
  return new File(dir, `page-${pageIndex}.jpg`).uri;
}

/** Returns the file:// URI of a page's pristine, pre-filter source copy. */
export function originalUri(docId: string, pageIndex: number): string {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  return new File(dir, `page-${pageIndex}.orig.jpg`).uri;
}

/**
 * Ensures a pristine `.orig.jpg` copy of a page exists, copying it from the
 * current `page-N.jpg` only if the `.orig` doesn't already exist. Idempotent
 * by design: every filter change re-derives from this same pristine source,
 * so re-baking a filter never compounds JPEG generation loss, and reverting
 * to Original is always possible. Returns the `.orig` URI either way.
 */
export function ensureOriginal(docId: string, pageIndex: number): string {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  const orig = new File(dir, `page-${pageIndex}.orig.jpg`);
  if (!orig.exists) {
    // Copied under a `.part` name and renamed into place, so a crash mid-copy
    // can't leave a truncated shadow for every later bake to start from.
    const part = new File(dir, `page-${pageIndex}.orig.part.jpg`);
    stage(new File(dir, `page-${pageIndex}.jpg`), part);
    part.move(new File(dir, `page-${pageIndex}.orig.jpg`));
  }
  return new File(dir, `page-${pageIndex}.orig.jpg`).uri;
}

/**
 * Where a filter bake writes its output before it replaces the page (see
 * promotePageSide). Writing straight over the page would leave a truncated
 * JPEG if the app died mid-write.
 */
export function pageSideUri(docId: string, pageIndex: number): string {
  return new File(new Directory(Paths.document, 'scan-kit', docId), `page-${pageIndex}.new.jpg`).uri;
}

/** Renames the fully written side file (pageSideUri) over the page. */
export function promotePageSide(docId: string, pageIndex: number): void {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  swapIn(new File(dir, `page-${pageIndex}.new.jpg`), new File(dir, `page-${pageIndex}.jpg`));
}

/** Where a direct write of a page's `.orig` shadow goes first (see promoteOriginalSide). */
export function originalSideUri(docId: string, pageIndex: number): string {
  return new File(new Directory(Paths.document, 'scan-kit', docId), `page-${pageIndex}.orig.new.jpg`).uri;
}

/** Renames the fully written shadow side file (originalSideUri) over the page's `.orig`. */
export function promoteOriginalSide(docId: string, pageIndex: number): void {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  swapIn(new File(dir, `page-${pageIndex}.orig.new.jpg`), new File(dir, `page-${pageIndex}.orig.jpg`));
}

/** Returns the last path segment of a file:// uri (the basename), or ''. */
function baseName(uri: string): string {
  const trimmed = uri.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * Anything touched this recently may belong to an operation still running (a
 * save that has created its folder but not yet its record, a reorder midway):
 * the startup sweep leaves it alone.
 */
export const SWEEP_GRACE_MS = 10 * 60 * 1000;

/** Milliseconds since `item` was last modified, or null when that can't be read. */
function ageOf(item: File | Directory, now: number): number | null {
  try {
    const t = item.info().modificationTime;
    return typeof t === 'number' && t > 0 ? now - t : null;
  } catch {
    return null;
  }
}

/** True only when `item` is known to be older than the grace period. */
function isSettled(item: File | Directory, now: number): boolean {
  const age = ageOf(item, now);
  return age !== null && age >= SWEEP_GRACE_MS;
}

// Side files an interrupted operation can leave in a doc folder, and the page
// file each one stands in for.
const SIDE_FILES: { re: RegExp; target: (m: RegExpMatchArray) => string }[] = [
  // replacePage / replaceOriginal: page-3.new.jpg → page-3.jpg, page-3.orig.new.jpg → page-3.orig.jpg
  { re: /^page-(\d+)((?:\.orig)?)\.new\.jpg$/, target: m => `page-${m[1]}${m[2]}.jpg` },
  // older builds' deleteSinglePage: page-4.shifting.jpg was headed for page-3.jpg
  { re: /^page-(\d+)((?:\.orig)?)\.shifting\.jpg$/, target: m => `page-${Number(m[1]) - 1}${m[2]}.jpg` },
  // older builds' generic temp: page-3.tmp.jpg → page-3.jpg
  { re: /^page-(\d+)((?:\.orig)?)\.tmp\.jpg$/, target: m => `page-${m[1]}${m[2]}.jpg` },
];
const REORDER_TEMP = /^page-tmp-(\d+)((?:\.orig)?)\.jpg$/;
// A copy that is renamed into place only once complete (ensureOriginal).
const PARTIAL = /\.part\.jpg$/;

/**
 * Finishes or undoes operations that were interrupted in a document folder.
 * A side file whose page is missing IS the page now (the app died between
 * deleting the old page and renaming the new one in), so it is promoted; one
 * whose page exists is a leftover duplicate and is deleted. Reorder temps are
 * promoted when the commit marker says phase 2 had started, otherwise deleted
 * (the originals were never touched). Returns how many files were handled.
 */
function recoverInterrupted(dir: Directory, now: number): number {
  let handled = 0;
  let items: (Directory | File)[];
  try {
    items = dir.list();
  } catch {
    return 0;
  }
  const files = items.filter((i): i is File => i instanceof File);
  const names = new Set(files.map(f => baseName(f.uri)));
  const marker = files.find(f => baseName(f.uri) === REORDER_COMMIT_MARKER);
  const committed = !!marker;

  for (const file of files) {
    const fileName = baseName(file.uri);
    try {
      const reorder = fileName.match(REORDER_TEMP);
      const side = reorder ? null : SIDE_FILES.map(s => ({ s, m: fileName.match(s.re) })).find(x => x.m);
      const partial = PARTIAL.test(fileName);
      if (!reorder && !side && !partial) continue;
      if (!isSettled(file, now)) continue; // may belong to an edit in progress
      if (partial) {
        file.delete(); // an interrupted copy; the source it came from is intact
      } else if (reorder) {
        const dest = new File(dir, `page-${reorder[1]}${reorder[2]}.jpg`);
        if (committed) swapIn(file, dest);
        else file.delete();
      } else if (side) {
        const targetName = side.s.target(side.m!);
        if (names.has(targetName)) {
          file.delete();
        } else {
          file.move(new File(dir, targetName));
          names.add(targetName);
        }
      }
      handled++;
    } catch {}
  }
  if (marker && isSettled(marker, now)) {
    try { marker.delete(); } catch {}
  }
  return handled;
}

/**
 * Startup sweep. In this order:
 *  - finishes or undoes interrupted operations inside each listed doc folder
 *    (recoverInterrupted) — never deleting a file that is the only copy;
 *  - deletes every folder under scan-kit/ whose id is NOT in validDocIds
 *    (its record is gone) and that hasn't been touched for SWEEP_GRACE_MS, so
 *    a document being saved right now (folder made, record not yet written)
 *    survives;
 *  - removes stale temp files the app's pickers, scanner and exports leave
 *    behind (sweepTempLeftovers).
 *
 * Extremely defensive: every item is wrapped in its own try/catch so a single
 * failure never aborts the sweep, and if listing fails entirely it returns 0.
 * NEVER deletes a directory whose id IS in validDocIds.
 */
export async function garbageCollectOrphans(validDocIds: string[], now: number = Date.now()): Promise<number> {
  let handled = sweepTempLeftovers(now);
  const valid = new Set(validDocIds);
  // An empty list almost always means the document index could not be read,
  // not that the user has no documents (deleting a document already removes
  // its folder). Sweeping against it would delete the whole library.
  if (valid.size === 0) return handled;
  let children: (Directory | File)[];
  try {
    const root = new Directory(Paths.document, 'scan-kit');
    if (!root.exists) return handled;
    children = root.list();
  } catch {
    return handled;
  }

  for (const child of children) {
    try {
      if (!(child instanceof Directory)) continue;
      if (valid.has(baseName(child.uri))) {
        handled += recoverInterrupted(child, now);
      } else if (isSettled(child, now)) {
        // Orphan directory: its doc record is gone. Remove it entirely.
        child.delete();
        forgetDocumentOcr(baseName(child.uri));
        handled++;
      }
    } catch {}
  }

  return handled;
}

// ── Temp files ───────────────────────────────────────────────────────────────

function containerRoot(): string {
  const docs = Paths.document.uri.replace(/\/+$/, '');
  return docs.slice(0, docs.lastIndexOf('/') + 1);
}

/** The document scanner writes its pages straight into Documents/. */
const SCANNER_OUTPUT = /^DOCUMENT_SCAN_\d+_[^/]*\.jpe?g$/i;

/**
 * True for files the app created only as a stepping stone and may delete once
 * their content is stored: anything in Caches/ or tmp/ (pickers, the image
 * manipulator, auto-crop output), and the document scanner's output in the
 * Documents root. Never a stored page (Documents/scan-kit/…).
 */
export function isDisposableTemp(uri: string | null | undefined): boolean {
  if (!uri) return false;
  const clean = stripQuery(uri);
  if (!clean.startsWith('file://')) return false;
  if (clean.includes('/scan-kit/')) return false;
  try {
    const cache = Paths.cache.uri.replace(/\/*$/, '/');
    if (clean.startsWith(cache)) return true;
    const root = containerRoot();
    if (root && clean.startsWith(`${root}tmp/`)) return true;
    const docs = Paths.document.uri.replace(/\/*$/, '/');
    return clean.startsWith(docs) && SCANNER_OUTPUT.test(clean.slice(docs.length));
  } catch {
    return false; // can't tell where it lives — keep it
  }
}

/** True for a page the document scanner wrote (it is already cropped and straightened). */
export function isScannerOutput(uri: string): boolean {
  const clean = stripQuery(uri);
  return SCANNER_OUTPUT.test(clean.slice(clean.lastIndexOf('/') + 1));
}

/** Deletes the disposable temps among `uris` (see isDisposableTemp); ignores the rest. */
export function deleteDisposableTemps(uris: (string | null | undefined)[]): void {
  for (const uri of uris) {
    if (!isDisposableTemp(uri)) continue;
    try {
      const f = new File(stripQuery(uri!));
      if (f.exists) f.delete();
    } catch {}
  }
}

// Folders whose contents are only ever stepping stones for this app.
// page-undo holds the copy of a deleted page that the viewer's Undo restores
// (lib/page-undo.ts); one older than the grace period can no longer be used.
const TEMP_DIRS = ['ImagePicker', 'ImageManipulator', 'DocumentPicker', 'exports', 'Print', 'page-undo'];

/**
 * Removes temp files older than SWEEP_GRACE_MS that earlier sessions left
 * behind: scanner output in Documents/, auto-crop output in tmp/, and picker,
 * manipulator and export leftovers in Caches/. Returns how many were removed.
 */
export function sweepTempLeftovers(now: number = Date.now()): number {
  let removed = 0;
  const sweep = (dir: Directory, match: (name: string) => boolean) => {
    let items: (Directory | File)[];
    try {
      if (!dir.exists) return;
      items = dir.list();
    } catch {
      return;
    }
    for (const item of items) {
      try {
        if (!match(baseName(item.uri)) || !isSettled(item, now)) continue;
        item.delete();
        removed++;
      } catch {}
    }
  };
  sweep(new Directory(Paths.document), name => SCANNER_OUTPUT.test(name));
  for (const name of TEMP_DIRS) sweep(new Directory(Paths.cache, name), () => true);
  const root = containerRoot();
  if (root) sweep(new Directory(`${root}tmp`), name => /^doc-[0-9A-F-]+\.jpg$/i.test(name));
  return removed;
}

/**
 * Copies an imported PDF from a temp URI to permanent storage.
 * Returns the stored file:// URI.
 */
export function copyPdfToStorage(tempUri: string, docId: string): string {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  dir.create({ intermediates: true, idempotent: true });
  const dest = new File(dir, 'document.pdf');
  const src = new File(tempUri);
  src.copy(dest);
  return dest.uri;
}
