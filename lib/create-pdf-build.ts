// lib/create-pdf-build.ts
// Create PDF, the part that touches files: making the new document from the
// page list (lib/create-pdf.ts explains what is made and why), the session's
// temp folder, and the draft kept for Undo.
//
// Bounded memory: pages are handled one at a time (copied, turned, rendered in
// lib/pdf.ts's short runs); PDFKit moves PDF pages without drawing them. Every
// step checks the AbortSignal, so Cancel stops between pages; whatever was
// written so far (the new document's folder, the work folder) is removed.
//
// Nothing of the originals is written. Their pages are read under their page
// lock and must still be exactly what the user chose (same file, same bytes);
// otherwise the build stops with kind 'changed' and names the document.
//
// Temp files live in Caches/create-pdf (staged Files PDFs, their thumbnails,
// build work folders) and Caches/page-source (prepared photos) — both swept at
// launch (lib/files.ts TEMP_DIRS) — and are deleted as soon as nothing needs
// them: an item removed, the screen closed, or the Undo window over.
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { VisionOcr } from '../modules/vision-ocr/src';
import type { Document, PageAdjustment, PageFilter } from '../types/document';
import { withDocLock } from './bake';
import { copyPageWithQuality, copyPageWithShadow, copyPdfToStorage, deleteDisposableTemps, deleteDocumentFiles } from './files';
import { rotatePage } from './image';
import { installPreparedSource } from './page-source';
import type { PageGeometry } from './quad';
import { fileIdentity } from './ocr-cache';
import { filePrint, samePrint } from './pdf-edit';
import { joinPdfPageTexts } from './pdf-text';
import { isSessionPath, isSessionUnlocked, readablePdfUri } from './pdf-session';
import { generatePdf, PdfCancelledError } from './pdf';
import { ocrAvailable } from './ocr';
import { getDocSettings, getDocument, saveDocument } from './storage';
import { indexDocText } from './save-scan';
import {
  planPdf,
  progressTotal,
  resultKind,
  type CreateItem,
  type CreateProgress,
  type ImageItem,
  type PdfSource,
  type ScanItem,
} from './create-pdf';

// ── Availability ─────────────────────────────────────────────────────────────

/** True when this build can combine and arrange PDF pages (needed for PDF sources). */
export function canCreateFromPdfs(): boolean {
  return typeof VisionOcr?.mergePdfs === 'function' && typeof VisionOcr?.pdfEditPages === 'function';
}

/** True when this build can draw PDF page thumbnails for the list. */
export function canRenderPdfThumbs(): boolean {
  return typeof VisionOcr?.renderPdfPages === 'function';
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type CreatePdfErrorKind = 'cancelled' | 'changed' | 'locked' | 'restricted' | 'unavailable' | 'failed';

/** The document wasn't made (nothing was left behind). `name`: the source it is about. */
export class CreatePdfError extends Error {
  constructor(readonly kind: CreatePdfErrorKind, message: string, readonly sourceName?: string) {
    super(message);
    this.name = 'CreatePdfError';
  }
}

function classify(err: unknown, sourceName?: string): CreatePdfError {
  if (err instanceof CreatePdfError) return err;
  if (err instanceof PdfCancelledError) return new CreatePdfError('cancelled', 'cancelled');
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const code = (err as { code?: string } | null)?.code ?? '';
  if (code === 'ERR_PDF_RESTRICTED' || /^restricted$/i.test(msg)) return new CreatePdfError('restricted', msg, sourceName);
  if (code === 'ERR_PDF_LOCKED' || /^locked$/i.test(msg)) return new CreatePdfError('locked', msg, sourceName);
  return new CreatePdfError('failed', msg, sourceName);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CreatePdfError('cancelled', 'cancelled');
}

// ── Temp files ───────────────────────────────────────────────────────────────

const clean = (uri: string) => uri.split('?')[0];
/** Caches/create-pdf (in lib/files.ts TEMP_DIRS: swept at launch). */
export const CREATE_PDF_DIR = 'create-pdf';
let seq = 0;

export function createTempDir(prefix: string): Directory {
  seq += 1;
  const dir = new Directory(Paths.cache, CREATE_PDF_DIR, `${prefix}-${Date.now().toString(36)}-${seq}`);
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

export function deleteQuietly(uri: string | null | undefined): void {
  if (!uri) return;
  try {
    const f = new File(clean(uri));
    if (f.exists) {
      f.delete();
      return;
    }
  } catch {}
  try {
    const d = new Directory(clean(uri));
    if (d.exists) d.delete();
  } catch {}
}

/**
 * Deletes what an item alone owns (a photo's prepared page and source, the
 * picker's copy). Only temp files (lib/files isDisposableTemp) are ever deleted.
 */
export function discardItem(item: CreateItem): void {
  if (item.kind === 'image') deleteDisposableTemps(item.temps);
}

/** Deletes a source's staged copy and thumbnails (only for files we staged). */
export function discardSource(source: PdfSource & { tempDir?: string }): void {
  if (source.staged && source.tempDir) deleteQuietly(source.tempDir);
}

// ── The draft kept for Undo ──────────────────────────────────────────────────
//
// After Create, the screen is replaced by the viewer. Undo there removes the
// new document and reopens Create PDF with the same list (the order or the
// choice was usually what was wrong), so the list and its temp files outlive
// the screen until the Undo can no longer be used (viewer notice onExpire).

export type CreateDraft = { items: CreateItem[]; sources: (PdfSource & { tempDir?: string })[]; name: string };
let draft: CreateDraft | null = null;

/** Keeps `d` for the next Create PDF screen (a previous draft is discarded). */
export function stashDraft(d: CreateDraft): void {
  if (draft && draft !== d) discardDraftFiles(draft);
  draft = d;
}

/** The kept draft, left in place (render-safe; take it once mounted). */
export function peekDraft(): CreateDraft | null {
  return draft;
}

/** Takes the kept draft (the caller now owns its files), or null. */
export function takeDraft(): CreateDraft | null {
  const d = draft;
  draft = null;
  return d;
}

/** Drops the kept draft `d` (if it is still the kept one) and deletes its files. */
export function discardDraft(d?: CreateDraft | null): void {
  if (!draft || (d && d !== draft)) return;
  discardDraftFiles(draft);
  draft = null;
}

function discardDraftFiles(d: CreateDraft): void {
  d.items.forEach(discardItem);
  d.sources.forEach(discardSource);
}

// ── Building ─────────────────────────────────────────────────────────────────

export type BuildOptions = {
  signal?: AbortSignal;
  onProgress?: (p: CreateProgress) => void;
};

export type BuildResult = { doc: Document; kind: 'pdf' | 'scan' };

/**
 * Makes ONE new document of `items` named `name` (a PDF when any page is a
 * PDF page, else a scanned document — see lib/create-pdf.ts). `isDefaultName`:
 * the automatic name, which text recognition may later replace with a title.
 * Rejects with CreatePdfError; nothing is left behind then.
 */
export async function buildDocument(
  items: CreateItem[],
  sources: PdfSource[],
  name: string,
  isDefaultName: boolean,
  options: BuildOptions = {},
): Promise<BuildResult> {
  if (items.length === 0) throw new CreatePdfError('failed', 'no pages');
  try {
    if (resultKind(items) === 'scan') return { doc: await buildScanned(items, name, isDefaultName, options), kind: 'scan' };
    return { doc: await buildPdf(items, sources, name, options), kind: 'pdf' };
  } catch (err) {
    throw classify(err);
  }
}

const DEFAULT_ADJ: PageAdjustment = { brightness: 0, contrast: 0, saturation: 0 };

/** Turns stored page `i` of `docId` clockwise by `turn` (its .orig and source geometry follow, lib/image.ts). */
async function turnStoredPage(uri: string, docId: string, i: number, turn: number): Promise<string> {
  if (turn === 270) return rotatePage(uri, 'ccw', docId, i);
  let out = uri;
  for (let k = 0; k < turn / 90; k++) out = await rotatePage(out, 'cw', docId, i);
  return out;
}

/**
 * Reads page `item.index` of its document under that document's page lock,
 * checks it is still the page the user chose, and hands it to `use` (still
 * under the lock) with its filter and adjustment.
 */
async function withChosenPage<T>(
  item: ScanItem,
  use: (uri: string, filter: PageFilter, adjustment: PageAdjustment) => Promise<T> | T,
): Promise<T> {
  return withDocLock(item.docId, async () => {
    const fresh = await getDocument(item.docId);
    const cur = fresh && !fresh.trashedAt && !fresh.pdfUri ? fresh.pages[item.index] : undefined;
    const same =
      !!cur &&
      clean(cur) === clean(item.uri) &&
      (!item.identity || fileIdentity(clean(cur)) === item.identity);
    if (!fresh || !cur || !same) throw new CreatePdfError('changed', 'page changed', item.docName);
    return use(cur, fresh.filters?.[item.index] ?? 'original', fresh.adjustments?.[item.index] ?? { ...DEFAULT_ADJ });
  });
}

async function buildScanned(items: CreateItem[], name: string, isDefaultName: boolean, options: BuildOptions): Promise<Document> {
  const { signal, onProgress } = options;
  const total = progressTotal(items);
  const id = Crypto.randomUUID();
  const pages: string[] = [];
  const filters: PageFilter[] = [];
  const adjustments: PageAdjustment[] = [];
  const work = createTempDir('scan');
  try {
    for (let i = 0; i < items.length; i++) {
      throwIfAborted(signal);
      const it = items[i];
      let stored: string;
      if (it.kind === 'image') {
        // Prepared at the user's scan quality when it was added: stored as it is.
        stored = await copyPageWithQuality(it.page, id, i, 1);
        if (it.source && it.geometry) {
          // A copy of the photo: the item keeps its own, for Undo's draft.
          const copy = new File(work, `src-${i}.jpg`);
          new File(clean(it.source)).copy(copy);
          installPreparedSource({ page: stored, source: copy.uri, geometry: it.geometry as PageGeometry }, id, i);
        }
        filters.push('original');
        adjustments.push({ ...DEFAULT_ADJ });
      } else if (it.kind === 'scan') {
        // With its shadows (.orig, source photo and crop), filter and adjustment.
        stored = await withChosenPage(it, (uri, filter, adjustment) => {
          filters.push(filter);
          adjustments.push({ ...adjustment });
          return copyPageWithShadow(uri, id, i);
        });
      } else {
        throw new CreatePdfError('failed', 'PDF page in a scanned document');
      }
      if (it.turn) stored = await turnStoredPage(stored, id, i, it.turn);
      pages.push(stored);
      onProgress?.({ done: i + 1, total });
    }
    throwIfAborted(signal);
    const now = Date.now();
    const doc: Document = {
      id,
      name,
      pages,
      ...(filters.some(f => f !== 'original') ? { filters } : {}),
      ...(adjustments.some(a => a.brightness || a.contrast || a.saturation || a.sharpness) ? { adjustments } : {}),
      createdAt: now,
      updatedAt: now,
      ...(isDefaultName ? { defaultName: name } : {}),
    };
    await saveDocument(doc);
    onProgress?.({ done: total, total });
    // Searchable like any new document (the copies keep their identity, so
    // the OCR cache usually answers without reading them again).
    indexDocText(doc.id, doc.pages).catch(err => console.warn('Index created document failed', err));
    return doc;
  } catch (err) {
    try { deleteDocumentFiles(id); } catch {}
    throw err;
  } finally {
    deleteQuietly(work.uri);
  }
}

type PdfNative = {
  mergePdfs: (inputUris: string[], outputUri: string) => Promise<string>;
  pdfEditPages: (i: string, o: string, s: number[], r: number[], p?: string | null) => Promise<number>;
  pdfInfo?: (uri: string, password?: string | null) => Promise<{ pageCount: number; locked: boolean; restricted?: boolean }>;
};

/**
 * Checks a PDF source can be read as it was when its pages were chosen. A
 * protected document's pages come from its session copy (lib/pdf-session.ts):
 * it must still be the live copy of the stored bytes, and the session must
 * not have ended meanwhile ('locked': open it and enter the password again).
 */
async function checkSource(src: PdfSource, info: PdfNative['pdfInfo']): Promise<void> {
  if (src.docId) {
    const fresh = await getDocument(src.docId);
    if (!fresh || fresh.trashedAt || !fresh.pdfUri) throw new CreatePdfError('changed', 'document changed', src.name);
    if (isSessionPath(src.uri) && !isSessionUnlocked(src.docId)) throw new CreatePdfError('locked', 'locked', src.name);
    const readable = await readablePdfUri(fresh).catch(() => fresh.pdfUri as string);
    if (clean(readable) !== clean(src.uri)) {
      throw new CreatePdfError('changed', 'document changed', src.name);
    }
    if (src.print && !samePrint(filePrint(src.uri), src.print)) throw new CreatePdfError('changed', 'PDF changed', src.name);
  }
  if (!new File(clean(src.uri)).exists) throw new CreatePdfError('changed', 'PDF missing', src.name);
  if (typeof info !== 'function') return;
  let i: { pageCount: number; locked: boolean; restricted?: boolean };
  try {
    i = await info(clean(src.uri), null);
  } catch (err) {
    throw classify(err, src.name);
  }
  if (i.locked) throw new CreatePdfError('locked', 'locked', src.name);
  if (i.restricted) throw new CreatePdfError('restricted', 'restricted', src.name);
  if (i.pageCount !== src.pageCount) throw new CreatePdfError('changed', 'page count changed', src.name);
}

async function readText(uri: string): Promise<string | null> {
  const read = VisionOcr?.pdfPageTexts;
  if (typeof read !== 'function') return null;
  try {
    const pages = await read(clean(uri), null);
    return joinPdfPageTexts(Array.isArray(pages) ? pages : []);
  } catch {
    return null;
  }
}

async function buildPdf(items: CreateItem[], sources: PdfSource[], name: string, options: BuildOptions): Promise<Document> {
  const { signal, onProgress } = options;
  const native = VisionOcr as unknown as Partial<PdfNative> | null;
  if (typeof native?.mergePdfs !== 'function' || typeof native?.pdfEditPages !== 'function') {
    throw new CreatePdfError('unavailable', 'PDF merge unavailable');
  }
  const { mergePdfs, pdfEditPages, pdfInfo } = native as PdfNative;
  const plan = planPdf(items, sources);
  const total = progressTotal(items);
  const work = createTempDir('build');
  let rendered: string | null = null;
  let done = 0;
  const step = () => onProgress?.({ done: ++done, total });
  try {
    // 1. Photos, images and scanned pages, rendered into one PDF in list order.
    if (plan.imageKeys.length) {
      const byKey = new Map(items.map(it => [it.key, it]));
      const images: string[] = [];
      for (let k = 0; k < plan.imageKeys.length; k++) {
        throwIfAborted(signal);
        const it = byKey.get(plan.imageKeys[k]) as ImageItem | ScanItem;
        if (it.kind === 'image') {
          images.push(it.page);
        } else {
          // A snapshot taken under the document's lock: a filter finishing
          // meanwhile can't swap the pixels halfway through.
          const snap = new File(work, `scan-${k}.jpg`);
          await withChosenPage(it, uri => new File(clean(uri)).copy(snap));
          images.push(snap.uri);
        }
      }
      const settings = await getDocSettings().catch(() => null);
      const base = done;
      rendered = await generatePdf(images, {
        pageSize: settings?.pdfPageSize ?? 'Auto',
        quality: settings?.pdfQuality ?? 'standard',
        searchable: ocrAvailable(),
        signal,
        onProgress: (d, _t, phase) => {
          if (phase === 'preparing') onProgress?.({ done: base + d, total });
        },
      });
      done = base + plan.imageKeys.length;
      onProgress?.({ done, total });
    }
    throwIfAborted(signal);

    // 2. The PDFs, still as they were when their pages were chosen.
    const byId = new Map(sources.map(s => [s.id, s]));
    for (const id of new Set(plan.parts.flatMap(p => (p.kind === 'pdf' ? [p.source] : [])))) {
      const src = byId.get(id);
      if (!src) throw new CreatePdfError('failed', 'unknown source');
      await checkSource(src, pdfInfo);
    }
    const inputs = plan.parts.map(p => clean(p.kind === 'images' ? (rendered as string) : (byId.get(p.source) as PdfSource).uri));

    // 3. One combined file; PDFKit moves the pages, so their text stays.
    const combined = new File(work, 'combined.pdf');
    try {
      await mergePdfs(inputs, combined.uri);
    } catch (err) {
      const src = plan.parts.find(p => p.kind === 'pdf');
      throw classify(err, src && src.kind === 'pdf' && plan.parts.length === 1 ? byId.get(src.source)?.name : undefined);
    }
    if (!combined.exists) throw new CreatePdfError('failed', 'merge wrote nothing');
    step();
    throwIfAborted(signal);

    // 4. The chosen pages in the list's order, turned (read back and checked natively).
    let out = combined;
    if (!plan.identity) {
      out = new File(work, 'created.pdf');
      const n = await pdfEditPages(combined.uri, out.uri, plan.sources, plan.rotations, null);
      if (n !== items.length || !out.exists) throw new CreatePdfError('failed', 'arrange not verified');
    } else if (typeof pdfInfo === 'function') {
      const check = await pdfInfo(out.uri, null).catch(() => null);
      if (!check || check.locked || check.pageCount !== items.length) throw new CreatePdfError('failed', 'merge not verified');
    }
    step();
    throwIfAborted(signal);

    // 5. The new document.
    const text = await readText(out.uri);
    const id = Crypto.randomUUID();
    const now = Date.now();
    try {
      const doc: Document = {
        id,
        name,
        pages: [],
        pdfUri: copyPdfToStorage(out.uri, id),
        createdAt: now,
        updatedAt: now,
        ...(text ? { ocrText: text } : {}),
      };
      await saveDocument(doc);
      step();
      return doc;
    } catch (err) {
      try { deleteDocumentFiles(id); } catch {}
      throw err;
    }
  } finally {
    deleteQuietly(rendered);
    deleteQuietly(work.uri);
  }
}
