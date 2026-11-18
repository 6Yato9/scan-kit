// lib/pdf-text.ts
// Search for imported PDFs. A PDF made by a word processor, a bank or another
// scanner app usually carries its text; PDFKit reads it (VisionOcr.pdfPageTexts)
// in a fraction of a second, so it goes into the document's `ocrText` like a
// scan's recognised text and search finds the PDF by its words. A PDF that is
// only pictures of pages has no text: nothing is stored, and Convert to pages
// (which runs text recognition on the pages) is how it becomes searchable.
import { VisionOcr } from '../modules/vision-ocr/src';
import { withDocLock } from './bake';
import { getDocument, updateDocumentWith } from './storage';

/**
 * Text kept per document is capped: the record is read whole by every list
 * and search, and ~200k characters (well over a hundred dense pages) is plenty
 * to find a document by.
 */
export const PDF_TEXT_MAX_CHARS = 200_000;

export function pdfTextAvailable(): boolean {
  return typeof VisionOcr?.pdfPageTexts === 'function';
}

/** Joins per-page text the way extractDocText joins pages (blank line between), tidied and capped. */
export function joinPdfPageTexts(pages: string[]): string {
  const text = pages
    .map(p => (p ?? '').replace(/\r\n?/g, '\n').replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim())
    .join('\n\n');
  if (!text.trim()) return '';
  return text.length > PDF_TEXT_MAX_CHARS ? text.slice(0, PDF_TEXT_MAX_CHARS) : text;
}

export type PdfIndexOutcome = 'indexed' | 'no-text' | 'locked' | 'unavailable' | 'skipped';

// One pass per document at a time; a PDF that turned out to have no text (or
// is locked) isn't read again on every open in this session.
const running = new Map<string, Promise<PdfIndexOutcome>>();
const settled = new Map<string, PdfIndexOutcome>();
// Bumped whenever a document's PDF is replaced in place (page edits,
// lib/pdf-edit.ts: same path, new bytes). A pass that read the text before
// that doesn't write it: it describes pages that may be gone.
const generations = new Map<string, number>();

/** Marks document `docId`'s PDF as replaced (see above). */
export function bumpPdfTextGeneration(docId: string): void {
  generations.set(docId, (generations.get(docId) ?? 0) + 1);
}

/**
 * Reads the embedded text of document `docId`'s PDF into its `ocrText`.
 * Fire-and-forget safe: never rejects. The write happens only if the record
 * still points at the same PDF (not converted, replaced or deleted meanwhile),
 * under the page lock like every other background write to a document.
 * `force` reads again even if this session already tried (after an unlock).
 */
export function indexPdfText(docId: string, options: { force?: boolean } = {}): Promise<PdfIndexOutcome> {
  const busy = running.get(docId);
  if (busy) return busy;
  const run = (async (): Promise<PdfIndexOutcome> => {
    const read = VisionOcr?.pdfPageTexts;
    if (typeof read !== 'function') return 'unavailable';
    const doc = await getDocument(docId);
    if (!doc?.pdfUri) return 'skipped';
    const key = `${docId}|${doc.pdfUri}|${doc.updatedAt}`;
    if (!options.force && settled.has(key)) return 'skipped';
    const generation = generations.get(docId) ?? 0;
    let pages: string[];
    try {
      pages = await read(doc.pdfUri.split('?')[0], null);
    } catch (err) {
      const locked = /locked/i.test(err instanceof Error ? err.message : String(err));
      settled.set(key, locked ? 'locked' : 'no-text');
      return locked ? 'locked' : 'no-text';
    }
    const text = joinPdfPageTexts(Array.isArray(pages) ? pages : []);
    const pdfUri = doc.pdfUri;
    let outcome: PdfIndexOutcome = text ? 'indexed' : 'no-text';
    await withDocLock(docId, () =>
      updateDocumentWith(docId, current => {
        if (current.pdfUri !== pdfUri || current.pages.length > 0 || (generations.get(docId) ?? 0) !== generation) {
          outcome = 'skipped';
          return null;
        }
        if (!text) return null; // an image-only PDF: nothing to find it by
        return current.ocrText === text ? null : { ocrText: text };
      }),
    );
    settled.set(key, outcome);
    return outcome;
  })()
    .catch(err => {
      console.warn('PDF text indexing failed', err);
      return 'unavailable' as const;
    })
    .finally(() => running.delete(docId));
  running.set(docId, run);
  return run;
}

/** True when this PDF document has no text index yet and one is worth trying. */
export function needsPdfText(doc: { pdfUri?: string; pages: string[]; ocrText?: string } | null | undefined): boolean {
  return !!doc?.pdfUri && doc.pages.length === 0 && !doc.ocrText && pdfTextAvailable();
}

export function resetPdfTextForTests(): void {
  running.clear();
  settled.clear();
  generations.clear();
}
