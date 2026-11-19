// lib/page-source.ts
//
// RE-CROPPABLE PAGES. A page made from a photo keeps that photo — uncropped,
// upright (EXIF baked in), at most SOURCE_MAX_EDGE px — as its SOURCE, next to
// the page, together with the crop that made the page from it:
//
//   page-N.jpg        the page (filtered)                       — as always
//   page-N.orig.jpg   the page before its filter (when baked)   — as always
//   page-N.src.jpg    the uncropped source photo                — new, optional
//   page-N.src.json   { v, quad, rotation, bytes, md5 }         — new, optional
//
// so Crop can show the WHOLE photo again and the user can widen a crop that
// was too tight. The page's pixels are always
//
//   page = filter( warp(source, quad) )      (`quad` already carries the turn,
//   .orig = warp(source, quad)                see lib/quad.ts)
//
// Pages without a source (every page saved before this, document-camera pages,
// PDF pages, and any page when "Keep original photos" is off) behave exactly
// as before: nothing here touches them until the user crops one.
//
// THE STAMP. `bytes`/`md5` identify the page's unfiltered image (its .orig, or
// the page itself while it has none) at the moment the geometry was written.
// readPageSource trusts a source ONLY while that image is still exactly the
// one its geometry produced. Anything else that changes the unfiltered pixels
// — Markup, Sign, Watermark, Erase marks, Compress, an older build, a crash
// between two renames, a stale file left at an index — makes the stamp
// mismatch, and the page is then treated as having no source (Crop shows the
// page as it is, which keeps those edits). So a source can never be paired
// with the wrong page, and re-cropping can never silently throw an edit away.
//
// THE ORIGINAL PHOTO (R12b). A source whose stamp no longer matches because
// the page was edited since (Sign, Markup, Watermark, Timestamp) is kept on
// disk: Crop offers it as "Original photo" (originalTargetFor), clearly
// marked as starting the page again from the photo — which drops those edits.
// Re-cropping it re-stamps the source, so it is a normal source again. It is
// never offered for a redacted page: Redact deletes the page's source
// (lib/page-stamp.ts; its Undo puts it back with the unredacted page), and
// Compress drops it too (the photo would undo the saving).
//
// File families. The two source files move with their page exactly like the
// `.orig` shadow does, in every operation of lib/files.ts (copy, delete-shift,
// reorder, restore, merge, extract, duplicate, the startup sweep) — see
// PAGE_FAMILY_SUFFIXES there. Sources are internal: nothing exports, shares or
// copies them to Files (those all work from `document.pages`).
//
// API FOR CAPTURE / IMPORT (see scratchpad r12recrop/API.md): saveScan,
// addPagesToDocument and retakePage accept, per page, either a plain image URI
// (stored as before) or a SourcePageInput { sourceUri, quad }.
import { Directory, File, Paths } from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { VisionOcr } from '../modules/vision-ocr/src';
import { resolveDocDir } from './storage-layout';
import { MAX_PAGE_EDGE, cappedSize, getImageSize } from './image-size';
import {
  FULL_QUAD,
  isConvexQuad,
  isQuad,
  isRotation,
  normRotation,
  quadBounds,
  rotateGeometry,
  type PageGeometry,
  type Quad,
  type Rotation,
} from './quad';

/** Long-edge cap of a stored source photo (a 48 MP photo is 8064 px). */
export const SOURCE_MAX_EDGE = 4096;
/** JPEG quality of a stored source photo. */
export const SOURCE_QUALITY = 0.9;
/** Caches folder for this module's intermediate files (swept at startup, lib/files.ts TEMP_DIRS). */
export const SOURCE_TEMP_DIR = 'page-source';

// ── Inputs ──────────────────────────────────────────────────────────────────

/**
 * A captured or imported page together with the photo it came from.
 *  - `sourceUri`: the photo, as captured (any orientation; EXIF is honoured).
 *  - `quad`: the page outline on the UPRIGHT photo, [x0,y0,…,x3,y3]
 *    normalised 0..1, top-left origin, TL,TR,BR,BL (VisionOcr.detectQuad's
 *    format). null (or an invalid/non-convex quad) = the whole photo.
 *  - `rotation`: optional clockwise turn of the finished page (default 0).
 */
export type SourcePageInput = { sourceUri: string; quad: Quad | null; rotation?: Rotation };

/** What the save paths accept per page: a finished image URI, or a photo plus its crop. */
export type ScanPageInput = string | SourcePageInput;

export function isSourceInput(p: ScanPageInput | null | undefined): p is SourcePageInput {
  return !!p && typeof p === 'object' && typeof (p as SourcePageInput).sourceUri === 'string';
}

/** The file an input refers to (for temp cleanup and bookkeeping). */
export function inputUri(p: ScanPageInput): string {
  return isSourceInput(p) ? p.sourceUri : p;
}

/** The geometry an input asks for: its quad when usable, else the whole photo. */
export function geometryOfInput(p: SourcePageInput): PageGeometry {
  const quad = p.quad && isConvexQuad(p.quad) ? p.quad.map(n => Math.min(1, Math.max(0, n))) : [...FULL_QUAD];
  return rotateGeometry({ quad, rotation: 0 }, isRotation(p.rotation) ? p.rotation : 0);
}

// ── Native functions (optional: feature-checked like the other VisionOcr calls) ──

type QuadNative = {
  detectQuad?: (uri: string) => Promise<number[] | null>;
  warpQuad?: (srcUri: string, quad: number[], outUri: string, quality: number, maxEdge: number) => Promise<{ uri: string; width: number; height: number }>;
  normalizeImage?: (srcUri: string, outUri: string, maxEdge: number, quality: number) => Promise<{ uri: string; width: number; height: number }>;
};

function native(): QuadNative | null {
  return (VisionOcr as unknown as QuadNative | null) ?? null;
}

export function canDetectQuad(): boolean {
  return typeof native()?.detectQuad === 'function';
}

export function canWarp(): boolean {
  return typeof native()?.warpQuad === 'function';
}

/** The page outline in a photo (see SourcePageInput.quad), or null when none is found / unavailable. */
export async function detectQuad(uri: string): Promise<Quad | null> {
  const fn = native()?.detectQuad;
  if (typeof fn !== 'function') return null;
  try {
    const q = await fn(uri.split('?')[0]);
    return q && isQuad(q) && isConvexQuad(q) ? q.map(n => Math.min(1, Math.max(0, n))) : null;
  } catch {
    return null;
  }
}

function tempDir(): Directory {
  const dir = new Directory(Paths.cache, SOURCE_TEMP_DIR);
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

let tempSeq = 0;
function tempFile(tag: string): File {
  return new File(tempDir(), `${tag}-${Date.now()}-${++tempSeq}.jpg`);
}

const clean = (u: string) => u.split('?')[0];

function deleteQuietly(uri: string | null | undefined): void {
  if (!uri) return;
  try {
    const f = new File(clean(uri));
    if (f.exists) f.delete();
  } catch {}
}

/**
 * An upright (EXIF applied), size-capped JPEG copy of `srcUri` at `outUri`.
 * Native normalizeImage when present; the image manipulator otherwise (it
 * also draws the photo upright).
 */
async function normalizeTo(srcUri: string, outUri: string, maxEdge: number, quality: number): Promise<string> {
  const fn = native()?.normalizeImage;
  if (typeof fn === 'function') {
    const res = await fn(clean(srcUri), outUri, maxEdge, quality);
    return clean(res?.uri || outUri);
  }
  const size = await getImageSize(srcUri);
  const capped = size ? cappedSize(size.width, size.height, maxEdge) : null;
  const resize = capped && size ? (size.width >= size.height ? { width: capped.width } : { height: capped.height }) : null;
  const res = await manipulateAsync(clean(srcUri), resize ? [{ resize }] : [], { compress: quality, format: SaveFormat.JPEG });
  const out = new File(outUri);
  if (out.exists) out.delete();
  new File(clean(res.uri)).move(out);
  return out.uri;
}

/**
 * Renders `geometry` of the image at `srcUri` (perspective-corrected and
 * turned) as a JPEG at `outUri`. Without the native warp (an older build) the
 * quad's bounding box is cut out and turned instead — never a failure.
 */
export async function renderGeometry(
  srcUri: string,
  geometry: PageGeometry,
  outUri: string,
  quality: number,
  maxEdge: number = MAX_PAGE_EDGE,
): Promise<string> {
  const fn = native()?.warpQuad;
  if (typeof fn === 'function') {
    const res = await fn(clean(srcUri), geometry.quad, outUri, quality, maxEdge);
    return clean(res?.uri || outUri);
  }
  const size = await getImageSize(srcUri);
  if (!size) throw new Error('renderGeometry: unreadable image');
  const b = quadBounds(geometry.quad);
  const actions: Parameters<typeof manipulateAsync>[1] = [];
  if (!(b.x <= 1e-3 && b.y <= 1e-3 && b.w >= 1 - 2e-3 && b.h >= 1 - 2e-3)) {
    const originX = Math.max(0, Math.round(b.x * size.width));
    const originY = Math.max(0, Math.round(b.y * size.height));
    actions.push({
      crop: {
        originX,
        originY,
        width: Math.max(1, Math.min(size.width - originX, Math.round(b.w * size.width))),
        height: Math.max(1, Math.min(size.height - originY, Math.round(b.h * size.height))),
      },
    });
  }
  if (geometry.rotation) actions.push({ rotate: geometry.rotation });
  const res = await manipulateAsync(clean(srcUri), actions, { compress: quality, format: SaveFormat.JPEG });
  const out = new File(outUri);
  if (out.exists) out.delete();
  new File(clean(res.uri)).move(out);
  return out.uri;
}

// ── Files ───────────────────────────────────────────────────────────────────

export const sourceName = (i: number) => `page-${i}.src.jpg`;
export const sourceMetaName = (i: number) => `page-${i}.src.json`;
/**
 * The geometry being written (writeSourceMeta): renamed over the real one when
 * complete. The startup sweep promotes it when the real one is missing (the
 * app died between the two steps) and deletes it otherwise (lib/files.ts).
 */
export const sourceMetaSideName = (i: number) => `page-${i}.src.new.json`;

type SourceMeta = { v: 1; quad: Quad; rotation: Rotation; bytes: number; md5: string | null };

/** The page's unfiltered image: its .orig shadow, or the page while it has none. */
function unfilteredFile(dir: Directory, i: number): File {
  const orig = new File(dir, `page-${i}.orig.jpg`);
  return orig.exists ? orig : new File(dir, `page-${i}.jpg`);
}

/** Identifies an image's bytes (md5 null: couldn't be read). */
export type Stamp = { bytes: number; md5: string | null };

/** True when two stamps describe the same bytes (an unknown md5 only compares sizes). */
export function sameStamp(a: Stamp | null | undefined, b: Stamp | null | undefined): boolean {
  return !!a && !!b && a.bytes > 0 && a.bytes === b.bytes && (!a.md5 || !b.md5 || a.md5 === b.md5);
}

function stampOf(f: File): Stamp | null {
  try {
    if (!f.exists) return null;
    const bytes = f.size;
    if (typeof bytes !== 'number' || bytes <= 0) return null;
    let md5: string | null = null;
    try { md5 = f.md5 ?? null; } catch {}
    return { bytes, md5 };
  } catch {
    return null;
  }
}

function parseMeta(text: string): SourceMeta | null {
  try {
    const m = JSON.parse(text) as Partial<SourceMeta>;
    if (!m || m.v !== 1 || !isQuad(m.quad) || !isRotation(m.rotation) || typeof m.bytes !== 'number') return null;
    return { v: 1, quad: m.quad, rotation: m.rotation, bytes: m.bytes, md5: typeof m.md5 === 'string' ? m.md5 : null };
  } catch {
    return null;
  }
}

export type PageSource = { uri: string; geometry: PageGeometry };

/**
 * Page `i`'s source photo and the geometry that made the page from it, or
 * null when it has none — or has one that no longer produced the page's
 * current unfiltered pixels (see THE STAMP above). Never throws.
 */
export function readPageSource(docId: string, i: number): PageSource | null {
  try {
    const dir = resolveDocDir(docId);
    const src = new File(dir, sourceName(i));
    const metaFile = new File(dir, sourceMetaName(i));
    if (!src.exists || !metaFile.exists) return null;
    const meta = parseMeta(metaFile.textSync());
    if (!meta) return null;
    const now = stampOf(unfilteredFile(dir, i));
    if (!now || now.bytes !== meta.bytes) return null;
    if (meta.md5 && now.md5 && meta.md5 !== now.md5) return null;
    return { uri: src.uri, geometry: { quad: meta.quad, rotation: meta.rotation } };
  } catch {
    return null;
  }
}

/** True when page `i` has any source file on disk (valid or not). */
export function hasSourceFiles(docId: string, i: number): boolean {
  try {
    const dir = resolveDocDir(docId);
    return new File(dir, sourceName(i)).exists || new File(dir, sourceMetaName(i)).exists;
  } catch {
    return false;
  }
}

/**
 * Records `geometry` for page `i`'s source, stamped with the page's CURRENT
 * unfiltered image — so call it after that image is in place. No-op without a
 * source photo.
 */
export function writeSourceMeta(docId: string, i: number, geometry: PageGeometry): boolean {
  const dir = resolveDocDir(docId);
  if (!new File(dir, sourceName(i)).exists) return false;
  const stamp = stampOf(unfilteredFile(dir, i));
  if (!stamp) return false;
  const meta: SourceMeta = { v: 1, quad: geometry.quad.map(n => Math.round(n * 1e6) / 1e6), rotation: normRotation(geometry.rotation), ...stamp };
  // Written whole beside the real file, then renamed over it: a crash leaves
  // the old geometry or the new one (or, between the delete and the rename,
  // the complete side file the startup sweep promotes) — never an empty or
  // half-written one, which would orphan the photo (r12 code review #6).
  const side = new File(dir, sourceMetaSideName(i));
  if (side.exists) side.delete();
  side.create();
  side.write(JSON.stringify(meta));
  const dest = new File(dir, sourceMetaName(i));
  if (dest.exists) dest.delete();
  side.move(dest);
  return true;
}

/** The identity of page `i`'s unfiltered image (its .orig, or the page), or null without one. */
export function unfilteredStamp(docId: string, i: number): Stamp | null {
  try {
    return stampOf(unfilteredFile(resolveDocDir(docId), i));
  } catch {
    return null;
  }
}

/** Removes page `i`'s source photo and geometry (both, whichever exist). */
export function removePageSource(docId: string, i: number): void {
  const dir = resolveDocDir(docId);
  for (const name of [sourceMetaSideName(i), sourceMetaName(i), sourceName(i)]) {
    try {
      const f = new File(dir, name);
      if (f.exists) f.delete();
    } catch {}
  }
}


// ── New pages from a photo ───────────────────────────────────────────────────

/** A page rendered from its photo, waiting in Caches to be stored. */
export type PreparedSourcePage = {
  /** The finished page pixels (unfiltered), at the requested quality. */
  page: string;
  /** The normalised source photo to keep, or null when sources aren't kept. */
  source: string | null;
  geometry: PageGeometry;
};

/**
 * Normalises the photo and renders the page from it — slow, touches no stored
 * file, so callers run it before taking the page lock. The input photo itself
 * is left alone (callers delete disposable temps).
 */
export async function prepareSourcePage(input: SourcePageInput, quality: number, keepSource: boolean): Promise<PreparedSourcePage> {
  const geometry = geometryOfInput(input);
  const normalized = await normalizeTo(input.sourceUri, tempFile('src').uri, SOURCE_MAX_EDGE, SOURCE_QUALITY);
  try {
    const page = await renderGeometry(normalized, geometry, tempFile('page').uri, quality);
    if (!keepSource) deleteQuietly(normalized);
    return { page, source: keepSource ? normalized : null, geometry };
  } catch (err) {
    deleteQuietly(normalized);
    throw err;
  }
}

/** Deletes a prepared page's temp files (safe after installPreparedSource moved the source). */
export function discardPrepared(p: PreparedSourcePage | null | undefined): void {
  if (!p) return;
  deleteQuietly(p.page);
  deleteQuietly(p.source);
}

/**
 * Gives page `i` (whose pixels — page-N.jpg, and no stale .orig — are already
 * stored) the prepared source photo and its geometry. Any source files at `i`
 * are replaced. Without a prepared source this just clears stale ones.
 */
export function installPreparedSource(p: PreparedSourcePage, docId: string, i: number): void {
  removePageSource(docId, i);
  if (!p.source) return;
  const dir = resolveDocDir(docId);
  const src = new File(clean(p.source));
  if (!src.exists) return;
  src.move(new File(dir, sourceName(i)));
  writeSourceMeta(docId, i, p.geometry);
}

// ── Re-cropping a stored page ────────────────────────────────────────────────

/** What the crop editor shows for a page, and the corners it starts from. */
export type CropTarget = {
  /** The image to show: the whole source photo, or the unfiltered page. */
  uri: string;
  geometry: PageGeometry;
  /** True when `uri` is the page's uncropped source photo. */
  hasSource: boolean;
  /** Identity of the image at `uri` when this was read (see recropPage). */
  bytes: number;
  md5: string | null;
  /**
   * Set when `uri` is the page's ORIGINAL photo that later edits (a signature,
   * markup…) no longer match (originalTargetFor): cropping it starts the page
   * again from the photo and drops those edits. Holds the identity of the
   * page's unfiltered image when the editor opened, so a change made meanwhile
   * is never thrown away unseen.
   */
  original?: Stamp;
  /**
   * Internal, for Undo (lib/recrop.ts): put back the copy of the page kept in
   * `dir` instead of rendering — only while the page's unfiltered image is
   * still exactly `written`, what the crop being undone wrote.
   */
  restore?: CropStash;
};

/**
 * The page's source with its current corners, or — without a (valid) source —
 * the page's unfiltered image with the corners on its full bounds.
 */
export function cropTargetFor(docId: string, i: number): CropTarget {
  const src = readPageSource(docId, i);
  const dir = resolveDocDir(docId);
  const file = src ? new File(src.uri) : unfilteredFile(dir, i);
  const stamp = stampOf(file) ?? { bytes: 0, md5: null };
  if (src) return { uri: src.uri, geometry: src.geometry, hasSource: true, ...stamp };
  return { uri: file.uri, geometry: { quad: [...FULL_QUAD], rotation: 0 }, hasSource: false, ...stamp };
}

/**
 * Page `i`'s original photo, when it keeps one that the page no longer matches
 * because it was edited since (see THE ORIGINAL PHOTO above), with the corners
 * last used on it. Null when the page has a valid source (cropTargetFor shows
 * that), or no usable photo and geometry at all — a photo without readable
 * geometry is never offered (a redaction interrupted between its two deletes
 * leaves exactly that). Never throws.
 */
export function originalTargetFor(docId: string, i: number): CropTarget | null {
  try {
    if (readPageSource(docId, i)) return null;
    const dir = resolveDocDir(docId);
    const src = new File(dir, sourceName(i));
    const metaFile = new File(dir, sourceMetaName(i));
    if (!src.exists || !metaFile.exists) return null;
    const meta = parseMeta(metaFile.textSync());
    if (!meta) return null;
    const page = stampOf(unfilteredFile(dir, i));
    const photo = stampOf(src);
    if (!page || !photo) return null;
    return {
      uri: src.uri,
      geometry: { quad: [...meta.quad], rotation: meta.rotation },
      hasSource: true,
      ...photo,
      original: page,
    };
  } catch {
    return null;
  }
}

// Undo for a crop that replaced pixels a source can't give back (the edited
// page, when starting again from the original photo; or a page cropped while
// its original photo is kept aside): a copy of the page and its .orig, in
// Caches/page-source (swept at launch), named for the document so deleting or
// redacting it can drop them at once.

/** A copy of a page kept for Undo, and what the crop then wrote. */
export type CropStash = { dir: string; written: Stamp };

const cropStashes = new Map<string, CropStash>();
const stashKey = (docId: string, i: number) => `${docId}/${i}`;
let stashSeq = 0;

function deleteDirQuietly(uri: string): void {
  try {
    const d = new Directory(uri);
    if (d.exists) d.delete();
  } catch {}
}

/** Copies page `i` (and its .orig) aside for Undo, or null when that fails (no space): the crop still runs. */
function stashPage(docId: string, i: number): string | null {
  const dir = new Directory(tempDir(), `undo-${docId}-${Date.now()}-${++stashSeq}`);
  try {
    dir.create({ intermediates: true, idempotent: true });
    const docFolder = resolveDocDir(docId);
    new File(docFolder, `page-${i}.jpg`).copy(new File(dir, 'page-0.jpg'));
    const orig = new File(docFolder, `page-${i}.orig.jpg`);
    if (orig.exists) orig.copy(new File(dir, 'page-0.orig.jpg'));
    return dir.uri;
  } catch (err) {
    console.warn('page-source: no Undo copy of the page', err);
    deleteDirQuietly(dir.uri);
    return null;
  }
}

/**
 * The Undo copy the last crop of page `i` kept (single use), or null when
 * that crop kept none (its source can redo the old crop instead).
 */
export function takeCropStash(docId: string, i: number): CropStash | null {
  const key = stashKey(docId, i);
  const s = cropStashes.get(key) ?? null;
  cropStashes.delete(key);
  return s;
}

/** Throws away an Undo copy nobody will use. Never throws. */
export function discardCropStash(stash: CropStash | null | undefined): void {
  if (stash) deleteDirQuietly(stash.dir);
}

/**
 * Removes every Undo copy of `docId`'s pages (the document is being deleted,
 * or redacted: the copies hold the old pixels). Never throws.
 */
export function discardCropStashes(docId: string): void {
  for (const [key, s] of [...cropStashes]) {
    if (key.startsWith(`${docId}/`)) {
      cropStashes.delete(key);
      deleteDirQuietly(s.dir);
    }
  }
  try {
    const root = new Directory(Paths.cache, SOURCE_TEMP_DIR);
    if (!root.exists) return;
    for (const item of root.list()) {
      if (item instanceof Directory && item.name.startsWith(`undo-${docId}-`)) deleteDirQuietly(item.uri);
    }
  } catch {}
}

/**
 * Re-crops page `i` of `docId` to `geometry`, measured on `target` (what
 * cropTargetFor — or originalTargetFor — returned when the editor opened).
 * Writes the page's new unfiltered pixels to its `.orig` and the page (the
 * caller re-bakes the page's filter afterwards — see app/viewer.tsx), then
 * records the geometry.
 *
 * A page without a source gets one here — the image it was cropped from — when
 * `keepSource` is on, so the next crop can be widened back again. Not when it
 * keeps an original photo aside (edited since): that photo stays, still
 * offered as the original, and the page is copied for Undo instead.
 *
 * From the original photo (`target.original`): the page is rendered from the
 * photo again — edits made since are dropped, as the editor said — and the
 * photo becomes the page's valid source again. The edited page is copied for
 * Undo (takeCropStash).
 *
 * MUST run under the document's page lock (runPageEdit) with `pages: [i]`.
 * Order: .orig first, then the page, then the geometry; an interruption
 * leaves at worst a stamp mismatch (the source is then ignored), never a page
 * paired with the wrong source. Throws (nothing stored changed) when the
 * render fails, or when the page or its source changed since the editor opened.
 */
export async function recropPage(
  docId: string,
  i: number,
  target: CropTarget,
  geometry: PageGeometry,
  options: { keepSource: boolean; quality?: number },
): Promise<string> {
  const dir = resolveDocDir(docId);
  discardCropStash(takeCropStash(docId, i)); // a newer crop: the older Undo is gone
  // The corners were placed on `target`; the image must still be that one. (A
  // filter bake finishing meanwhile may have moved the unfiltered page to its
  // .orig — same bytes, other name — which is fine.)
  const fromOriginal = !!target.original;
  const current = fromOriginal ? originalTargetFor(docId, i) : cropTargetFor(docId, i);
  const same = !!current && current.hasSource === target.hasSource && !!current.original === fromOriginal
    && sameStamp(current, target) && (!fromOriginal || sameStamp(current.original, target.original));
  if (!current || !same) throw new Error('recropPage: the page changed while it was being cropped');
  // A page cropped as it is while its original photo is kept aside.
  const keepsOriginal = !target.hasSource && originalTargetFor(docId, i) !== null;
  const quality = options.quality ?? 0.92;
  const out = tempFile('crop');
  // A .part name: the startup sweep deletes it (never promotes it) if we die.
  const sourceSide = new File(dir, `page-${i}.src.part.jpg`);
  const sourceSidePath = sourceSide.uri;
  let stash: string | null = null;
  try {
    const rendered = await renderGeometry(current.uri, geometry, out.uri, quality);
    if (fromOriginal || keepsOriginal) stash = stashPage(docId, i);
    // A page cropped for the first time keeps what it was cropped from.
    let adopt = false;
    if (!target.hasSource && options.keepSource && !keepsOriginal) {
      if (sourceSide.exists) sourceSide.delete();
      new File(clean(current.uri)).copy(sourceSide);
      adopt = true;
    }
    // Unfiltered pixels: .orig first, then the page (see the header).
    const origSide = new File(dir, `page-${i}.orig.new.jpg`);
    if (origSide.exists) origSide.delete();
    new File(rendered).copy(origSide);
    const orig = new File(dir, `page-${i}.orig.jpg`);
    if (orig.exists) orig.delete();
    origSide.move(orig);
    const pageSide = new File(dir, `page-${i}.new.jpg`);
    if (pageSide.exists) pageSide.delete();
    new File(rendered).copy(pageSide);
    const page = new File(dir, `page-${i}.jpg`);
    if (page.exists) page.delete();
    pageSide.move(page);
    if (adopt) {
      removePageSource(docId, i);
      sourceSide.move(new File(dir, sourceName(i)));
    }
    if (target.hasSource || adopt) writeSourceMeta(docId, i, geometry);
    else if (!keepsOriginal) removePageSource(docId, i);
    const written = stash ? unfilteredStamp(docId, i) : null;
    if (stash && written) {
      cropStashes.set(stashKey(docId, i), { dir: stash, written });
      stash = null;
    }
    return new File(dir, `page-${i}.jpg`).uri;
  } finally {
    deleteQuietly(out.uri);
    if (stash) deleteDirQuietly(stash); // failed, or nothing to undo to
    // A fresh handle: File.move re-points the moved instance at its destination.
    try {
      const leftover = new File(sourceSidePath);
      if (leftover.exists) leftover.delete();
    } catch {}
  }
}

/**
 * Keeps page `i`'s geometry in step after the page was turned by `deg`
 * clockwise (lib/image.ts rotatePage). `before` is readPageSource from BEFORE
 * the turn (afterwards the stamp no longer matches). No-op without one.
 */
export function noteRotation(docId: string, i: number, before: PageSource | null, deg: number): void {
  if (!before) return;
  try {
    writeSourceMeta(docId, i, rotateGeometry(before.geometry, deg));
  } catch (err) {
    console.warn('page-source: rotation not recorded', err);
  }
}

/** Bytes used by source photos in a document folder (Settings' storage view). */
export function sourceBytesOf(docId: string, pageCount: number): number {
  let total = 0;
  try {
    const dir = resolveDocDir(docId);
    for (let i = 0; i < pageCount; i++) {
      for (const name of [sourceName(i), sourceMetaName(i)]) {
        const f = new File(dir, name);
        if (f.exists) total += f.size ?? 0;
      }
    }
  } catch {}
  return total;
}
