// lib/recognized-text.ts
//
// Saving the user's corrections to a page's recognized text (the viewer's
// Recognized text sheet lets them fix OCR mistakes, as CamScanner does).
//
// A correction is stored in the page's OCR cache entry (lib/ocr-cache.ts),
// keyed by the page image's identity, so:
//   - the next time the sheet opens on that page it shows the corrected text;
//   - the search index (Document.ocrText, rebuilt by indexDocText from the
//     cache) finds the corrected words;
//   - the searchable PDF's text layer keeps Vision's positioned lines, which a
//     free-text edit can't move — it is never emptied or misplaced;
//   - when the page's pixels change (filter, rotate, crop, mark-up, retake) the
//     page is simply read again, exactly like any other cache entry.
// Nothing new is added to the document record, so older builds and backups
// keep working unchanged.
import { getDocuments } from './storage';
import { pageFileUri } from './image';
import { recognizeLines } from './ocr';
import { writeOcrCorrection } from './ocr-cache';
import { indexDocText } from './save-scan';
import { withDocLock } from './bake';

/** Normalises text typed into the editor: unified line breaks, no trailing whitespace. */
export function normalizeRecognizedText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

/**
 * Stores `text` as the recognized text of page `pageIndex` of `docId` and
 * refreshes the document's search text. Resolves false when it couldn't be
 * saved (document or page gone, disk full). Never rejects.
 */
export async function saveRecognizedText(docId: string, pageIndex: number, text: string): Promise<boolean> {
  try {
    const clean = normalizeRecognizedText(text);
    const saved = await withDocLock(docId, async () => {
      const doc = (await getDocuments()).find(d => d.id === docId);
      if (!doc || doc.pdfUri || pageIndex < 0 || pageIndex >= doc.pages.length) return false;
      const uri = pageFileUri(docId, pageIndex);
      // Makes sure the page's current pixels have an entry (normally a cache
      // hit: the sheet just read it), so the correction keeps Vision's lines.
      await recognizeLines(uri);
      return writeOcrCorrection(uri, clean);
    });
    if (!saved) return false;
    // Outside the lock: indexDocText takes it itself.
    const doc = (await getDocuments()).find(d => d.id === docId);
    if (doc) await indexDocText(docId, doc.pages);
    return true;
  } catch {
    return false;
  }
}
