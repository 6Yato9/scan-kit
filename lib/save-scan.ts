// lib/save-scan.ts
import * as Crypto from 'expo-crypto';
import { Document, PageFilter } from '../types/document';
import { saveDocument, patchDocument } from './storage';
import { copyPageWithQuality, copyPdfToStorage, deleteDocumentFiles } from './files';
import { ocrAvailable, extractDocText } from './ocr';

export type SaveScanInput = {
  pages?: string[];
  pdfUri?: string;
  name: string;
  quality: number;
  filters?: (PageFilter | 'original')[];
};

/**
 * Writes a scan to storage and returns the new document id.
 *
 * Pages are copied sequentially so a failure names the offending page and peak
 * memory stays bounded — Promise.all would run every manipulator pass at once.
 * On any failure the partially-written directory is removed so a retry starts clean.
 */
export async function saveScan(input: SaveScanInput): Promise<string> {
  const { pages = [], pdfUri, name, quality, filters } = input;
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
      return id;
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

    const allOriginal = !filters || filters.every(f => f === 'original');
    const doc: Document = {
      id,
      name,
      pages: savedPages,
      filters: allOriginal ? undefined : (filters as PageFilter[]),
      createdAt: now,
      updatedAt: now,
    };
    await saveDocument(doc);
    return id;
  } catch (err) {
    try { deleteDocumentFiles(id); } catch { /* secondary failure — keep the original error */ }
    throw err;
  }
}

/**
 * Fire-and-forget content index so search can match recognised text.
 *
 * OCR is slow and runs after the save already returned, so by the time it lands
 * the document may have been deleted, renamed, or reordered. `patchDocument`
 * merges `ocrText` onto whatever the CURRENT record is inside a single storage
 * lock acquisition, so this can neither resurrect a deleted document nor clobber
 * a concurrent edit with a stale read-modify-write.
 */
export async function indexDocText(id: string, pages: string[]): Promise<void> {
  if (!ocrAvailable()) return;
  const text = await extractDocText(pages);
  if (!text) return;
  await patchDocument(id, { ocrText: text });
}
