// lib/pdf-protect.ts
// Protect PDF (Tools): a password to open, added on the device (PDFKit, AES:
// VisionOcr.protectPdf, PdfProtector.swift, which reads the result back and
// checks that it is locked and opens with the password).
//
// - A scanned document is first made into the PDF Share makes of it (the
//   same build as the export sheet: buildScanPdf, which the export sheet
//   uses too), then protected. The result is always a NEW document; the scan
//   is kept.
// - An imported PDF is protected as it is (text, pages, links kept). The
//   result is a new document "<name> (protected)" in the same folder (the
//   default) or the stored PDF replaced in place through lib/pdf-edit's
//   crash-safe swap, with Undo.
// - A PDF that already needs a password isn't offered (Unlock PDF removes it).
//
// Scan Kit never keeps the password: it is passed to native once and
// dropped. A forgotten password can't be recovered — the screen says so.
// A protected PDF has no recognised text in the search index (its text is
// what the password protects), and it stays that way: the viewer's "Enter
// password" opens it for the session only (lib/pdf-session.ts), and the stored
// file stays encrypted through every later edit.
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { VisionOcr } from '../modules/vision-ocr/src';
import type { Document } from '../types/document';
import {
  canProtectPdf,
  generatePdf,
  MIN_PDF_PASSWORD,
  PdfCancelledError,
  protectPdf,
  type GeneratePdfOptions,
  type PageNumberStyle,
  type PageSize,
  type PdfQuality,
} from './pdf';
import { getExportLayout, getExportPageNumbers, type ExportLayout } from './export-prefs';
import { ocrAvailable } from './ocr';
import { BakeWaitAborted, waitForPendingBakes, withDocLock } from './bake';
import { copyPdfToStorage, deleteDocumentFiles } from './files';
import { PdfEditError, rewriteStoredPdf, type PdfEditResult } from './pdf-edit';
import { deleteDocument, getDocSettings, getDocument, saveDocument } from './storage';
import { copyName } from './copy-undo';

export { MIN_PDF_PASSWORD };

/** The new document's name: "Lease" -> "Lease (protected)". */
export function protectedName(name: string): string {
  return copyName(name, 'protected');
}

// ── Password strength (pure) ─────────────────────────────────────────────────

export type PasswordStrength = 'short' | 'weak' | 'fair' | 'strong';

/** Passwords people reach for first: always weak, whatever their length. */
const COMMON = new Set([
  'password', 'passw0rd', 'password1', 'qwerty', 'qwertyuiop', 'azerty', 'letmein', 'welcome', 'admin',
  'iloveyou', 'monkey', 'dragon', 'abc123', 'secret', 'changeme', 'football', 'baseball', 'sunshine',
]);

/** "aaaa", "1234", "abcd", "4321": one character repeated, or a straight run. */
function isRun(pw: string): boolean {
  if (pw.length < 2) return true;
  const codes = [...pw.toLowerCase()].map(c => c.charCodeAt(0));
  const step = codes[1] - codes[0];
  if (Math.abs(step) > 1) return false;
  return codes.every((c, i) => i === 0 || c - codes[i - 1] === step);
}

/**
 * A rough strength, for a hint (never a rule): length matters most, a mix of
 * kinds of character helps, and the obvious picks are weak. No rule beyond
 * MIN_PDF_PASSWORD characters is enforced — a long phrase of plain words is
 * a good password.
 */
export function passwordStrength(pw: string): PasswordStrength {
  if (pw.length < MIN_PDF_PASSWORD) return 'short';
  const plain = pw.toLowerCase().replace(/[\s\d!.]+$/, '');
  if (COMMON.has(pw.toLowerCase()) || COMMON.has(plain) || isRun(pw)) return 'weak';
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z\d]/].filter(r => r.test(pw)).length;
  const unique = new Set(pw).size;
  if (unique <= 2) return 'weak';
  if (pw.length >= 14 || (pw.length >= 10 && kinds >= 2)) return 'strong';
  if (pw.length >= 10 || (pw.length >= 8 && kinds >= 2)) return 'fair';
  return 'weak';
}

/** The line under the password fields. */
export function passwordHint(strength: PasswordStrength): string {
  switch (strength) {
    case 'short':
      return `Use at least ${MIN_PDF_PASSWORD} characters.`;
    case 'weak':
      return 'Weak: easy to guess. A longer password is safer — a few unrelated words work well.';
    case 'fair':
      return 'Fair. A few more characters make it much harder to guess.';
    case 'strong':
      return 'Strong password.';
  }
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type PdfProtectToolErrorKind =
  | 'unavailable'
  | 'missing'
  | 'changed'
  | 'has-password'
  | 'unreadable'
  | 'cancelled'
  | 'failed'
  | 'partial';

/** Nothing was changed — except 'partial' (in place only, see lib/pdf-edit). */
export class PdfProtectToolError extends Error {
  readonly kind: PdfProtectToolErrorKind;
  constructor(kind: PdfProtectToolErrorKind, message: string) {
    super(message);
    this.name = 'PdfProtectToolError';
    this.kind = kind;
  }
}

function classify(err: unknown): PdfProtectToolError {
  if (err instanceof PdfProtectToolError) return err;
  if (err instanceof PdfCancelledError || err instanceof BakeWaitAborted) return new PdfProtectToolError('cancelled', 'cancelled');
  if (err instanceof PdfEditError) {
    const kind: PdfProtectToolErrorKind =
      err.kind === 'locked' ? 'has-password'
        : err.kind === 'missing' || err.kind === 'changed' || err.kind === 'unreadable' || err.kind === 'partial' ? err.kind
          : 'failed';
    return new PdfProtectToolError(kind, err.message);
  }
  return new PdfProtectToolError('failed', err instanceof Error ? err.message : String(err ?? ''));
}

// ── What can be protected ────────────────────────────────────────────────────

/** True when this build can protect PDFs and read them (older builds can't). */
export function canProtectDocuments(): boolean {
  return canProtectPdf() && typeof VisionOcr?.pdfInfo === 'function';
}

/** Documents Protect PDF lists: imported PDFs and scans with pages. */
export const isProtectableDoc = (d: Pick<Document, 'pdfUri' | 'pages'>) => !!d.pdfUri || d.pages.length > 0;

/**
 * Where a document stands:
 * - 'scan': a scanned document; made into a PDF first, saved as a new one.
 * - 'pdf': an imported PDF that opens freely (`signed`: its digital
 *   signature won't be valid in the protected file).
 * - 'has-password': it already needs a password to open.
 */
export type ProtectState =
  | { kind: 'scan'; pageCount: number }
  | { kind: 'pdf'; pageCount: number; signed: boolean }
  | { kind: 'has-password' };

const clean = (uri: string) => uri.split('?')[0];

/** Reads `doc`'s state. Rejects with PdfProtectToolError ('unreadable', 'unavailable'). */
export async function readProtectState(doc: Pick<Document, 'pdfUri' | 'pages'>): Promise<ProtectState> {
  if (!doc.pdfUri) return { kind: 'scan', pageCount: doc.pages.length };
  const read = VisionOcr?.pdfInfo;
  if (typeof read !== 'function') throw new PdfProtectToolError('unavailable', 'pdfInfo missing');
  let info;
  try {
    info = await read(clean(doc.pdfUri), null);
  } catch (err) {
    throw new PdfProtectToolError('unreadable', err instanceof Error ? err.message : 'unreadable');
  }
  if (info.locked) return { kind: 'has-password' };
  if (info.pageCount < 1) throw new PdfProtectToolError('unreadable', 'no pages');
  return { kind: 'pdf', pageCount: info.pageCount, signed: !!(info.signed || info.certified) };
}

// ── Building (shared with the export sheet) ──────────────────────────────────

/**
 * The PDF Share makes of a scanned document's `pages` (the export sheet's
 * build, and Protect PDF's): Document settings' paper size read fresh unless
 * the PDF options chose another, the export page numbers, standard quality
 * unless told otherwise, and a text layer only when `searchable` and the PDF
 * options' "Searchable text" are both on. Resolves to a temporary file the
 * caller deletes. Rejects PdfCancelledError on `signal`.
 */
export async function buildScanPdf(
  pages: string[],
  opts: {
    searchable: boolean;
    quality?: PdfQuality;
    /** The export sheet's own choice; read from the export prefs when absent. */
    pageNumbers?: PageNumberStyle;
    /**
     * The export sheet's PDF options (paper, orientation, margins, number
     * position); read from the export prefs when absent, so Protect PDF makes
     * the same PDF Share does. A `paper` of null follows Document settings.
     * Its `quality` applies only when `quality` isn't given.
     */
    layout?: ExportLayout;
    /** When Document settings can't be read. */
    fallbackPageSize?: PageSize;
    /** Longest image edge, px, below the quality's own (the export sheet's Smaller PDF). */
    maxEdge?: number;
    signal?: AbortSignal;
    onProgress?: GeneratePdfOptions['onProgress'];
  },
): Promise<string> {
  // Read settings fresh so a change made a moment ago is honoured.
  const settings = await getDocSettings().catch(() => null);
  const pageNumbers = opts.pageNumbers ?? (await getExportPageNumbers());
  const layout = opts.layout ?? (await getExportLayout());
  return generatePdf(pages, {
    pageSize: layout.paper ?? settings?.pdfPageSize ?? opts.fallbackPageSize ?? 'A4',
    quality: opts.quality ?? layout.quality,
    // The PDF options' "Searchable text: Off" holds for every PDF made from them (Share, Print, Protect PDF).
    searchable: opts.searchable && layout.searchable,
    maxEdge: opts.maxEdge,
    pageNumbers,
    pageNumberPosition: layout.numberPosition,
    orientation: layout.orientation,
    margin: layout.margin,
    signal: opts.signal,
    onProgress: opts.onProgress,
  });
}

/**
 * Writes `doc` as a password-protected PDF at `out` (the export sheet's
 * "Password-protected PDF" and Protect PDF): an imported PDF as it is; a scan
 * through `build` first (its unprotected temp file is deleted straight away,
 * whatever happens). `beforeProtect` runs between the two (progress).
 * Resolves to `out`'s URI. Rejects lib/pdf's PdfProtectError, or `build`'s.
 */
export async function protectDocumentPdf(
  doc: Pick<Document, 'pdfUri'>,
  out: string,
  password: string,
  { build, beforeProtect, signal }: { build: () => Promise<string>; beforeProtect?: () => void; signal?: AbortSignal },
): Promise<string> {
  let raw: string | null = null;
  try {
    if (!doc.pdfUri) raw = await build();
    if (signal?.aborted) throw new PdfCancelledError();
    beforeProtect?.();
    return await protectPdf(raw ?? doc.pdfUri!, out, password);
  } finally {
    if (raw) {
      try {
        const f = new File(clean(raw));
        if (f.exists) f.delete();
      } catch {}
    }
  }
}

// ── Saving ───────────────────────────────────────────────────────────────────

/** Caches/pdf-convert is cleared by the startup sweep (lib/files.ts TEMP_DIRS). */
function workFile(): File {
  const dir = new Directory(Paths.cache, 'pdf-convert');
  dir.create({ intermediates: true, idempotent: true });
  return new File(dir, `protect-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.pdf`);
}

function deleteQuietly(file: File | null): void {
  try {
    if (file?.exists) file.delete();
  } catch {}
}

/**
 * The page count of the protected file at `uri`, opened with `password`
 * (PdfProtector already checked it is locked and opens with it); -1 when it
 * can't be read, which the callers refuse.
 */
async function protectedPageCount(uri: string, password: string): Promise<number> {
  const read = VisionOcr?.pdfInfo;
  if (typeof read !== 'function') return -1;
  try {
    const info = await read(clean(uri), password);
    return info.locked ? -1 : info.pageCount;
  } catch {
    return -1;
  }
}

export type ProtectProgress = { phase: 'enhancing' | 'building' | 'protecting'; done: number; total: number };

/**
 * Saves a password-protected copy of `docId` (a scan or an imported PDF) as a
 * new PDF document "<name> (protected)" in the same folder; the original is
 * untouched. Resolves with the new record. Rejects with PdfProtectToolError;
 * nothing is created then.
 */
export async function saveProtectedCopy(
  docId: string,
  password: string,
  opts: { signal?: AbortSignal; onProgress?: (p: ProtectProgress) => void } = {},
): Promise<Document> {
  if (!canProtectDocuments()) throw new PdfProtectToolError('unavailable', 'protectPdf missing');
  if (password.length < MIN_PDF_PASSWORD) throw new PdfProtectToolError('failed', 'password too short');
  const { signal, onProgress } = opts;
  const first = await getDocument(docId);
  if (!first || first.trashedAt) throw new PdfProtectToolError('missing', 'document missing');
  try {
    // A scan saved a moment ago may still be getting its default filter
    // (lib/bake.ts): protect the enhanced pages, as Share would.
    if (!first.pdfUri) {
      onProgress?.({ phase: 'enhancing', done: 0, total: 1 });
      await waitForPendingBakes(docId, { signal });
    }
  } catch (err) {
    throw classify(err);
  }
  return withDocLock(docId, async () => {
    const doc = await getDocument(docId);
    if (!doc || doc.trashedAt) throw new PdfProtectToolError('missing', 'document missing');
    if (!doc.pdfUri && doc.pages.length === 0) throw new PdfProtectToolError('changed', 'no pages');
    const state = await readProtectState(doc);
    if (state.kind === 'has-password') throw new PdfProtectToolError('has-password', 'already protected');
    const expected = state.pageCount;
    const out = workFile();
    let id: string | null = null;
    try {
      await protectDocumentPdf(doc, out.uri, password, {
        signal,
        build: () =>
          buildScanPdf(doc.pages, {
            searchable: ocrAvailable(),
            signal,
            onProgress: (done, total) => onProgress?.({ phase: 'building', done, total }),
          }),
        beforeProtect: () => onProgress?.({ phase: 'protecting', done: 1, total: 1 }),
      });
      if (!out.exists) throw new PdfProtectToolError('failed', 'no output');
      // Every page there, behind the password.
      if ((await protectedPageCount(out.uri, password)) !== expected) throw new PdfProtectToolError('failed', 'not verified');
      id = Crypto.randomUUID();
      const now = Date.now();
      const pdfUri = copyPdfToStorage(out.uri, id);
      const copy: Document = {
        id,
        name: protectedName(doc.name),
        pages: [],
        pdfUri,
        ...(doc.folder ? { folder: doc.folder } : {}),
        createdAt: now,
        updatedAt: now,
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
 * Adds the password to `docId`'s stored PDF in place, crash-safe with Undo
 * (lib/pdf-edit rewriteStoredPdf: Undo puts the unprotected PDF and its
 * search text back). Imported PDFs only. Rejects with PdfProtectToolError,
 * the document unchanged (except 'partial', see lib/pdf-edit).
 */
export async function protectStoredPdf(docId: string, password: string): Promise<PdfEditResult> {
  if (!canProtectDocuments()) throw new PdfProtectToolError('unavailable', 'protectPdf missing');
  if (password.length < MIN_PDF_PASSWORD) throw new PdfProtectToolError('failed', 'password too short');
  const doc = await getDocument(docId);
  if (!doc || doc.trashedAt) throw new PdfProtectToolError('missing', 'document missing');
  if (!doc.pdfUri || doc.pages.length > 0) throw new PdfProtectToolError('changed', 'not a PDF document');
  const state = await readProtectState(doc);
  if (state.kind === 'has-password') throw new PdfProtectToolError('has-password', 'already protected');
  if (state.kind !== 'pdf') throw new PdfProtectToolError('changed', 'not a PDF document');
  try {
    return await rewriteStoredPdf(
      docId,
      async (target, out) => {
        await protectPdf(target, out, password);
        return protectedPageCount(out, password);
      },
      state.pageCount,
    );
  } catch (err) {
    throw classify(err);
  }
}
