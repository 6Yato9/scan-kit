// lib/pdf-unrestrict.ts
// "Remove restrictions" (Tools): what an imported PDF's author forbids, in
// plain words, and an unrestricted copy of it, written on the device by
// PDFKit / CoreGraphics (VisionOcr.unrestrictPdf, PdfUnrestrict.swift).
// Pages are never redrawn: text stays selectable, forms, annotations and
// bookmarks are kept. Native reads the copy back and checks it before it
// resolves.
//
// - A PDF that opens without a password but restricts printing, copying,
//   page changes… (an owner password): no password needed.
// - A PDF that needs a password to open: the user types it, and the copy has
//   no password at all.
// - A PDF with nothing to remove (not encrypted, or every permission granted
//   and no password): the screen says so and offers nothing.
//
// The result is either a NEW document "<name> (unrestricted)" in the same
// folder (the default; the original is kept) or the stored PDF replaced in
// place through lib/pdf-edit's crash-safe swap, with Undo. Either way the
// document's own capability checks (Fill & sign, page edits) read the file
// again when they run, so they see the new permissions.
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { VisionOcr, type NativePdfPermissions, type NativePdfPermissionsInfo } from '../modules/vision-ocr/src';
import type { Document } from '../types/document';
import { withDocLock } from './bake';
import { copyPdfToStorage, deleteDocumentFiles } from './files';
import { PdfEditError, rewriteStoredPdf, type PdfEditResult } from './pdf-edit';
import { joinPdfPageTexts } from './pdf-text';
import { deleteDocument, getDocument, saveDocument } from './storage';

// ── What a PDF restricts (pure) ──────────────────────────────────────────────

/** One thing a PDF's permissions forbid, in the order the screen lists them. */
export type Restriction =
  | 'print'
  | 'printQuality'
  | 'copy'
  | 'pages'
  | 'edit'
  | 'comment'
  | 'forms'
  | 'accessibility';

/** What each restriction stops, as the screen says it ("Not allowed: …"). */
export const RESTRICTION_LABELS: Record<Restriction, string> = {
  print: 'Printing',
  printQuality: 'Printing at full quality',
  copy: 'Copying text and images',
  pages: 'Adding, removing or rotating pages',
  edit: 'Changing its content',
  comment: 'Adding comments, text and signatures',
  forms: 'Filling in forms',
  accessibility: 'Reading aloud with VoiceOver',
};

/**
 * The restrictions in `p`. PDFKit reports supersets as granted together
 * (commenting includes filling forms; full-quality printing includes
 * printing), so a forbidden superset is listed only when its subset isn't
 * already: no printing at all says "Printing", not both.
 */
export function restrictionsOf(p: NativePdfPermissions): Restriction[] {
  const out: Restriction[] = [];
  if (!p.printLow) out.push('print');
  else if (!p.printHigh) out.push('printQuality');
  if (!p.copy) out.push('copy');
  if (!p.assemblePages) out.push('pages');
  if (!p.changeContent) out.push('edit');
  if (!p.comment) out.push('comment');
  if (!p.fillForms) out.push('forms');
  if (!p.accessibility) out.push('accessibility');
  return out;
}

/**
 * Where a PDF stands:
 * - 'password': it needs a password to open (what else it restricts can only
 *   be read once it is open); the copy has no password and no restriction.
 * - 'restricted': it opens freely but forbids `restrictions`.
 * - 'unrestricted': nothing to remove.
 */
export type PdfRestrictionState =
  | { kind: 'password'; pageCount: number }
  | { kind: 'restricted'; pageCount: number; restrictions: Restriction[] }
  | { kind: 'unrestricted'; pageCount: number };

export function restrictionStateOf(info: NativePdfPermissionsInfo): PdfRestrictionState {
  const pageCount = info.pageCount;
  if (info.locked) return { kind: 'password', pageCount };
  // Unlocked with a password the user typed: the copy removes that password,
  // even when the PDF restricts nothing else.
  if (info.passwordAccepted) {
    return { kind: 'restricted', pageCount, restrictions: restrictionsOf(info.permissions) };
  }
  if (!info.encrypted) return { kind: 'unrestricted', pageCount };
  const restrictions = restrictionsOf(info.permissions);
  return restrictions.length ? { kind: 'restricted', pageCount, restrictions } : { kind: 'unrestricted', pageCount };
}

/** The new document's name: "Lease" -> "Lease (unrestricted)". */
export function unrestrictedName(name: string): string {
  const base = name.trim() || 'Document';
  return /\(unrestricted\)$/i.test(base) ? base : `${base} (unrestricted)`;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type PdfUnrestrictErrorKind =
  | 'unavailable'
  | 'missing'
  | 'locked'
  | 'wrong-password'
  | 'unreadable'
  | 'changed'
  | 'failed'
  | 'partial';

/** Nothing was changed — except 'partial' (in place only, see lib/pdf-edit). */
export class PdfUnrestrictError extends Error {
  readonly kind: PdfUnrestrictErrorKind;
  constructor(kind: PdfUnrestrictErrorKind, message: string) {
    super(message);
    this.name = 'PdfUnrestrictError';
    this.kind = kind;
  }
}

function classify(err: unknown): PdfUnrestrictError {
  if (err instanceof PdfUnrestrictError) return err;
  if (err instanceof PdfEditError) {
    // rewriteStoredPdf reads "wrong-password" as 'locked'; the password was
    // checked first (passwordOk), so 'locked' here really is a missing one.
    const kind: PdfUnrestrictErrorKind =
      err.kind === 'restricted' || err.kind === 'unavailable' ? 'failed' : err.kind;
    return new PdfUnrestrictError(kind, err.message);
  }
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const code = (err as { code?: string } | null)?.code ?? '';
  if (code === 'ERR_PDF_PASSWORD' || /^wrong-password$/i.test(msg)) return new PdfUnrestrictError('wrong-password', msg);
  if (code === 'ERR_PDF_LOCKED' || /^locked$/i.test(msg)) return new PdfUnrestrictError('locked', msg);
  if (code === 'ERR_PDF_INFO' || /could not open/i.test(msg)) return new PdfUnrestrictError('unreadable', msg);
  return new PdfUnrestrictError('failed', msg);
}

// ── Native ───────────────────────────────────────────────────────────────────

/** True when this build can read and remove PDF restrictions (older builds can't). */
export function canUnrestrictPdf(): boolean {
  return typeof VisionOcr?.pdfPermissions === 'function' && typeof VisionOcr?.unrestrictPdf === 'function';
}

const clean = (uri: string) => uri.split('?')[0];

/** What `doc`'s PDF restricts, opened with `password` when it needs one. Rejects with PdfUnrestrictError. */
export async function readPdfRestrictions(
  doc: Pick<Document, 'pdfUri'>,
  password?: string | null,
): Promise<{ state: PdfRestrictionState; info: NativePdfPermissionsInfo }> {
  const read = VisionOcr?.pdfPermissions;
  if (typeof read !== 'function') throw new PdfUnrestrictError('unavailable', 'pdfPermissions missing');
  if (!doc.pdfUri) throw new PdfUnrestrictError('missing', 'not a PDF document');
  let info: NativePdfPermissionsInfo;
  try {
    info = await read(clean(doc.pdfUri), password ?? null);
  } catch (err) {
    throw classify(err);
  }
  return { state: restrictionStateOf(info), info };
}

/**
 * Checks `password` against `doc`'s PDF before anything is written (an
 * in-place rewrite can't tell a wrong password from a missing one).
 * Resolves to the restrictions it then shows; rejects 'wrong-password'.
 */
export async function checkPdfPassword(doc: Pick<Document, 'pdfUri'>, password: string): Promise<PdfRestrictionState> {
  if (!password) throw new PdfUnrestrictError('wrong-password', 'empty password');
  const { state, info } = await readPdfRestrictions(doc, password);
  if (info.locked) throw new PdfUnrestrictError('wrong-password', 'wrong password');
  return state;
}

async function readText(uri: string): Promise<string | undefined> {
  const read = VisionOcr?.pdfPageTexts;
  if (typeof read !== 'function') return undefined;
  try {
    const pages = await read(clean(uri), null);
    const text = joinPdfPageTexts(Array.isArray(pages) ? pages : []);
    return text || undefined;
  } catch {
    return undefined;
  }
}

/** Caches/pdf-convert is cleared by the startup sweep (lib/files.ts TEMP_DIRS). */
function workFile(): File {
  const dir = new Directory(Paths.cache, 'pdf-convert');
  dir.create({ intermediates: true, idempotent: true });
  return new File(dir, `unrestrict-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.pdf`);
}

function deleteQuietly(file: File | null): void {
  try {
    if (file?.exists) file.delete();
  } catch {}
}

/**
 * Saves an unrestricted copy of `docId`'s PDF as a new document
 * "<name> (unrestricted)" in the same folder; the original is untouched.
 * Resolves with the new record. Rejects with PdfUnrestrictError; nothing is
 * created then.
 */
export async function saveUnrestrictedCopy(docId: string, password?: string | null): Promise<Document> {
  const unrestrict = VisionOcr?.unrestrictPdf;
  if (typeof unrestrict !== 'function') throw new PdfUnrestrictError('unavailable', 'unrestrictPdf missing');
  return withDocLock(docId, async () => {
    const doc = await getDocument(docId);
    if (!doc || doc.trashedAt) throw new PdfUnrestrictError('missing', 'document missing');
    if (!doc.pdfUri || doc.pages.length > 0) throw new PdfUnrestrictError('changed', 'not a PDF document');
    const out = workFile();
    let id: string | null = null;
    try {
      try {
        await unrestrict(clean(doc.pdfUri), out.uri, password ?? null);
      } catch (err) {
        throw classify(err);
      }
      if (!out.exists) throw new PdfUnrestrictError('failed', 'no output');
      const text = await readText(out.uri);
      id = Crypto.randomUUID();
      const now = Date.now();
      const pdfUri = copyPdfToStorage(out.uri, id);
      const copy: Document = {
        id,
        name: unrestrictedName(doc.name),
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
      // Nothing half-made stays.
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
 * Replaces `docId`'s stored PDF with its unrestricted copy, crash-safe with
 * Undo (lib/pdf-edit rewriteStoredPdf). Check a typed password first with
 * checkPdfPassword. Rejects with PdfUnrestrictError, the document unchanged
 * (except 'partial', see lib/pdf-edit).
 */
export async function unrestrictStoredPdf(docId: string, password?: string | null): Promise<PdfEditResult> {
  const unrestrict = VisionOcr?.unrestrictPdf;
  const read = VisionOcr?.pdfPermissions;
  if (typeof unrestrict !== 'function' || typeof read !== 'function') {
    throw new PdfUnrestrictError('unavailable', 'unrestrictPdf missing');
  }
  const doc = await getDocument(docId);
  if (!doc || doc.trashedAt) throw new PdfUnrestrictError('missing', 'document missing');
  if (!doc.pdfUri || doc.pages.length > 0) throw new PdfUnrestrictError('changed', 'not a PDF document');
  let expected: number;
  try {
    const info = await read(clean(doc.pdfUri), password ?? null);
    if (info.locked) throw new PdfUnrestrictError(password ? 'wrong-password' : 'locked', 'locked');
    expected = info.pageCount;
  } catch (err) {
    throw classify(err);
  }
  try {
    return await rewriteStoredPdf(
      docId,
      async (target, out) => (await unrestrict(target, out, password ?? null)).pageCount,
      expected,
    );
  } catch (err) {
    throw classify(err);
  }
}
