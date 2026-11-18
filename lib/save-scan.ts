// lib/save-scan.ts
import * as Crypto from 'expo-crypto';
import { Document } from '../types/document';
import { saveDocument, updateDocumentWith } from './storage';
import { copyPageWithQuality, copyPdfToStorage, deleteDisposableTemps, deleteDocumentFiles } from './files';
import { ocrAvailable, extractDocText } from './ocr';
import { titleFromText } from './auto-name';
import { withDocLock } from './bake';

export type SaveScanInput = {
  pages?: string[];
  pdfUri?: string;
  name: string;
  quality: number;
  /**
   * `name` is an automatic one (autoName): once text recognition has read the
   * page, indexDocText may replace it with the page's title — unless the user
   * has renamed the document by then.
   */
  nameIsDefault?: boolean;
};

export type SaveScanResult = { id: string; pages: string[] };

/**
 * Writes a scan to storage and returns the new document id along with the
 * stored page URIs (empty for a PDF import) — callers need the real URIs for
 * things like OCR indexing rather than reconstructing the path rule themselves.
 *
 * Pages are copied sequentially so a failure names the offending page and peak
 * memory stays bounded — Promise.all would run every manipulator pass at once.
 * On any failure the partially-written directory is removed so a retry starts clean.
 *
 * Pages are always saved as 'original': a filter is recorded only by the bake
 * that writes it into the pixels (lib/bake.ts), so a bake that fails or is
 * interrupted can never leave metadata claiming a look the page doesn't have.
 *
 * Once stored, the input files that were only temps (scanner, picker and
 * auto-crop output — see isDisposableTemp) are deleted.
 */
export async function saveScan(input: SaveScanInput): Promise<SaveScanResult> {
  const { pages = [], pdfUri, name, quality, nameIsDefault } = input;
  if (!pdfUri && pages.length === 0) {
    throw new Error('saveScan: nothing to save — no pages and no pdfUri');
  }
  const id = Crypto.randomUUID();
  const now = Date.now();

  try {
    if (pdfUri) {
      const storedUri = copyPdfToStorage(pdfUri, id);
      const doc: Document = {
        id, name, pages: [], pdfUri: storedUri, createdAt: now, updatedAt: now,
      };
      await saveDocument(doc);
      deleteDisposableTemps([pdfUri]);
      return { id, pages: [] };
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

    const doc: Document = {
      id,
      name,
      pages: savedPages,
      createdAt: now,
      updatedAt: now,
      ...(nameIsDefault ? { defaultName: name } : {}),
    };
    await saveDocument(doc);
    deleteDisposableTemps(pages);
    return { id, pages: savedPages };
  } catch (err) {
    try { deleteDocumentFiles(id); } catch { /* secondary failure — keep the original error */ }
    throw err;
  }
}

/**
 * Fire-and-forget content index so search can match recognised text — and, for
 * a document still carrying its automatic name, a real name: the first line of
 * the text that reads like a title ("Invoice #2026-0417"; see titleFromText).
 *
 * OCR is slow and runs after the save already returned, so by the time it lands
 * the document may have been deleted, renamed, or reordered. The update is
 * computed from the CURRENT record inside a single storage lock acquisition
 * (updateDocumentWith), so this can neither resurrect a deleted document,
 * clobber a concurrent edit with a stale read-modify-write, nor overwrite a
 * name the user typed meanwhile (then `name` no longer equals `defaultName`).
 *
 * The write also runs under the per-document page lock (withDocLock), the one
 * every page edit holds from reading the record to writing it back (rotate,
 * crop, delete, reorder, add pages, mark up). Otherwise the text and the new
 * name could land in the middle of such an edit and be overwritten by the
 * edit's own write, which starts from the record it read before. Never call
 * this from inside withDocLock / runPageEdit for the same document: it would
 * wait for itself.
 */
// Index passes per document, latest last. Only the newest pass may write.
const indexPasses = new Map<string, number>();

export async function indexDocText(id: string, pages: string[]): Promise<void> {
  if (!ocrAvailable()) return;
  const pass = (indexPasses.get(id) ?? 0) + 1;
  indexPasses.set(id, pass);
  const text = await extractDocText(pages);
  if (!text) return;
  await withDocLock(id, () => updateDocumentWith(id, current => {
    // A newer pass was started meanwhile (Undo right after a retake re-indexes
    // the restored page): it read the pages after this one began, so this
    // older text may describe pages that are gone. Leave the write to it.
    if (indexPasses.get(id) !== pass) return null;
    const patch: Partial<Document> = { ocrText: text };
    if (current.defaultName && current.name === current.defaultName) {
      const title = titleFromText(text);
      if (title) {
        patch.name = title;
        patch.defaultName = undefined; // named now; later passes leave it alone
      }
    }
    return patch;
  }));
}
