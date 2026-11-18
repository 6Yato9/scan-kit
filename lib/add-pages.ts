// lib/add-pages.ts
//
// Appends newly scanned or imported pages to an existing document through the
// same pipeline a new scan goes through: auto-crop for library photos, the
// user's scan quality, their default filter (baked, then recorded), and a
// refreshed text index.
import { File } from 'expo-file-system';
import { docDir } from './storage-layout';
import { Document, PageAdjustment, PageFilter } from '../types/document';
import { copyPageWithQuality, deleteDisposableTemps, isScannerOutput, moveScannerOutputToCaches } from './files';
import { getDocument, updateDocumentWith } from './storage';
import { bakePages, runPageEdit } from './bake';
import { indexDocText } from './save-scan';
import { autoCropDocument } from './document-detect';

export type AddPagesResult = { doc: Document; added: number[] };

export type AddPagesOptions = {
  /**
   * Find the page in each photo and straighten it (lib/document-detect). By
   * default every input except the document scanner's own output is cropped —
   * the scanner has already done it, with the user's own corner adjustments.
   */
  autoCrop?: boolean;
};

/**
 * Copies `uris` into `docId` as new trailing pages (recompressed at `quality`,
 * capped in size) and records them on the CURRENT stored document — read fresh
 * under the page lock, so a filter that finished baking a moment ago isn't
 * overwritten with an older in-memory copy. Returns the updated document and
 * the new page indices.
 *
 * All or nothing: if any page fails to copy, the pages already written for this
 * call are removed again, so a retry starts clean and the document never
 * gains files it doesn't list. Temp inputs (scanner, picker, auto-crop output)
 * are deleted once stored.
 *
 * Applying the default filter and re-indexing text are started afterwards and
 * not awaited (see finishAddedPages).
 */
export async function addPagesToDocument(
  docId: string,
  rawUris: string[],
  quality: number,
  options: AddPagesOptions = {},
): Promise<AddPagesResult> {
  // Scanner pages land in Documents (shown in the Files app): out of there
  // first, whoever called (the viewer passes the scanner's result straight in).
  const uris = moveScannerOutputToCaches(rawUris);
  // Auto-crop before taking the page lock: it's slow and touches no stored file.
  const inputs: string[] = [];
  for (const uri of uris) {
    const crop = options.autoCrop ?? !isScannerOutput(uri);
    inputs.push(crop ? (await autoCropDocument(uri, quality)).uri : uri);
  }

  const result = await runPageEdit(docId, {}, async () => {
    const current = await getDocument(docId);
    if (!current) throw new Error('document missing');
    const start = current.pages.length;
    const dir = docDir(docId);
    const stored: string[] = [];
    try {
      for (let i = 0; i < inputs.length; i++) {
        // A shadow left at this index by an older edit would be taken for the
        // new page's unfiltered original by its first bake.
        const staleShadow = new File(dir, `page-${start + i}.orig.jpg`);
        if (staleShadow.exists) staleShadow.delete();
        stored.push(await copyPageWithQuality(inputs[i], docId, start + i, quality));
      }
      const pad = <T,>(arr: T[] | undefined, fill: () => T): T[] | undefined =>
        arr ? [...arr, ...stored.map(fill)] : undefined;
      // Only the fields this edit changes are written, merged onto the stored
      // record, so nothing else written meanwhile (a rename, the text index)
      // is replaced by this call's older copy.
      const patch: Partial<Document> = {
        pages: [...current.pages, ...stored],
        filters: pad<PageFilter>(current.filters, () => 'original'),
        adjustments: pad<PageAdjustment>(current.adjustments, () => ({ brightness: 0, contrast: 0, saturation: 0 })),
        updatedAt: Date.now(),
      };
      let doc: Document | null = null;
      const written = await updateDocumentWith(docId, latest => {
        doc = { ...latest, ...patch };
        return patch;
      });
      if (!written || !doc) throw new Error('document missing');
      return { doc: doc as Document, added: stored.map((_, i) => start + i) };
    } catch (err) {
      for (let i = 0; i < inputs.length; i++) {
        try {
          const f = new File(dir, `page-${start + i}.jpg`);
          if (f.exists) f.delete();
        } catch {}
      }
      throw err;
    }
  });

  deleteDisposableTemps([...uris, ...inputs]);
  return result;
}

/** Bakes the default filter into the new pages, then refreshes the text index. */
export function finishAddedPages(doc: Document, added: number[], filter: PageFilter | 'original'): void {
  (async () => {
    if (filter !== 'original') await bakePages(doc.id, added, filter);
    const fresh = await getDocument(doc.id);
    if (fresh) await indexDocText(fresh.id, fresh.pages);
  })().catch(err => console.error('finishAddedPages', err));
}
