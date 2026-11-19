// lib/doc-ops.ts
// Whole-document operations shared by Home, Files and the tools: duplicate,
// merge, reorder and extract.
//
// Merging copies each page's `.orig` shadow alongside it. Without it the next
// launch's bake migration re-applies the recorded filter on top of pixels that
// already carry it, and "Original" can no longer be restored for those pages.
import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import { docDir } from './storage-layout';
import { Document, PageAdjustment, PageFilter } from '../types/document';
import { copyDocumentFiles, copyPageWithShadow, copyPdfToStorage, deleteDocumentFiles, reorderPages } from './files';
import { PAGE_FAMILY_SUFFIXES, PAGE_SHADOW_SUFFIXES } from './page-family';
import { deleteDocument, getDocument, patchDocument, saveDocument, trashDocument } from './storage';
import { remapForReorder, runPageEdit, withDocLock } from './bake';
import { indexDocText } from './save-scan';
import { mergeUndoToken, type MergeUndo } from './merge-undo';

const DEFAULT_ADJ: PageAdjustment = { brightness: 0, contrast: 0, saturation: 0 };

/**
 * Copies `source`'s pages (and their shadows: `.orig`, and the source photo
 * and crop geometry of lib/page-source.ts) into `destId`'s folder starting at
 * `startIndex`. Returns the new page URIs.
 */
export function copyPagesWithOriginals(source: Document, destId: string, startIndex: number): string[] {
  const dest = docDir(destId);
  dest.create({ intermediates: true, idempotent: true });
  const srcDir = docDir(source.id);
  return source.pages.map((uri, i) => {
    const to = new File(dest, `page-${startIndex + i}.jpg`);
    if (to.exists) to.delete();
    new File(uri.split('?')[0]).copy(to);
    for (const suffix of PAGE_SHADOW_SUFFIXES) {
      const from = new File(srcDir, `page-${i}${suffix}`);
      const destShadow = new File(dest, `page-${startIndex + i}${suffix}`);
      if (destShadow.exists) destShadow.delete();
      if (from.exists) from.copy(destShadow);
    }
    return to.uri;
  });
}

/** Per-page filters/adjustments for a merged page list, collapsed when all default. */
export function combinePageMeta(docs: Document[]): Pick<Document, 'filters' | 'adjustments'> {
  const filters: PageFilter[] = docs.flatMap(d => d.filters ?? d.pages.map((): PageFilter => 'original'));
  const adjustments: PageAdjustment[] = docs.flatMap(d => d.adjustments ?? d.pages.map(() => ({ ...DEFAULT_ADJ })));
  const allOriginal = filters.every(f => f === 'original');
  const allDefault = adjustments.every(a => a.brightness === 0 && a.contrast === 0 && a.saturation === 0 && !a.sharpness);
  return {
    filters: allOriginal ? undefined : filters,
    adjustments: allDefault ? undefined : adjustments,
  };
}

/** Saves and returns a copy of `doc` named "Copy of …". */
export async function duplicateDocument(doc: Document): Promise<Document> {
  const newId = Crypto.randomUUID();
  const now = Date.now();
  const base = { id: newId, name: `Copy of ${doc.name}`, folder: doc.folder, ocrText: doc.ocrText, createdAt: now, updatedAt: now };
  const newDoc: Document = doc.pdfUri
    ? { ...base, pages: [], pdfUri: copyPdfToStorage(doc.pdfUri.split('?')[0], newId) }
    : {
        ...base,
        pages: copyDocumentFiles(doc.id, newId, doc.pages),
        filters: doc.filters ? [...doc.filters] : undefined,
        adjustments: doc.adjustments ? doc.adjustments.map(a => ({ ...a })) : undefined,
      };
  await saveDocument(newDoc);
  return newDoc;
}

/**
 * Appends `source`'s pages to `target` (the source is left untouched).
 * Returns the updated target, or null if the target was deleted meanwhile.
 * See mergeIntoWithUndo.
 */
export async function mergeInto(target: Document, source: Document): Promise<Document | null> {
  return (await mergeIntoWithUndo(target, source))?.doc ?? null;
}

export type MergeIntoResult = {
  doc: Document;
  /** How many pages were appended (the source's count when the merge started). */
  added: number;
  /** Undo's fingerprint of the appended pages (lib/merge-undo.ts); null when none can be offered. */
  undo: MergeUndo | null;
};

/**
 * Appends `source`'s pages to `target` (the source is only read, never
 * written) and returns the updated target with what Undo needs to take the
 * pages out again; null if the target was deleted meanwhile.
 *
 * Runs under the target's page lock and re-reads BOTH documents there: the
 * caller's copies may be stale (a bake finished, a page was added or deleted
 * since the list was loaded), and appending at a stale page count would
 * overwrite real pages, while stale filters would undo a finished bake. The
 * Undo fingerprint is taken under the same lock, right after the write.
 *
 * The text index is refreshed afterwards (in the background, outside the
 * lock), so search finds the merged pages' words in the target too.
 */
export async function mergeIntoWithUndo(target: Document, source: Document): Promise<MergeIntoResult | null> {
  const result = await runPageEdit(target.id, {}, async (): Promise<MergeIntoResult | null> => {
    const current = await getDocument(target.id);
    if (!current) return null;
    const from = (await getDocument(source.id)) ?? source;
    const start = current.pages.length;
    const newPages = copyPagesWithOriginals(from, current.id, start);
    const updated: Document = {
      ...current,
      pages: [...current.pages, ...newPages],
      ...combinePageMeta([current, from]),
      updatedAt: Date.now(),
    };
    const ok = await patchDocument(current.id, {
      pages: updated.pages,
      filters: updated.filters,
      adjustments: updated.adjustments,
      updatedAt: updated.updatedAt,
    });
    if (!ok) {
      // Deleted between the read and the write: don't leave its copies behind.
      removePageFiles(current.id, start, newPages.length);
      return null;
    }
    let undo: MergeUndo | null = null;
    try {
      undo = mergeUndoToken(current.id, start, newPages.length);
    } catch (err) {
      console.warn('Merge: no undo', err);
    }
    return { doc: updated, added: newPages.length, undo };
  });
  if (result) {
    indexDocText(result.doc.id, result.doc.pages).catch(err => console.warn('Index merged document failed', err));
  }
  return result;
}

function removePageFiles(docId: string, start: number, count: number): void {
  const dir = docDir(docId);
  for (let i = start; i < start + count; i++) {
    for (const name of PAGE_FAMILY_SUFFIXES.map(suffix => `page-${i}${suffix}`)) {
      try {
        const f = new File(dir, name);
        if (f.exists) f.delete();
      } catch {}
    }
  }
}

/**
 * Reorders `docId`'s pages: `newOrder[newIndex] = oldIndex`. Reads the current
 * document under the page lock, so per-page filters and adjustments are carried
 * from what is stored NOW (not from a list loaded earlier, which would revert a
 * bake that finished meanwhile) and in-flight bakes follow their pages. Throws
 * when the order no longer matches the document (a page was added or deleted
 * since it was built) and leaves the pages untouched.
 */
export async function reorderDocumentPages(docId: string, newOrder: number[]): Promise<Document> {
  return runPageEdit(docId, { remap: remapForReorder(newOrder) }, async () => {
    const current = await getDocument(docId);
    if (!current) throw new Error('document missing');
    const n = current.pages.length;
    const isPermutation = newOrder.length === n && new Set(newOrder).size === n && newOrder.every(i => i >= 0 && i < n);
    if (!isPermutation) throw new Error('page count changed');
    const pages = reorderPages(docId, newOrder);
    const filters = current.filters ? newOrder.map(i => current.filters![i] ?? ('original' as PageFilter)) : undefined;
    const adjustments = current.adjustments ? newOrder.map(i => current.adjustments![i] ?? { ...DEFAULT_ADJ }) : undefined;
    const updatedAt = Date.now();
    await patchDocument(docId, { pages, filters, adjustments, updatedAt });
    return { ...current, pages, filters, adjustments, updatedAt };
  });
}

/** Creates a new document holding every page of `docs`, in order. Sources are kept. */
export async function mergeIntoNew(docs: Document[], name: string): Promise<Document> {
  const newId = Crypto.randomUUID();
  const now = Date.now();
  const pages: string[] = [];
  for (const d of docs) pages.push(...copyPagesWithOriginals(d, newId, pages.length));
  const newDoc: Document = {
    id: newId,
    name,
    pages,
    ...combinePageMeta(docs),
    createdAt: now,
    updatedAt: now,
  };
  await saveDocument(newDoc);
  // Indexed like any new document (see extractPages), so content search finds it.
  indexDocText(newDoc.id, newDoc.pages).catch(err => console.warn('Index merged document failed', err));
  return newDoc;
}

/** The stored record's pages `sorted` as a new document's fields (files copied with their shadows). */
function copyPagesToNew(fresh: Document, sorted: number[], newId: string, name: string, now: number): Document {
  const pages = sorted.map((src, dest) => copyPageWithShadow(fresh.pages[src], newId, dest));
  const filters: PageFilter[] = sorted.map(i => fresh.filters?.[i] ?? 'original');
  const adjustments: PageAdjustment[] = sorted.map(i => fresh.adjustments?.[i] ?? { ...DEFAULT_ADJ });
  return {
    id: newId,
    name: name.slice(0, 120),
    pages,
    filters: filters.every(f => f === 'original') ? undefined : filters,
    adjustments: adjustments.every(a => !a.brightness && !a.contrast && !a.saturation && !a.sharpness) ? undefined : adjustments,
    folder: fresh.folder,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Copies pages `indices` of `source` into a new document (Extract pages) and
 * returns it. The source is left untouched.
 *
 * Runs under the source's document lock and copies from the STORED record, not
 * the caller's copy: a filter bake writes a page's pixels and its label under
 * that lock, so a bake finishing mid-extract can't give a copy new pixels with
 * the old label. Throws, leaving nothing behind, if the source is gone or its
 * page count changed (the chosen indices would mean other pages).
 */
export async function extractPages(source: Document, indices: number[]): Promise<Document> {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const newId = Crypto.randomUUID();
  const created = await withDocLock(source.id, async () => {
    const fresh = await getDocument(source.id);
    if (!fresh || fresh.pages.length !== source.pages.length) throw new Error('extractPages: document changed');
    if (!sorted.length || sorted[0] < 0 || sorted[sorted.length - 1] >= fresh.pages.length) {
      throw new Error('extractPages: no such page');
    }
    try {
      const label = `${sorted.length === 1 ? 'page' : 'pages'} ${sorted.map(i => i + 1).join(', ')}`;
      const doc = copyPagesToNew(fresh, sorted, newId, `${fresh.name} (${label})`, Date.now());
      await saveDocument(doc);
      return doc;
    } catch (err) {
      try { deleteDocumentFiles(newId); } catch {}
      throw err;
    }
  });
  // Indexed like any new document, so content search finds it. In the
  // background and outside the source's lock; the copies keep their files'
  // identity, so the OCR cache usually answers without reading them again.
  indexDocText(created.id, created.pages).catch(err => console.warn('Index extracted pages failed', err));
  return created;
}

/** Page indices of the two parts of an `count`-page split after page `after` (zero-based). */
export function splitRanges(count: number, after: number): [number[], number[]] {
  if (!Number.isInteger(after) || after < 0 || after >= count - 1) throw new RangeError('nothing to split');
  const all = Array.from({ length: count }, (_, i) => i);
  return [all.slice(0, after + 1), all.slice(after + 1)];
}

export type ImageSplitResult = { first: Document; second: Document; originalTrashed: boolean };

/**
 * Splits a scanned document after page `after` (zero-based) into two new
 * documents, "<name> (1)" and "<name> (2)", in the same folder — the same
 * names and choices as splitting an imported PDF (lib/pdf-edit.ts). See
 * splitDocumentParts, which does the work.
 */
export async function splitDocument(
  sourceId: string,
  after: number,
  options: { trashOriginal?: boolean; expectedCount?: number } = {},
): Promise<ImageSplitResult> {
  const r = await splitDocumentParts(sourceId, count => splitRanges(count, after), options);
  return { first: r.parts[0], second: r.parts[1], originalTrashed: r.originalTrashed };
}

export type ImagePartsResult = { parts: Document[]; originalTrashed: boolean };

/**
 * Splits a scanned document into new documents "<name> (1)", "<name> (2)", …
 * in the same folder, one per entry of `parts` (zero-based page indices; a
 * function gets the stored page count, for callers that plan from it). Split
 * › "Every N pages" and "By ranges" (round 16) as well as the classic split
 * in two. Every page is copied with its shadows (the unfiltered .orig, the
 * source photo and its crop geometry), filter and adjustments, so each part
 * can still be filtered, re-cropped and widened like the original. Pages left
 * out of every part aren't copied; a page in two ranges is copied twice. The
 * original is kept unless `trashOriginal` (then it moves to Recently deleted,
 * where it can be restored).
 *
 * Copies from the STORED record under the source's page lock (like
 * extractPages), and refuses when its page count differs from `expectedCount`
 * (the parts would mean other pages). Nothing half-made stays: if a part
 * fails, the ones made so far are removed again.
 */
export async function splitDocumentParts(
  sourceId: string,
  parts: number[][] | ((count: number) => number[][]),
  options: { trashOriginal?: boolean; expectedCount?: number } = {},
): Promise<ImagePartsResult> {
  const made = await withDocLock(sourceId, async () => {
    const fresh = await getDocument(sourceId);
    if (!fresh || fresh.trashedAt) throw new Error('splitDocument: document missing');
    if (fresh.pdfUri || fresh.pages.length === 0) throw new Error('splitDocument: not a scanned document');
    if (options.expectedCount != null && fresh.pages.length !== options.expectedCount) throw new Error('splitDocument: document changed');
    const plan = typeof parts === 'function' ? parts(fresh.pages.length) : parts;
    if (plan.length < 1 || plan.some(p => p.length === 0 || p.some(i => !Number.isInteger(i) || i < 0 || i >= fresh.pages.length))) {
      throw new RangeError('splitDocument: no such page');
    }
    const ids = plan.map(() => Crypto.randomUUID());
    const now = Date.now();
    const docs: Document[] = [];
    try {
      for (let k = 0; k < plan.length; k++) {
        // The first part sorts as the newest in "Date added", the rest in order after it.
        const doc = copyPagesToNew(fresh, plan[k], ids[k], `${fresh.name} (${k + 1})`, now + (plan.length - 1 - k));
        await saveDocument(doc);
        docs.push(doc);
      }
    } catch (err) {
      for (const d of docs) {
        try { await deleteDocument(d.id); } catch {}
      }
      for (const id of ids) {
        try { deleteDocumentFiles(id); } catch {}
      }
      throw err;
    }
    return docs;
  });
  let originalTrashed = false;
  if (options.trashOriginal) {
    try {
      originalTrashed = await trashDocument(sourceId);
    } catch (err) {
      console.warn('Split: could not move the original to Recently deleted', err);
    }
  }
  for (const d of made) {
    indexDocText(d.id, d.pages).catch(err => console.warn('Index split part failed', err));
  }
  return { parts: made, originalTrashed };
}
