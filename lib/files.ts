// lib/files.ts
//
// CRASH SAFETY. Page files are only ever replaced by a rename (File.move), never
// by delete-then-copy, so an app kill can't leave a page with no copy at all.
// The few multi-step operations (replace, reorder) leave recognisable side files
// while they run; the startup sweep (garbageCollectOrphans) finishes or undoes
// an interrupted one from those files instead of deleting them.
import { Directory, File, Paths } from 'expo-file-system';
import {
  docDir,
  docDirs,
  isAppDataUri,
  isUserVisibleUri,
  looksLikeDocFolder,
  removeAppFiles,
  resolveDocDir,
  sameFileKey,
  scanRoots,
  storageLayout,
  SCAN_DIR_NAME,
  SIGNATURES_DIR_NAME,
} from './storage-layout';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { cappedSize, getImageSize } from './image-size';
import { forgetDocumentOcr, pruneDocumentOcr } from './ocr-cache';
import { PAGE_FAMILY_SUFFIXES, PAGE_SHADOW_SUFFIXES } from './page-family';

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
 * text's in-memory copy. In every root the document has a folder in (two
 * while the move out of Documents is part done). A folder still in the
 * Documents folder Files shows loses only the app's own files: anything else
 * in it is the user's, and it stays with its folder (r11 #6).
 */
export function deleteDocumentFiles(docId: string): void {
  forgetDocumentOcr(docId);
  for (const dir of docDirs(docId)) {
    if (isUserVisibleUri(dir.uri)) removeAppFiles(dir);
    else dir.delete();
  }
}

/**
 * Overwrites a stored page with a new file (e.g. after rotation).
 * The new bytes are copied to `page-N.new.jpg` first (a failed copy leaves the
 * page untouched), then renamed over the page. `newUri` is left in place.
 */
export function replacePage(newUri: string, docId: string, pageIndex: number): string {
  const dir = resolveDocDir(docId);
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
  const dir = resolveDocDir(docId);
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

// Page file families (page, .orig, source photo, geometry): lib/page-family.ts.
export { PAGE_FAMILY_SUFFIXES, PAGE_SHADOW_SUFFIXES } from './page-family';

/**
 * The `suffix` sibling of a stored page URI (`…/page-3.jpg` → `…/page-3.src.jpg`),
 * or null when the URI is not a stored page (a scanner or picker temp file).
 */
export function siblingOf(pageUri: string, suffix: string): string | null {
  const clean = stripQuery(pageUri);
  if (!/\/page-\d+\.jpg$/.test(clean)) return null;
  return clean.replace(/\.jpg$/, suffix);
}

/**
 * The `.orig` shadow that belongs to a stored page URI, or null when the URI
 * is not a stored page (e.g. a scanner or picker temp file).
 */
export function shadowOf(pageUri: string): string | null {
  return siblingOf(pageUri, '.orig.jpg');
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
  const dir = resolveDocDir(docId);
  const dest = new File(dir, `page-${pageIndex}.jpg`);
  const destOrig = new File(dir, `page-${pageIndex}.orig.jpg`);
  const pageSide = new File(dir, `page-${pageIndex}.new.jpg`);
  // Staged in Caches/page-undo, which the startup sweep clears (TEMP_DIRS), so
  // an Undo interrupted between the two steps leaves nothing behind for good.
  const staging = new Directory(Paths.cache, 'page-undo');
  const stamp = `${Date.now()}-${++restoreSeq}`;
  let origSide: File | null = null;
  if (srcOrig && srcOrig.exists) {
    staging.create({ intermediates: true, idempotent: true });
    origSide = new File(staging, `restore-${stamp}.orig.jpg`);
  }
  // The copy's source photo and geometry (lib/page-source.ts), when it has
  // them. A copy without them (an older stash, Sign's) leaves the page's own
  // alone: their stamp decides whether they still describe the page.
  const sources: { from: File; side: File; suffix: string }[] = [];
  for (const suffix of ['.src.jpg', '.src.json']) {
    const u = siblingOf(srcUri, suffix);
    const f = u ? new File(u) : null;
    if (f && f.exists) {
      staging.create({ intermediates: true, idempotent: true });
      sources.push({ from: f, side: new File(staging, `restore-${stamp}${suffix}`), suffix });
    }
  }

  const staged: File[] = [];
  try {
    if (origSide) {
      stage(srcOrig!, origSide);
      staged.push(origSide);
    }
    for (const s of sources) {
      stage(s.from, s.side);
      staged.push(s.side);
    }
    stage(src, pageSide);
  } catch (err) {
    for (const f of staged) {
      try { f.delete(); } catch {}
    }
    throw err;
  }

  if (destOrig.exists) destOrig.delete();
  if (sources.length) {
    // Geometry first: never a new photo paired with the old geometry.
    for (const suffix of ['.src.json', '.src.jpg']) {
      const f = new File(dir, `page-${pageIndex}${suffix}`);
      if (f.exists) f.delete();
    }
  }
  swapIn(pageSide, dest);
  // A rename within the app's container: needs no free space.
  if (origSide) origSide.move(destOrig);
  // Photo before geometry (pushed in that order above).
  for (const s of sources) s.side.move(new File(dir, `page-${pageIndex}${s.suffix}`));
  return dest.uri;
}

let restoreSeq = 0;

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
  const dir = resolveDocDir(destDocId);
  dir.create({ intermediates: true, idempotent: true });
  const dest = new File(dir, `page-${destIndex}.jpg`);
  const src = new File(stripQuery(srcUri));
  if (dest.exists) dest.delete();
  src.copy(dest);
  copyShadows(srcUri, dir, destIndex);
  return dest.uri;
}

/**
 * Gives page `destIndex` in `destDir` exactly the shadows the stored page at
 * `srcUri` has (PAGE_SHADOW_SUFFIXES): each one it has is copied, each one it
 * lacks is removed at the destination.
 */
function copyShadows(srcUri: string, destDir: Directory, destIndex: number): void {
  for (const suffix of PAGE_SHADOW_SUFFIXES) {
    const destShadow = new File(destDir, `page-${destIndex}${suffix}`);
    if (destShadow.exists) {
      try { destShadow.delete(); } catch {}
    }
    const u = siblingOf(srcUri, suffix);
    const from = u ? new File(u) : null;
    if (from && from.exists) from.copy(destShadow);
  }
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
  const dir = resolveDocDir(docId); // throws (and nothing moves) if it can't be made one folder
  bumpLayout(docId);

  // Runs the shift for one file family. Called for the pages themselves and
  // again for their page-N.orig.jpg shadows, which must move in lockstep: the
  // .orig is the unfiltered source every filter bake re-derives from, so if it
  // stays behind after a delete, page N's next bake silently swaps in the image
  // that used to be at N+1.
  const shift = (suffix: string) => {
    const name = (i: number) => `page-${i}${suffix}`;
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

  // Every family moves: the page, its .orig, its source photo and geometry.
  for (const suffix of PAGE_FAMILY_SUFFIXES) shift(suffix);
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
  const dir = resolveDocDir(docId);
  const n = newOrderIndices.length;
  // Only the page itself is required: shadows are optional (a page that has
  // never been filtered has no .orig; most pages have no source photo).
  const families: { suffix: string; required: boolean }[] = PAGE_FAMILY_SUFFIXES.map(suffix => ({
    suffix,
    required: suffix === '.jpg',
  }));
  const name = (suffix: string, i: number) => `page-${i}${suffix}`;
  const tmpName = (suffix: string, i: number) => `page-tmp-${i}${suffix}`;
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
      else if (dest.exists && suffix !== '.jpg') dest.delete(); // its page has no such shadow now
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
  const destDir = resolveDocDir(destId);
  destDir.create({ intermediates: true, idempotent: true });
  const srcDir = resolveDocDir(sourceId);
  return pages.map((_, i) => {
    const src = new File(srcDir, `page-${i}.jpg`);
    const dest = new File(destDir, `page-${i}.jpg`);
    src.copy(dest);
    // Carry the shadows across too. Without the .orig the duplicate has no
    // pristine source, so its first filter change would bake on top of pixels
    // that already have a filter in them; without the source photo the copy
    // couldn't be re-cropped wider.
    for (const suffix of PAGE_SHADOW_SUFFIXES) {
      const shadow = new File(srcDir, `page-${i}${suffix}`);
      if (shadow.exists) shadow.copy(new File(destDir, `page-${i}${suffix}`));
    }
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
  const dir = resolveDocDir(docId);
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
  const dir = docDir(docId);
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
  const dir = resolveDocDir(docId);
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
  return new File(resolveDocDir(docId), `page-${pageIndex}.new.jpg`).uri;
}

/** Renames the fully written side file (pageSideUri) over the page. */
export function promotePageSide(docId: string, pageIndex: number): void {
  const dir = resolveDocDir(docId);
  swapIn(new File(dir, `page-${pageIndex}.new.jpg`), new File(dir, `page-${pageIndex}.jpg`));
}

/** Where a direct write of a page's `.orig` shadow goes first (see promoteOriginalSide). */
export function originalSideUri(docId: string, pageIndex: number): string {
  return new File(resolveDocDir(docId), `page-${pageIndex}.orig.new.jpg`).uri;
}

/** Renames the fully written shadow side file (originalSideUri) over the page's `.orig`. */
export function promoteOriginalSide(docId: string, pageIndex: number): void {
  const dir = resolveDocDir(docId);
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
  // (and the same for a source photo, page-3.src.new.jpg → page-3.src.jpg)
  { re: /^page-(\d+)((?:\.orig|\.src)?)\.new\.jpg$/, target: m => `page-${m[1]}${m[2]}.jpg` },
  // older builds' deleteSinglePage: page-4.shifting.jpg was headed for page-3.jpg
  { re: /^page-(\d+)((?:\.orig)?)\.shifting\.jpg$/, target: m => `page-${Number(m[1]) - 1}${m[2]}.jpg` },
  // older builds' generic temp: page-3.tmp.jpg → page-3.jpg
  { re: /^page-(\d+)((?:\.orig)?)\.tmp\.jpg$/, target: m => `page-${m[1]}${m[2]}.jpg` },
];
const REORDER_TEMP = /^page-tmp-(\d+)((?:\.orig|\.src)?\.jpg|\.src\.json)$/;
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
        const dest = new File(dir, `page-${reorder[1]}${reorder[2]}`);
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
 *    (its record is gone), that hasn't been touched for SWEEP_GRACE_MS (so a
 *    document being saved right now — folder made, record not yet written —
 *    survives) and that holds only what the app writes into a document's
 *    folder (lib/storage-layout looksLikeDocFolder);
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
  // While the move out of Documents is only part done (lib/storage-layout.ts
  // 'split'), a document can have files in both roots: interrupted operations
  // are finished in each, but nothing is deleted as an orphan until the move
  // has completed and there is one root again.
  const layout = storageLayout();
  const mayDelete = layout.state !== 'split';
  for (const root of scanRoots()) {
    let children: (Directory | File)[];
    try {
      if (!root.exists) continue;
      children = root.list();
    } catch {
      continue;
    }
    for (const child of children) {
      try {
        if (!(child instanceof Directory)) continue;
        const name = baseName(child.uri);
        if (valid.has(name)) {
          handled += recoverInterrupted(child, now);
        } else if (mayDelete && !PROTECTED_DIR_NAMES.has(name) && isSettled(child, now)) {
          // Orphan directory: its doc record is gone. Removed only when it
          // holds nothing but what the app puts in a document's folder: a
          // folder with anything else in it is never the app's to delete (a
          // move keeps old mtimes, so age alone proves nothing). In the
          // Documents folder Files shows (a move that failed outright), only
          // a document-id folder holding a page or PDF counts, and only the
          // app's own files are removed from it (r11 #6).
          if (isUserVisibleUri(child.uri)) {
            if (!looksLikeDocFolder(child, true, true)) continue;
            removeAppFiles(child);
          } else {
            if (!looksLikeDocFolder(child, false, false)) continue;
            child.delete();
          }
          forgetDocumentOcr(name);
          handled++;
        }
      } catch {}
    }
  }

  return handled;
}

/**
 * Never orphans, whatever is in the record list: a root folder that a faulty
 * move nested inside another root would otherwise look like one document.
 */
const PROTECTED_DIR_NAMES = new Set([SCAN_DIR_NAME, SIGNATURES_DIR_NAME]);

// ── Files a record no longer references ─────────────────────────────────────

/** What a document's record points at (lib/storage.ts documentFileRefsForCleanup). */
export type DocFileRefs = { id: string; pages: string[]; pdfUri?: string; updatedAt: number };

const PAGE_FILE = /^page-\d+(?:(?:\.orig|\.src)?\.jpg|\.src\.json)$/;

/**
 * Reads document `id`'s current record and runs `act` on it INSIDE the docs
 * lock (lib/storage.ts withDocumentFileRefs), so no record write can land
 * between the read and what `act` does. `act` must be synchronous. Null when
 * the record is gone or doesn't parse.
 */
export type WithFreshFileRefs = <T>(id: string, act: (fresh: DocFileRefs | null) => T) => Promise<T>;

/** True when `rec` hasn't changed for SWEEP_GRACE_MS (no edit can be in flight). */
function recordSettled(rec: DocFileRefs, now: number): boolean {
  return !!rec.updatedAt && now - rec.updatedAt >= SWEEP_GRACE_MS;
}

/** One document's stray Convert-to-pages files (see sweepConvertLeftovers). Synchronous. */
function removeConvertLeftovers(rec: DocFileRefs, now: number): number {
  if (!recordSettled(rec, now)) return 0;
  const dir = docDir(rec.id);
  if (!dir.exists) return 0;
  const referenced = new Set(
    [...rec.pages, rec.pdfUri].filter((u): u is string => !!u).map(u => baseName(stripQuery(u))),
  );
  const isPdfDoc = !!rec.pdfUri && rec.pages.length === 0;
  let removed = 0;
  let pagesRemoved = false;
  for (const item of dir.list()) {
    try {
      if (!(item instanceof File)) continue;
      const name = baseName(item.uri);
      if (referenced.has(name)) continue;
      const strayPdf = name === 'document.pdf' && !rec.pdfUri;
      const strayPage = isPdfDoc && PAGE_FILE.test(name);
      if (!strayPdf && !strayPage) continue;
      if (!isSettled(item, now)) continue;
      item.delete();
      removed++;
      if (strayPage) pagesRemoved = true;
    } catch {}
  }
  if (pagesRemoved) pruneDocumentOcr(rec.id);
  return removed;
}

/**
 * Startup sweep for what an interrupted "Convert to pages" (lib/convert-pdf.ts)
 * or its Undo can leave in a document folder:
 *  - `document.pdf` in a document that is no longer a PDF (killed between the
 *    record switch and moving the PDF to the Undo stash, or during an Undo
 *    before its record switch);
 *  - page files in a document that is still a PDF (killed while the pages were
 *    being written, before the record switch).
 * Deliberately narrow and conservative: only those two patterns; never a file
 * the record references (by name); never a file modified within
 * SWEEP_GRACE_MS; never anything in a document whose record changed within
 * SWEEP_GRACE_MS (an edit may be in flight).
 *
 * `records` is only a snapshot used to pick candidates. Each candidate's record
 * is read again under the docs lock (`withFresh`) and its files are judged
 * against THAT, inside the lock: a conversion or Undo that switched the record
 * after the snapshot (and bumped updatedAt) is seen, so e.g. the document.pdf
 * an Undo just copied back — with the stash's old mtime — is never deleted
 * (r8 code review #5). Returns how many files were removed.
 */
export async function sweepConvertLeftovers(
  records: DocFileRefs[],
  withFresh: WithFreshFileRefs,
  now: number = Date.now(),
): Promise<number> {
  let removed = 0;
  for (const snapshot of records) {
    if (!recordSettled(snapshot, now)) continue; // changed recently in the snapshot already
    try {
      removed += await withFresh(snapshot.id, fresh => {
        if (!fresh) return 0;
        try {
          return removeConvertLeftovers(fresh, now);
        } catch {
          return 0;
        }
      });
    } catch {}
  }
  return removed;
}

// ── Temp files ───────────────────────────────────────────────────────────────

export function containerRoot(): string {
  const docs = Paths.document.uri.replace(/\/+$/, '');
  return docs.slice(0, docs.lastIndexOf('/') + 1);
}

/** A "Keep a copy in Files" PDF an older build was writing in Documents (now made in Caches/files-copy). */
const FILES_COPY_TEMP = /^\.[0-9a-z]+-copy\.pdf$/;

/** The document scanner writes its pages straight into Documents/. */
const SCANNER_OUTPUT = /^DOCUMENT_SCAN_\p{Nd}+_[^/]*\.jpe?g$/iu;
/**
 * Exactly the name the scanner gives a page in the Documents root
 * (react-native-document-scanner-plugin FileUtil: DOCUMENT_SCAN_<n>_<yyyyMMdd_HHmmss>.jpg).
 * Documents is the user's folder, so only this is ever moved or deleted there.
 * The date comes from a DateFormatter in the device's locale, so its digits
 * are the locale's (Arabic-Indic ٢٠٢٦…, Persian ۲۰۲۶…), and a right-to-left
 * locale may add direction marks: any decimal digit is accepted (r11 #2).
 */
const SCANNER_OUTPUT_IN_DOCUMENTS = /^DOCUMENT_SCAN_\p{Nd}+_[\u061C\u200E\u200F]*(?:\p{Nd}[\u061C\u200E\u200F]*){8}_[\u061C\u200E\u200F]*(?:\p{Nd}[\u061C\u200E\u200F]*){6}\.jpg$/u;

/** A file name as written: URIs carry it percent-escaped (non-ASCII digits always are). */
function decodedName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** True for exactly the scanner's own output name (see SCANNER_OUTPUT_IN_DOCUMENTS), escaped or not. */
export function isScannerOutputName(name: string): boolean {
  return SCANNER_OUTPUT_IN_DOCUMENTS.test(decodedName(name));
}
/** Caches/scanner: where the scanner's pages are moved the moment it returns them. */
const SCANNER_DIR = 'scanner';

/**
 * Moves the document scanner's output out of Documents — which the Files app
 * shows — into Caches/scanner, the moment the scanner returns it. Every call
 * site of DocumentScanner.scanDocument passes its result through this (and
 * the library entry points that take scanner pages do it again: a no-op for
 * pages already moved). The name is kept, so isScannerOutput still knows the
 * page is already cropped. A page that can't be moved is returned as it was
 * (and swept later). Never touches anything but scanner output.
 */
export function moveScannerOutputToCaches(uris: string[]): string[] {
  return uris.map(uri => {
    try {
      const clean = stripQuery(uri);
      // Compared in one spelling (/private/var or /var, escaped or not).
      const key = sameFileKey(clean);
      const docs = sameFileKey(Paths.document.uri.replace(/\/*$/, '/'));
      if (!key.startsWith(docs)) return uri;
      const name = key.slice(docs.length);
      if (!isScannerOutputName(name)) return uri;
      // Made from the decoded name, so it is found however the URI was spelled.
      const src = new File(Paths.document, name);
      if (!src.exists) return uri;
      const dir = new Directory(Paths.cache, SCANNER_DIR);
      dir.create({ intermediates: true, idempotent: true });
      // Same-second captures of an earlier session could share a name.
      let dest = new File(dir, name);
      for (let n = 2; dest.exists && n < 100; n++) dest = new File(dir, name.replace(/\.jpg$/, `-${n}.jpg`));
      src.move(dest);
      return dest.uri;
    } catch (err) {
      console.warn('moveScannerOutputToCaches', err);
      return uri;
    }
  });
}

/**
 * True for files the app created only as a stepping stone and may delete once
 * their content is stored: anything in Caches/ or tmp/ (pickers, the image
 * manipulator, auto-crop output), and the document scanner's output in the
 * Documents root. Never a stored page or anything else in the app's storage (lib/storage-layout.ts).
 */
export function isDisposableTemp(uri: string | null | undefined): boolean {
  if (!uri) return false;
  const clean = stripQuery(uri);
  if (!clean.startsWith('file://')) return false;
  try {
    // Never a stored page or anything else in the app's own storage.
    if (isAppDataUri(clean)) return false;
    const cache = Paths.cache.uri.replace(/\/*$/, '/');
    if (clean.startsWith(cache)) return true;
    const root = containerRoot();
    if (root && clean.startsWith(`${root}tmp/`)) return true;
    const key = sameFileKey(clean);
    const docs = sameFileKey(Paths.document.uri.replace(/\/*$/, '/'));
    return key.startsWith(docs) && isScannerOutputName(key.slice(docs.length));
  } catch {
    return false; // can't tell where it lives — keep it
  }
}

/** True for a page the document scanner wrote (it is already cropped and straightened). */
export function isScannerOutput(uri: string): boolean {
  const clean = stripQuery(uri);
  return SCANNER_OUTPUT.test(decodedName(clean.slice(clean.lastIndexOf('/') + 1)));
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
// pdf-convert: PDF page renders and the PDF an Undo of "Convert to pages" puts back (lib/convert-pdf.ts).
// incoming: "Open in Scan Kit" staging copies (app/import.tsx).
const TEMP_DIRS = [
  'ImagePicker',
  'ImageManipulator',
  'DocumentPicker',
  'exports',
  'Print',
  'page-undo',
  'pdf-convert',
  'incoming',
  // Sign / Watermark / Timestamp Undo copies of older builds (lib/page-stamp.ts
  // now keeps them in private storage with a crash journal).
  'stamp-undo',
  // The document scanner's pages, moved out of Documents (moveScannerOutputToCaches).
  SCANNER_DIR,
  // "Keep a copy in Files" PDFs being made (lib/files-copy.ts).
  'files-copy',
  // HTML pages the off-screen WebViews load (components/local-webview.tsx).
  'webview',
  // Photos being normalised and pages being rendered from them (lib/page-source.ts).
  'page-source',
  // Scan Kit camera photos and their review previews (app/camera.tsx,
  // lib/capture-session.ts): a session that never finished leaves them here.
  'scanner-src',
];
/** Open-in staging files older builds wrote straight into the Caches root. */
const LEGACY_STAGED = /^(?:incoming|attempt)-\d+-/;

/**
 * When app/import.tsx staged a file, from the Date.now() stamp at the start of
 * its own name ("incoming-1763459000000-Lease.pdf", "attempt-…-incoming-…"),
 * or null for a name without one.
 *
 * Staged files are aged by this, NOT by their modification time: File.copy
 * (FileManager.copyItem) keeps the source's mtime, so a fresh copy of an old
 * photo or PDF looks hours old and the startup sweep would delete it while the
 * import that made it is still running (r8 code review #2).
 */
export function stagedAt(name: string): number | null {
  const m = /^(?:incoming|attempt)-(\d{1,15})-/.exec(name);
  if (!m) return null;
  const t = Number(m[1]);
  return Number.isFinite(t) && t > 0 ? t : null;
}

/** Settled by its name's staging stamp; a name without one falls back to mtime. */
function isStagedSettled(item: File | Directory, now: number): boolean {
  const t = stagedAt(baseName(item.uri));
  if (t === null) return isSettled(item, now);
  return now - t >= SWEEP_GRACE_MS;
}

/** Caches file recording when the startup sweep first saw each Documents/Inbox copy. */
const INBOX_SEEN_FILE = 'inbox-seen.json';

/**
 * Documents/Inbox holds the copies iOS makes for "Open in Scan Kit";
 * app/import.tsx removes each once it has staged its own, so one still here is
 * from an import that never ran. Their names carry no stamp and iOS's copy keeps
 * the original's mtime, so neither tells how long a copy has been here: the
 * sweep records when it first saw each one (in Caches/inbox-seen.json) and
 * deletes it only on a later launch, SWEEP_GRACE_MS after that. A cold
 * "Open in" of an old file is therefore never deleted before it is staged.
 */
function sweepInbox(now: number): number {
  let removed = 0;
  const seenFile = new File(Paths.cache, INBOX_SEEN_FILE);
  let seen: Record<string, number> = {};
  try {
    if (seenFile.exists) {
      const parsed = JSON.parse(seenFile.textSync());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) seen = parsed;
    }
  } catch {}
  let items: (Directory | File)[] = [];
  try {
    const dir = new Directory(Paths.document, 'Inbox');
    if (dir.exists) items = dir.list();
  } catch {
    return 0; // can't list it: keep the record as it is, delete nothing
  }
  const next: Record<string, number> = {};
  for (const item of items) {
    const name = baseName(item.uri);
    const first = typeof seen[name] === 'number' && seen[name] <= now ? seen[name] : now;
    if (now - first >= SWEEP_GRACE_MS) {
      try {
        item.delete();
        removed++;
        continue;
      } catch {}
    }
    next[name] = first;
  }
  try {
    if (Object.keys(next).length > 0) seenFile.write(JSON.stringify(next));
    else if (seenFile.exists) seenFile.delete();
  } catch {}
  // Documents is visible in the Files app ("Keep a copy in Files"): an empty
  // Inbox left by iOS would show there as a stray folder. iOS makes it again
  // when it next hands the app a file.
  if (Object.keys(next).length === 0) {
    try {
      const dir = new Directory(Paths.document, 'Inbox');
      if (dir.exists && dir.list().length === 0) dir.delete();
    } catch {}
  }
  return removed;
}

/**
 * Removes temp files older than SWEEP_GRACE_MS that earlier sessions left
 * behind: scanner output in Documents/, auto-crop output in tmp/, picker,
 * manipulator and export leftovers in Caches/, and "Open in" staging copies
 * (aged by the stamp in their names, see stagedAt, and by first sighting in
 * Documents/Inbox, see sweepInbox). Returns how many were removed.
 */
export function sweepTempLeftovers(now: number = Date.now()): number {
  let removed = 0;
  const sweep = (
    dir: Directory,
    match: (name: string) => boolean,
    settled: (item: File | Directory, now: number) => boolean = isSettled,
  ) => {
    let items: (Directory | File)[];
    try {
      if (!dir.exists) return;
      items = dir.list();
    } catch {
      return;
    }
    for (const item of items) {
      try {
        if (!match(baseName(item.uri)) || !settled(item, now)) continue;
        item.delete();
        removed++;
      } catch {}
    }
  };
  // Documents is the user's folder: only the scanner's exact output name and
  // an older build's Files-copy temp (a dot-file) are ever removed there.
  sweep(new Directory(Paths.document), name => isScannerOutputName(name) || FILES_COPY_TEMP.test(name));
  for (const name of TEMP_DIRS) {
    sweep(new Directory(Paths.cache, name), () => true, name === 'incoming' ? isStagedSettled : isSettled);
  }
  sweep(new Directory(Paths.cache), name => LEGACY_STAGED.test(name), isStagedSettled);
  removed += sweepInbox(now);
  const root = containerRoot();
  if (root) sweep(new Directory(`${root}tmp`), name => /^doc-[0-9A-F-]+\.jpg$/i.test(name));
  return removed;
}

/**
 * Copies an imported PDF from a temp URI to permanent storage.
 * Returns the stored file:// URI.
 */
export function copyPdfToStorage(tempUri: string, docId: string): string {
  const dir = resolveDocDir(docId);
  dir.create({ intermediates: true, idempotent: true });
  const dest = new File(dir, 'document.pdf');
  const src = new File(tempUri);
  src.copy(dest);
  return dest.uri;
}
