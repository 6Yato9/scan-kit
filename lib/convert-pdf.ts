// lib/convert-pdf.ts
//
// "Convert to pages": turns an imported PDF document (one with `pdfUri` and no
// pages) into an ordinary scan document in place, like CamScanner does, so it
// gains everything image pages have — filters, crop, rotate, mark up, sign,
// watermark, text recognition and a searchable PDF export.
//
// Native PDFKit renders every page on white at ~200 dpi, upright (the page's
// /Rotate is respected), into a temp folder under Caches. The pages then go
// through the normal page pipeline: copyPageWithQuality (size cap), the
// default filter bake (which creates each page's `.orig` shadow from the
// rendered pixels) and text indexing (finishAddedPages).
//
// Non-destructive. The stored PDF stays exactly where it is, and the record
// keeps pointing at it, until every page is stored and the record is switched
// over in one write. Any failure before that removes the pages written so far
// and leaves the document as it was. After the switch the PDF is moved to a
// stash in Caches (not deleted) so the conversion can be undone; the startup
// sweep removes stashes nobody used (lib/files.ts TEMP_DIRS).
//
// A password-protected PDF unlocked for this session (lib/pdf-session.ts) is
// rendered from its decrypted copy: its pages then need no password, which
// the screens say before converting. The stashed original (Undo) is the
// stored, still encrypted file.
import { Directory, File, Paths } from 'expo-file-system';
import { docDir } from './storage-layout';
import { VisionOcr } from '../modules/vision-ocr/src';
import { Document, PageFilter } from '../types/document';
import { copyPageWithQuality } from './files';
import { pruneDocumentOcr } from './ocr-cache';
import { getDocument, getScanSettings, updateDocumentWith } from './storage';
import { runPageEdit } from './bake';
import { finishAddedPages } from './add-pages';
import { indexDocText } from './save-scan';
import { MAX_PAGE_EDGE } from './image-size';
import { invalidatePdfThumbs } from './pdf-thumb';
import { forgetSession, readablePdfUri } from './pdf-session';

/** Caches folder for render output and Undo stashes; cleared by the startup sweep. */
export const CONVERT_DIR = 'pdf-convert';

export type ConvertErrorKind = 'locked' | 'unreadable' | 'unavailable' | 'missing' | 'failed';

/** A conversion that didn't happen. The document is unchanged. */
export class PdfConvertError extends Error {
  readonly kind: ConvertErrorKind;
  constructor(kind: ConvertErrorKind, message: string) {
    super(message);
    this.name = 'PdfConvertError';
    this.kind = kind;
  }
}

export type ConvertProgress =
  | { stage: 'rendering' }
  | { stage: 'saving'; done: number; total: number };

export type ConvertUndo = {
  docId: string;
  /** The original PDF, moved out of the document folder. */
  stashUri: string;
  /** The record's pdfUri before conversion (healed on read, so where it lives now). */
  pdfUri: string;
};

export type ConvertResult = { doc: Document; pageCount: number; undo: ConvertUndo | null };

export type ConvertOptions = {
  onProgress?: (p: ConvertProgress) => void;
  /** Filter baked into the new pages; defaults to the user's scan setting. */
  filter?: PageFilter;
};

const clean = (uri: string) => uri.split('?')[0];

/** True when this build can render PDF pages (iOS dev clients built after the rasterizer was added). */
export function canConvertPdf(): boolean {
  return typeof VisionOcr?.renderPdfPages === 'function';
}

/** Maps a native rejection to what the user should be told. */
function classify(err: unknown): PdfConvertError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/password|locked|encrypt/i.test(msg)) return new PdfConvertError('locked', msg);
  if (/could not open|no pages/i.test(msg)) return new PdfConvertError('unreadable', msg);
  return new PdfConvertError('failed', msg);
}

function deleteQuietly(item: File | Directory): void {
  try {
    if (item.exists) item.delete();
  } catch {
    // best effort: the startup sweep clears Caches/pdf-convert
  }
}

/**
 * Removes page files 0…count-1 (and their shadows) of a document that lists no
 * pages: a rolled-back conversion's partial output, or the pages an Undo
 * discards. Then drops the text cached for them.
 */
function removePageFiles(docId: string, count: number): void {
  const dir = docDir(docId);
  for (let i = 0; i < count; i++) {
    deleteQuietly(new File(dir, `page-${i}.jpg`));
    deleteQuietly(new File(dir, `page-${i}.orig.jpg`));
  }
  pruneDocumentOcr(docId);
}

/**
 * Converts `docId`'s PDF into image pages in place. Resolves with the updated
 * document and an Undo token (null if the PDF couldn't be stashed — the
 * conversion still succeeded). Rejects with PdfConvertError, leaving the
 * document untouched.
 */
export async function convertPdfToPages(docId: string, options: ConvertOptions = {}): Promise<ConvertResult> {
  const render = VisionOcr?.renderPdfPages;
  if (typeof render !== 'function') throw new PdfConvertError('unavailable', 'renderPdfPages missing');
  const doc = await getDocument(docId);
  if (!doc) throw new PdfConvertError('missing', 'document missing');
  if (!doc.pdfUri) throw new PdfConvertError('failed', 'not a PDF document');
  let pdfUri: string;
  try {
    pdfUri = clean(await readablePdfUri(doc));
  } catch (err) {
    throw classify(err);
  }

  const stamp = Date.now();
  const tempDir = new Directory(Paths.cache, CONVERT_DIR, `${docId}-${stamp}`);
  try {
    // Slow and reads only the PDF, so it runs before taking the page lock.
    options.onProgress?.({ stage: 'rendering' });
    tempDir.create({ intermediates: true, idempotent: true });
    let rendered: string[];
    try {
      rendered = await render(pdfUri, tempDir.uri, MAX_PAGE_EDGE);
    } catch (err) {
      throw classify(err);
    }
    if (!rendered.length) throw new PdfConvertError('unreadable', 'no pages');

    const filter = options.filter ?? (await getScanSettings().catch(() => null))?.defaultFilter ?? 'original';
    const result = await runPageEdit(docId, {}, async () => {
      const current = await getDocument(docId);
      if (!current) throw new PdfConvertError('missing', 'document missing');
      // Converted meanwhile (a second tap, another screen): nothing to do twice.
      if (!current.pdfUri) throw new PdfConvertError('failed', 'already converted');
      const dir = docDir(docId);
      const stored: string[] = [];
      try {
        for (let i = 0; i < rendered.length; i++) {
          // A page or shadow left here by an interrupted earlier attempt
          // would be taken for this page's unfiltered original by its bake.
          deleteQuietly(new File(dir, `page-${i}.orig.jpg`));
          // Already JPEG (q 0.9, ≤ 200 dpi): stored as-is unless over the size cap,
          // so crisp text isn't recompressed a second time.
          stored.push(await copyPageWithQuality(rendered[i], docId, i, 1));
          options.onProgress?.({ stage: 'saving', done: i + 1, total: rendered.length });
        }
        // One write switches the record over. Only the fields this changes are
        // written, so a rename or folder move made meanwhile survives.
        const patch: Partial<Document> = {
          pages: stored,
          pdfUri: undefined,
          filters: undefined,
          adjustments: undefined,
          updatedAt: Date.now(),
        };
        let next: Document | null = null;
        const written = await updateDocumentWith(docId, latest => {
          if (!latest.pdfUri) return null;
          next = { ...latest, ...patch };
          return patch;
        });
        if (!written || !next) throw new PdfConvertError('missing', 'document missing');
        return { doc: next as Document, pdfUri: clean(current.pdfUri) };
      } catch (err) {
        removePageFiles(docId, rendered.length);
        throw err;
      }
    });

    // The record no longer points at the PDF: move it out of the document
    // folder, keeping it for Undo.
    let undo: ConvertUndo | null = null;
    try {
      const pdf = new File(result.pdfUri);
      if (pdf.exists) {
        const stashDir = new Directory(Paths.cache, CONVERT_DIR, `undo-${docId}-${stamp}`);
        stashDir.create({ intermediates: true, idempotent: true });
        const stash = new File(stashDir, 'document.pdf');
        pdf.move(stash);
        undo = { docId, stashUri: stash.uri, pdfUri: result.pdfUri };
      }
    } catch (err) {
      console.warn('convertPdfToPages: could not stash the PDF', err);
    }
    // Renders of the PDF's pages in Caches go with it (a converted page may
    // be redacted next: no unredacted picture of it may stay behind).
    invalidatePdfThumbs(docId);
    // No longer a PDF: its session (a protected one unlocked) ends, and its
    // decrypted copy goes. An Undo asks for the password again.
    forgetSession(docId);

    finishAddedPages(result.doc, result.doc.pages.map((_, i) => i), filter);
    return { doc: result.doc, pageCount: result.doc.pages.length, undo };
  } catch (err) {
    throw err instanceof PdfConvertError ? err : classify(err);
  } finally {
    deleteQuietly(tempDir);
  }
}

/**
 * Turns a converted document back into the PDF it was. Page edits made since
 * the conversion are discarded with the pages. Single-use: the stash is
 * consumed. Resolves with the restored document.
 */
export async function undoPdfConversion(undo: ConvertUndo): Promise<Document> {
  const { docId } = undo;
  // remap → -1: any filter bake still running on the converted pages is
  // withdrawn instead of writing to a page that no longer exists.
  const restored = await runPageEdit(docId, { remap: () => -1 }, async () => {
    const stash = new File(clean(undo.stashUri));
    if (!stash.exists) throw new PdfConvertError('failed', 'undo stash is gone');
    const current = await getDocument(docId);
    if (!current) throw new PdfConvertError('missing', 'document missing');
    if (current.pdfUri) throw new PdfConvertError('failed', 'already a PDF');
    const dest = new File(undo.pdfUri);
    const dir = docDir(docId);
    dir.create({ intermediates: true, idempotent: true });
    deleteQuietly(dest);
    stash.copy(dest);
    const patch: Partial<Document> = {
      pages: [],
      pdfUri: dest.uri,
      filters: undefined,
      adjustments: undefined,
      updatedAt: Date.now(),
    };
    let next: Document | null = null;
    const written = await updateDocumentWith(docId, latest => {
      next = { ...latest, ...patch };
      return patch;
    });
    if (!written || !next) {
      deleteQuietly(dest);
      throw new PdfConvertError('missing', 'document missing');
    }
    removePageFiles(docId, current.pages.length);
    return next as Document;
  });
  discardConvertUndo(undo);
  // Supersedes the text index the conversion started: its text described
  // pages that are gone (lib/save-scan.ts — only the newest pass writes).
  indexDocText(docId, []).catch(() => {});
  return restored;
}

/** Drops an Undo stash that will no longer be used. Never throws. */
export function discardConvertUndo(undo: ConvertUndo | null | undefined): void {
  if (!undo) return;
  try {
    const dir = new Directory(clean(undo.stashUri).replace(/\/[^/]*$/, ''));
    deleteQuietly(dir);
  } catch {}
}
