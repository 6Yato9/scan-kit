// lib/page-stamp.ts
//
// Sign, Watermark and Timestamp, edited in place. The mark is drawn into the
// page JPEG itself (components/page-stamper.tsx does the drawing) so the
// document stays a set of image pages: searchable, re-filterable, exportable
// like any scan, instead of a flattened PDF copy with no text.
//
// Every page that gets a mark also gets it on its unfiltered `.orig` shadow,
// the source every later filter change re-derives from — otherwise the next
// filter pick would quietly erase the signature (the same rule Mark up follows,
// app/annotate.tsx).
//
// Undo: before anything is written, each target page and its shadow are copied
// to their own folder in Caches/stamp-undo with the page's filter and
// adjustments. undoStamp puts them back exactly, unless the pages have been
// reordered or deleted since (then the indices mean other pages and nothing is
// touched). A stash lives until it is used, thrown away (discardStampUndo: the
// run failed, or the viewer's Undo offer expired) or swept at startup; a newer
// run never deletes another run's stash, which may still be rolling back.
//
// Runs on one document are serialized: a second Sign / Watermark / Timestamp
// started while the first is still rolling back waits for it, so its stash and
// Undo never capture the first run's half-done pages.
//
// Cancelling: a run is given a `signal` (the screen that drew the pages closed).
// It is checked before every page and once more after the last: a cancelled
// run puts back the pages it already did and fails with kind 'cancelled', so a
// document is never left half-signed and the closed screen never navigates.
//
// Writes go through runPageEdit (lib/bake.ts): under the per-document lock,
// beside the page and renamed over it (a crash can't leave a truncated page),
// and any in-flight filter bake for the page is redone from the new shadow.
import { Directory, File, Paths } from 'expo-file-system';
import { docDir } from './storage-layout';
import { writeAsStringAsync } from 'expo-file-system/legacy';
import type { Document, PageAdjustment, PageFilter } from '../types/document';
import { bakePage, runPageEdit, waitForPendingBakes, withDocLock } from './bake';
import {
  copyDocumentFiles,
  deleteDocumentFiles,
  originalSideUri,
  originalUri,
  pageLayoutGeneration,
  pageSideUri,
  promoteOriginalSide,
  promotePageSide,
  restorePageWithShadow,
} from './files';
import { pageFileUri } from './image';
import * as Crypto from 'expo-crypto';
import {
  commitPendingDocument,
  deleteDocument,
  getDocument,
  patchDocument,
  savePendingDocument,
  updateDocument,
} from './storage';
import { indexDocText } from './save-scan';

/** A page and its shadow with the mark drawn in, as JPEG data URLs (orig null when the page has none). */
export type StampedPixels = { page: string; orig: string | null };

/** Draws the mark into one page: `(pageUri, origUri | null) => pixels`. */
export type StampRender = (pageUri: string, origUri: string | null) => Promise<StampedPixels>;

const DEFAULT_ADJ: PageAdjustment = { brightness: 0, contrast: 0, saturation: 0 };
const STASH_ROOT = 'stamp-undo';
const DATA_URL_PREFIX = /^data:image\/jpeg;base64,/;

export type StampUndo = {
  docId: string;
  /** The stash folder (Caches/stamp-undo/<ts>). */
  dir: string;
  pages: { index: number; stash: string; filter: PageFilter; adjustment: PageAdjustment }[];
  /** files.ts pageLayoutGeneration when stashed: a reorder or delete since makes Undo refuse. */
  layout: number;
};

/** Something a run can be cancelled through; an AbortSignal fits. */
export type StampSignal = { readonly aborted: boolean };

/** What a failed run left behind when the pages it changed couldn't be put back. */
export type StampPartial = {
  /** Zero-based indices of the pages that carry the mark. */
  changed: number[];
  /** How many pages the run was meant to change. */
  total: number;
  /** A stash of just the changed pages, kept for another try at putting them back. */
  undo: StampUndo | null;
};

export class StampError extends Error {
  constructor(
    readonly kind: 'missing-doc' | 'missing-page' | 'pages-moved' | 'expired' | 'render' | 'cancelled' | 'partial',
    message: string,
    /** Only for kind 'partial'. */
    readonly partial?: StampPartial,
  ) {
    super(message);
    this.name = 'StampError';
  }
}

/** "page 2", "pages 1 and 2", "pages 1, 2 and 4" (zero-based in). */
export function pagesPhrase(indices: number[]): string {
  const n = [...indices].sort((a, b) => a - b).map(i => String(i + 1));
  if (n.length === 1) return `page ${n[0]}`;
  return `pages ${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}

/** The truthful message for a run that stopped part-way and couldn't put its pages back. */
export function partialMessage(changed: number[], total: number): string {
  const what = pagesPhrase(changed);
  const verb = changed.length === 1 ? 'was' : 'were';
  const rest = total > changed.length ? ' The other pages weren’t changed.' : '';
  return `${what[0].toUpperCase()}${what.slice(1)} ${verb} changed before the error and couldn’t be put back.${rest}`;
}

/** Which pages a "this page" / "every page" choice means, clamped to the document. */
export function targetPages(pageCount: number, pageIndex: number, everyPage: boolean): number[] {
  if (pageCount <= 0) return [];
  if (everyPage) return Array.from({ length: pageCount }, (_, i) => i);
  return [Math.min(Math.max(0, pageIndex), pageCount - 1)];
}

/** A comparable snapshot of one page's recorded filter + adjustment. */
export function lookOf(doc: Pick<Document, 'filters' | 'adjustments'>, index: number): string {
  return JSON.stringify([doc.filters?.[index] ?? 'original', doc.adjustments?.[index] ?? null]);
}

/** Sets `index` of a per-page list, materialising it when absent; collapses to undefined when all default. */
function withEntry<T>(list: T[] | undefined, length: number, index: number, value: T, fill: () => T): T[] {
  const out = Array.from({ length }, (_, i) => list?.[i] ?? fill());
  if (index < length) out[index] = value;
  return out;
}
const allOriginal = (f: PageFilter[]) => f.every(x => x === 'original');
const allDefaultAdj = (a: PageAdjustment[]) => a.every(x => !x.brightness && !x.contrast && !x.saturation);

/** Throws away an Undo nobody will use (best effort). */
export function discardStampUndo(undo: StampUndo | null | undefined): void {
  if (!undo) return;
  try {
    const dir = new Directory(undo.dir);
    if (dir.exists) dir.delete();
  } catch {}
}

/**
 * Copies pages `indices` of `doc` (and their shadows) to a fresh stash.
 * Each page gets its own folder and is named page-0, so restorePageWithShadow
 * finds the `.orig` next to it.
 */
let stashSeq = 0;
function stashPages(doc: Document, indices: number[]): StampUndo {
  // Its own folder: another run's stash (still needed for its rollback or its
  // Undo) is never touched.
  const dir = new Directory(Paths.cache, STASH_ROOT, `${Date.now()}-${++stashSeq}`);
  dir.create({ intermediates: true, idempotent: true });
  const srcDir = docDir(doc.id);
  const pages = indices.map(index => {
    const sub = new Directory(dir, String(index));
    sub.create({ intermediates: true, idempotent: true });
    const page = new File(sub, 'page-0.jpg');
    new File(srcDir, `page-${index}.jpg`).copy(page);
    const orig = new File(srcDir, `page-${index}.orig.jpg`);
    if (orig.exists) orig.copy(new File(sub, 'page-0.orig.jpg'));
    return {
      index,
      stash: page.uri,
      filter: doc.filters?.[index] ?? ('original' as PageFilter),
      adjustment: doc.adjustments?.[index] ?? { ...DEFAULT_ADJ },
    };
  });
  return { docId: doc.id, dir: dir.uri, pages, layout: pageLayoutGeneration(doc.id) };
}

export type StampPagesOptions = {
  /** Keep a copy of the pages for undoStamp (default true). */
  undo?: boolean;
  onProgress?: (done: number, total: number) => void;
  /** Aborted (the screen closed): stop, put back what was done, fail with kind 'cancelled'. */
  signal?: StampSignal;
};

// One run per document at a time (see the header). Keyed by document id.
const runTails = new Map<string, Promise<unknown>>();
function serialPerDoc<T>(docId: string, fn: () => Promise<T>): Promise<T> {
  const prev = runTails.get(docId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  runTails.set(docId, tail);
  tail.then(() => { if (runTails.get(docId) === tail) runTails.delete(docId); });
  return run;
}

const cancelled = () => new StampError('cancelled', 'The change was cancelled. Your document is unchanged.');

export type StampPagesResult = { doc: Document; undo: StampUndo | null };

/**
 * Draws a mark into pages `indices` of `docId`, in place. Pages are done one at
 * a time (each is a few MB of pixels in flight); if one fails, the pages done
 * before it are put back, so a document is never left half-signed. Re-indexes
 * the text afterwards (only the changed pages are read again: lib/ocr-cache).
 */
export function stampPages(
  docId: string,
  indices: number[],
  render: StampRender,
  options: StampPagesOptions = {},
): Promise<StampPagesResult> {
  return serialPerDoc(docId, () => stampPagesNow(docId, indices, render, options));
}

async function stampPagesNow(
  docId: string,
  indices: number[],
  render: StampRender,
  options: StampPagesOptions,
): Promise<StampPagesResult> {
  const { undo: keepUndo = true, onProgress, signal } = options;
  if (signal?.aborted) throw cancelled();
  // A filter still being baked would land on top of the mark (it re-derives
  // from the .orig it read before) — let those finish first.
  await waitForPendingBakes(docId, { timeoutMs: 60_000 });

  const start = await getDocument(docId);
  if (!start) throw new StampError('missing-doc', 'This document is no longer available.');
  const targets = [...new Set(indices)].filter(i => Number.isInteger(i) && i >= 0 && i < start.pages.length).sort((a, b) => a - b);
  if (targets.length === 0) throw new StampError('missing-page', 'That page no longer exists.');

  const undo = keepUndo ? await withDocLock(docId, () => stashPages(start, targets)) : null;
  const layout = undo?.layout ?? pageLayoutGeneration(docId);
  const done: number[] = [];
  const rebake: { index: number; filter: PageFilter; adjustment: PageAdjustment | undefined }[] = [];
  onProgress?.(0, targets.length);

  try {
    for (const index of targets) {
      if (signal?.aborted) throw cancelled();
      const before = await getDocument(docId);
      if (!before) throw new StampError('missing-doc', 'This document is no longer available.');
      const look = lookOf(before, index);
      const origFile = new File(originalUri(docId, index));
      const pixels = await render(pageFileUri(docId, index), origFile.exists ? origFile.uri : null);
      if (signal?.aborted) throw cancelled();

      await runPageEdit(docId, { pages: [index] }, async () => {
        if (pageLayoutGeneration(docId) !== layout) {
          throw new StampError('pages-moved', 'The pages were moved while the change was being made.');
        }
        const current = await getDocument(docId);
        if (!current) throw new StampError('missing-doc', 'This document is no longer available.');
        if (index >= current.pages.length) throw new StampError('missing-page', 'That page no longer exists.');
        const hasOrig = new File(originalUri(docId, index)).exists;
        // A page with a shadow but no stamped shadow would lose the mark on
        // the next filter change: refuse rather than write half of it.
        if (hasOrig && !pixels.orig) throw new StampError('render', 'The unfiltered copy of the page couldn’t be updated.');
        await writeAsStringAsync(pageSideUri(docId, index), pixels.page.replace(DATA_URL_PREFIX, ''), { encoding: 'base64' });
        if (hasOrig) {
          await writeAsStringAsync(originalSideUri(docId, index), pixels.orig!.replace(DATA_URL_PREFIX, ''), { encoding: 'base64' });
        }
        promotePageSide(docId, index);
        if (hasOrig) promoteOriginalSide(docId, index);
        done.push(index);
        // updatedAt busts the image caches that show the page.
        await patchDocument(docId, { updatedAt: Date.now() });
        // A bake landed between reading the page and writing it (it waited for
        // nothing above, or started meanwhile): the page pixels were stale, the
        // shadow is right. Re-derive the page from the shadow with its look.
        if (hasOrig && lookOf(current, index) !== look) {
          rebake.push({ index, filter: current.filters?.[index] ?? 'original', adjustment: current.adjustments?.[index] });
        }
      });
      onProgress?.(done.length, targets.length);
    }
    // Closed while the last page was being written: nobody is left to offer
    // Undo, so the whole change goes back.
    if (signal?.aborted) throw cancelled();
  } catch (err) {
    if (undo && done.length) {
      try {
        await restoreStashed(undo, done);
      } catch (restoreErr) {
        // The pages done so far still carry the mark. Say so, and keep their
        // stash so putting them back can be tried again.
        console.warn('Stamp: putting the pages back failed', restoreErr);
        const changed = [...done];
        const kept: StampUndo = { ...undo, pages: undo.pages.filter(p => changed.includes(p.index)) };
        for (const p of undo.pages) {
          if (changed.includes(p.index)) continue;
          try {
            const sub = new Directory(undo.dir, String(p.index));
            if (sub.exists) sub.delete();
          } catch {}
        }
        throw new StampError('partial', partialMessage(changed, targets.length), {
          changed,
          total: targets.length,
          undo: kept,
        });
      }
    }
    discardStampUndo(undo);
    // The screen closed (its stamper fails whatever was drawing): what was done
    // is back, and there is no one to tell — report it as cancelled.
    throw signal?.aborted ? cancelled() : err;
  }

  for (const r of rebake) {
    bakePage(docId, r.index, r.filter, r.adjustment).catch(e => console.warn('Re-bake after stamp failed', e));
  }
  const doc = (await getDocument(docId)) ?? start;
  indexDocText(docId, doc.pages).catch(() => {});
  return { doc, undo };
}

/** Puts the stashed copies of `only` (default: every stashed page) back. Runs its own page edit. */
async function restoreStashed(undo: StampUndo, only?: number[]): Promise<Document> {
  const entries = only ? undo.pages.filter(p => only.includes(p.index)) : undo.pages;
  return runPageEdit(undo.docId, { pages: entries.map(p => p.index) }, async () => {
    if (pageLayoutGeneration(undo.docId) !== undo.layout) {
      throw new StampError('pages-moved', 'The pages have been moved or deleted since, so the change can’t be undone.');
    }
    const current = await getDocument(undo.docId);
    if (!current) throw new StampError('missing-doc', 'This document is no longer available.');
    const n = current.pages.length;
    // Check everything before touching anything: all pages come back, or none.
    for (const p of entries) {
      if (p.index >= n) throw new StampError('missing-page', 'That page no longer exists.');
      if (!new File(p.stash).exists) throw new StampError('expired', 'The earlier version of the page is no longer available.');
    }
    const pages = [...current.pages];
    let filters = current.filters;
    let adjustments = current.adjustments;
    for (const p of entries) {
      pages[p.index] = restorePageWithShadow(p.stash, undo.docId, p.index);
      filters = withEntry<PageFilter>(filters, n, p.index, p.filter, () => 'original');
      adjustments = withEntry<PageAdjustment>(adjustments, n, p.index, p.adjustment, () => ({ ...DEFAULT_ADJ }));
    }
    const doc: Document = {
      ...current,
      pages,
      filters: filters && !allOriginal(filters) ? filters : undefined,
      adjustments: adjustments && !allDefaultAdj(adjustments) ? adjustments : undefined,
      updatedAt: Date.now(),
    };
    if (!(await updateDocument(doc))) throw new StampError('missing-doc', 'This document is no longer available.');
    return doc;
  });
}

/**
 * Undo for stampPages: every stamped page (and its shadow, filter and
 * adjustments) goes back to how it was. Single use. Refuses with StampError
 * when the pages were reordered or deleted since, or the copy is gone.
 */
export async function undoStamp(undo: StampUndo): Promise<Document> {
  const doc = await restoreStashed(undo);
  discardStampUndo(undo);
  indexDocText(doc.id, doc.pages).catch(() => {});
  return doc;
}

/**
 * "Save as a copy": duplicates `source` (pages, shadows, filters, text) under
 * `name`, then draws the mark into the copy's pages. The original is not
 * touched. The copy is created hidden and pending (lib/storage
 * savePendingDocument) and only shown once every page carries the mark: a
 * failure removes it, and a crash part-way leaves a pending record the startup
 * sweep deletes — never a half-signed copy in the list.
 */
export async function stampCopy(
  source: Document,
  name: string,
  indices: number[],
  render: StampRender,
  onProgress?: (done: number, total: number) => void,
  signal?: StampSignal,
): Promise<Document> {
  if (signal?.aborted) throw cancelled();
  await waitForPendingBakes(source.id, { timeoutMs: 60_000 });
  // After any run still going on the source (it may be rolling back).
  const copy = await serialPerDoc(source.id, () =>
    withDocLock(source.id, async () => {
      const fresh = await getDocument(source.id);
      if (!fresh || fresh.pdfUri || fresh.pages.length === 0) {
        throw new StampError('missing-doc', 'This document is no longer available.');
      }
      const id = Crypto.randomUUID();
      const now = Date.now();
      const doc: Document = {
        id,
        name,
        folder: fresh.folder,
        ocrText: fresh.ocrText,
        createdAt: now,
        updatedAt: now,
        pages: copyDocumentFiles(fresh.id, id, fresh.pages),
        filters: fresh.filters ? [...fresh.filters] : undefined,
        adjustments: fresh.adjustments ? fresh.adjustments.map(a => ({ ...a })) : undefined,
      };
      try {
        await savePendingDocument(doc);
      } catch (err) {
        try { deleteDocumentFiles(id); } catch {}
        throw err;
      }
      return doc;
    }),
  );
  try {
    await stampPages(copy.id, indices, render, { undo: false, onProgress, signal });
    if (!(await commitPendingDocument(copy.id, { updatedAt: Date.now() }))) {
      throw new StampError('missing-doc', 'This document is no longer available.');
    }
    return (await getDocument(copy.id)) ?? copy;
  } catch (err) {
    await deleteDocument(copy.id).catch(() => {});
    try { deleteDocumentFiles(copy.id); } catch {}
    throw err;
  }
}

/** Under a tool's document list: why imported PDFs are missing from it. */
export const PDF_NOT_LISTED_NOTE = 'Imported PDFs aren’t listed. Open one and choose Convert to pages to edit it.';

/** The copy's name: "Lease (signed)". */
export function copyName(name: string, suffix: 'signed' | 'watermarked' | 'timestamped'): string {
  return `${name} (${suffix})`;
}
