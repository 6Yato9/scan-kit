// lib/add-pages.ts
//
// Appends newly scanned or imported pages to an existing document through the
// same pipeline a new scan goes through: the user's scan quality, their default
// filter, and a refreshed text index.
import { Document, PageAdjustment, PageFilter } from '../types/document';
import { copyPageWithQuality } from './files';
import { getDocuments, updateDocument } from './storage';
import { bakePages, runPageEdit } from './bake';
import { indexDocText } from './save-scan';

export type AddPagesResult = { doc: Document; added: number[] };

/**
 * Copies `uris` into `docId` as new trailing pages (recompressed at `quality`)
 * and records them on the CURRENT stored document — read fresh under the page
 * lock, so a filter that finished baking a moment ago isn't overwritten with an
 * older in-memory copy. Returns the updated document and the new page indices.
 *
 * Applying the default filter and re-indexing text are started afterwards and
 * not awaited (see finishAddedPages).
 */
export async function addPagesToDocument(docId: string, uris: string[], quality: number): Promise<AddPagesResult> {
  return runPageEdit(docId, {}, async () => {
    const docs = await getDocuments();
    const current = docs.find(d => d.id === docId);
    if (!current) throw new Error('document missing');
    const start = current.pages.length;
    const stored: string[] = [];
    for (let i = 0; i < uris.length; i++) {
      stored.push(await copyPageWithQuality(uris[i], docId, start + i, quality));
    }
    const pad = <T,>(arr: T[] | undefined, fill: () => T): T[] | undefined =>
      arr ? [...arr, ...stored.map(fill)] : undefined;
    const doc: Document = {
      ...current,
      pages: [...current.pages, ...stored],
      filters: pad<PageFilter>(current.filters, () => 'original'),
      adjustments: pad<PageAdjustment>(current.adjustments, () => ({ brightness: 0, contrast: 0, saturation: 0 })),
      updatedAt: Date.now(),
    };
    await updateDocument(doc);
    return { doc, added: stored.map((_, i) => start + i) };
  });
}

/** Bakes the default filter into the new pages, then refreshes the text index. */
export function finishAddedPages(doc: Document, added: number[], filter: PageFilter | 'original'): void {
  (async () => {
    if (filter !== 'original') await bakePages(doc.id, added, filter);
    const docs = await getDocuments();
    const fresh = docs.find(d => d.id === doc.id);
    if (fresh) await indexDocText(fresh.id, fresh.pages);
  })().catch(err => console.error('finishAddedPages', err));
}
