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
import { getDocument, patchDocument, saveDocument } from './storage';
import { remapForReorder, runPageEdit, withDocLock } from './bake';
import { indexDocText } from './save-scan';

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
 *
 * Runs under the target's page lock and re-reads BOTH documents there: the
 * caller's copies may be stale (a bake finished, a page was added or deleted
 * since the list was loaded), and appending at a stale page count would
 * overwrite real pages, while stale filters would undo a finished bake.
 */
export async function mergeInto(target: Document, source: Document): Promise<Document | null> {
  return runPageEdit(target.id, {}, async () => {
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
    return updated;
  });
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
  return newDoc;
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
      const pages = sorted.map((src, dest) => copyPageWithShadow(fresh.pages[src], newId, dest));
      const filters: PageFilter[] = sorted.map(i => fresh.filters?.[i] ?? 'original');
      const adjustments: PageAdjustment[] = sorted.map(i => fresh.adjustments?.[i] ?? { ...DEFAULT_ADJ });
      const now = Date.now();
      const label = `${sorted.length === 1 ? 'page' : 'pages'} ${sorted.map(i => i + 1).join(', ')}`;
      const doc: Document = {
        id: newId,
        name: `${fresh.name} (${label})`.slice(0, 120),
        pages,
        filters: filters.every(f => f === 'original') ? undefined : filters,
        adjustments: adjustments.every(a => !a.brightness && !a.contrast && !a.saturation && !a.sharpness) ? undefined : adjustments,
        folder: fresh.folder,
        createdAt: now,
        updatedAt: now,
      };
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
