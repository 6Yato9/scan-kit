// lib/pdf-flatten.ts
// Flatten PDF (Tools): an imported PDF's form-field values, signatures,
// added text, stamps and comments drawn into its pages, so nobody can change
// or move them and every reader shows them alike. Written on the device by
// the same native flatten as Share's "Flattened PDF" (VisionOcr.pdfFlatten,
// PdfFlattener.swift: pages redrawn as vector, text stays text, links stay
// links, the result read back and checked before it resolves).
//
// Offered for a PDF with something to flatten (lib/pdf-fill
// shouldOfferFlatten: form fields or additions, opens without a password,
// allows commenting and filling, not digitally signed); for any other the
// screen says why there's nothing to do.
//
// The result is a new document "<name> (flattened)" in the same folder (the
// default; the original is kept) or the stored PDF replaced in place through
// lib/pdf-edit's crash-safe swap, with Undo.
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { VisionOcr, type NativePdfInfo } from '../modules/vision-ocr/src';
import type { Document } from '../types/document';
import { withDocLock } from './bake';
import { copyPdfToStorage, deleteDocumentFiles } from './files';
import { PdfEditError, rewriteStoredPdf, type PdfEditResult } from './pdf-edit';
import { canFlattenPdf, flattenPdfCopy, pdfShareInfo, shouldOfferFlatten } from './pdf-fill';
import { joinPdfPageTexts } from './pdf-text';
import { PdfSessionError, readablePdfUri } from './pdf-session';
import { deleteDocument, getDocument, saveDocument } from './storage';
import { copyName } from './copy-undo';

/** The new document's name: "Lease" -> "Lease (flattened)". */
export function flattenedName(name: string): string {
  return copyName(name, 'flattened');
}

/**
 * Where a PDF stands:
 * - 'ready': `formFields` widgets and `annotations` additions to draw in;
 * - 'nothing': no form fields, signatures or comments;
 * - 'locked': it needs a password to open;
 * - 'signed': digitally signed (flattening would break the signature);
 * - 'restricted': its author doesn't allow filling in or commenting.
 */
export type FlattenState =
  | { kind: 'ready'; pageCount: number; formFields: number; annotations: number }
  | { kind: 'nothing' | 'locked' | 'signed' | 'restricted' };

/** The state for a pdfInfo. Pure, for tests. */
export function flattenStateOf(info: NativePdfInfo): FlattenState {
  if (info.locked) return { kind: 'locked' };
  if (info.signed || info.certified) return { kind: 'signed' };
  const formFields = info.formFields ?? 0;
  const annotations = info.annotations ?? 0;
  if (formFields + annotations === 0) return { kind: 'nothing' };
  if (!shouldOfferFlatten(info)) return { kind: 'restricted' };
  return { kind: 'ready', pageCount: info.pageCount, formFields, annotations };
}

/** "3 form fields and 2 additions" (what the screen says will be drawn in). */
export function flattenSummary(formFields: number, annotations: number): string {
  const parts: string[] = [];
  if (formFields > 0) parts.push(formFields === 1 ? '1 form field' : `${formFields} form fields`);
  if (annotations > 0) parts.push(annotations === 1 ? '1 addition' : `${annotations} additions`);
  return parts.join(' and ');
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type PdfFlattenErrorKind = 'unavailable' | 'missing' | 'changed' | 'locked' | 'restricted' | 'unreadable' | 'failed' | 'partial';

/** Nothing was changed — except 'partial' (in place only, see lib/pdf-edit). */
export class PdfFlattenError extends Error {
  readonly kind: PdfFlattenErrorKind;
  constructor(kind: PdfFlattenErrorKind, message: string) {
    super(message);
    this.name = 'PdfFlattenError';
    this.kind = kind;
  }
}

function classify(err: unknown): PdfFlattenError {
  if (err instanceof PdfFlattenError) return err;
  if (err instanceof PdfEditError) return new PdfFlattenError(err.kind, err.message);
  if (err instanceof PdfSessionError) return new PdfFlattenError(err.kind === 'wrong-password' ? 'locked' : err.kind, err.message);
  return new PdfFlattenError('failed', err instanceof Error ? err.message : String(err ?? ''));
}

// ── Native ───────────────────────────────────────────────────────────────────

/** True when this build can flatten PDFs and count what they hold (older builds can't). */
export function canFlattenDocuments(): boolean {
  return canFlattenPdf();
}

const clean = (uri: string) => uri.split('?')[0];

/**
 * Reads `doc`'s state (from its session copy when it is a protected PDF
 * unlocked this session, lib/pdf-session.ts). Rejects with PdfFlattenError
 * ('unreadable').
 */
export async function readFlattenState(doc: Pick<Document, 'id' | 'pdfUri'>): Promise<FlattenState> {
  if (!doc.pdfUri) throw new PdfFlattenError('changed', 'not a PDF document');
  const uri = await readablePdfUri(doc).catch(() => doc.pdfUri as string);
  const info = await pdfShareInfo(uri);
  if (!info) throw new PdfFlattenError('unreadable', 'pdfInfo failed');
  return flattenStateOf(info);
}

async function readText(uri: string): Promise<string | undefined> {
  const read = VisionOcr?.pdfPageTexts;
  if (typeof read !== 'function') return undefined;
  try {
    const pages = await read(clean(uri), null);
    return joinPdfPageTexts(Array.isArray(pages) ? pages : []) || undefined;
  } catch {
    return undefined;
  }
}

/** Caches/pdf-convert is cleared by the startup sweep (lib/files.ts TEMP_DIRS). */
function workFile(): File {
  const dir = new Directory(Paths.cache, 'pdf-convert');
  dir.create({ intermediates: true, idempotent: true });
  return new File(dir, `flatten-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.pdf`);
}

function deleteQuietly(file: File | null): void {
  try {
    if (file?.exists) file.delete();
  } catch {}
}

async function readyState(doc: Document): Promise<Extract<FlattenState, { kind: 'ready' }>> {
  const state = await readFlattenState(doc);
  if (state.kind === 'ready') return state;
  if (state.kind === 'locked' || state.kind === 'restricted') throw new PdfFlattenError(state.kind, state.kind);
  throw new PdfFlattenError('changed', state.kind);
}

/**
 * Saves a flattened copy of `docId`'s PDF as a new document
 * "<name> (flattened)" in the same folder; the original is untouched.
 * Resolves with the new record. Rejects with PdfFlattenError; nothing is
 * created then.
 */
export async function saveFlattenedCopy(docId: string): Promise<Document> {
  if (!canFlattenDocuments()) throw new PdfFlattenError('unavailable', 'pdfFlatten missing');
  return withDocLock(docId, async () => {
    const doc = await getDocument(docId);
    if (!doc || doc.trashedAt) throw new PdfFlattenError('missing', 'document missing');
    if (!doc.pdfUri || doc.pages.length > 0) throw new PdfFlattenError('changed', 'not a PDF document');
    await readyState(doc);
    const out = workFile();
    let id: string | null = null;
    try {
      // Unlocked this session: the flattened copy is made from the decrypted
      // one and needs no password (a new document; the original stays protected).
      await flattenPdfCopy(await readablePdfUri(doc), out.uri);
      if (!out.exists) throw new PdfFlattenError('failed', 'no output');
      const text = await readText(out.uri);
      id = Crypto.randomUUID();
      const now = Date.now();
      const pdfUri = copyPdfToStorage(out.uri, id);
      const copy: Document = {
        id,
        name: flattenedName(doc.name),
        pages: [],
        pdfUri,
        ...(doc.folder ? { folder: doc.folder } : {}),
        createdAt: now,
        updatedAt: now,
        ...(text ? { ocrText: text } : {}),
      };
      await saveDocument(copy);
      return copy;
    } catch (err) {
      if (id) {
        try { await deleteDocument(id); } catch {}
        try { deleteDocumentFiles(id); } catch {}
      }
      throw classify(err);
    } finally {
      deleteQuietly(out);
    }
  });
}

/**
 * Flattens `docId`'s stored PDF in place, crash-safe with Undo (lib/pdf-edit
 * rewriteStoredPdf). Rejects with PdfFlattenError, the document unchanged
 * (except 'partial', see lib/pdf-edit).
 */
export async function flattenStoredPdf(docId: string): Promise<PdfEditResult> {
  const flatten = VisionOcr?.pdfFlatten;
  if (typeof flatten !== 'function' || !canFlattenDocuments()) throw new PdfFlattenError('unavailable', 'pdfFlatten missing');
  const doc = await getDocument(docId);
  if (!doc || doc.trashedAt) throw new PdfFlattenError('missing', 'document missing');
  if (!doc.pdfUri || doc.pages.length > 0) throw new PdfFlattenError('changed', 'not a PDF document');
  try {
    const { pageCount } = await readyState(doc);
    return await rewriteStoredPdf(docId, (source, out) => flatten(source, out), pageCount, { needs: ['comment', 'fillForms'] });
  } catch (err) {
    throw classify(err);
  }
}
