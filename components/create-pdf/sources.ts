// components/create-pdf/sources.ts
// Create PDF: turning what the user picked into page-list items.
//
// - Photos and image files go through the same auto-crop as Import photos
//   (components/use-import autoCropWithMisses: the page outline is found and
//   the photo kept whole as the page's source; a page that is already flat is
//   used as it is; a photo whose edges weren't found is kept whole). The page
//   is rendered right away at the user's scan quality, so the list shows what
//   will be saved.
// - PDFs from Files are staged into Caches/create-pdf. A protected one asks for
//   its password and an unlocked copy is used (VisionOcr.unlockPdf); one whose
//   permissions don't allow taking its pages is refused with a clear message.
// - A protected PDF document in Scan Kit is unlocked the way the viewer does
//   it, for this session only (lib/pdf-session.ts: the stored PDF stays
//   protected); its pages are taken from the session's decrypted copy, and
//   the new PDF doesn't need a password.
import { Alert } from 'react-native';
import { File } from 'expo-file-system';
import { VisionOcr } from '@/modules/vision-ocr/src';
import { autoCropWithMisses } from '@/components/use-import';
import { canWarp, isSourceInput, prepareSourcePage } from '@/lib/page-source';
import { fileIdentity } from '@/lib/ocr-cache';
import { deleteDisposableTemps } from '@/lib/files';
import { filePrint } from '@/lib/pdf-edit';
import { pdfPageThumbnails } from '@/lib/pdf-thumb';
import { canUnlockForSession, isSessionUnlocked, PdfSessionError, readablePdfUri, unlockForSession } from '@/lib/pdf-session';
import { getDocument } from '@/lib/storage';
import { canRenderPdfThumbs, createTempDir, deleteQuietly } from '@/lib/create-pdf-build';
import { type ImageItem, type ImageOrigin, type PdfItem, type PdfSource, type ScanItem } from '@/lib/create-pdf';
import type { Document } from '@/types/document';

export type StagedSource = PdfSource & { tempDir?: string };

let keySeq = 0;
export const newKey = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++keySeq}`;

const clean = (uri: string) => uri.split('?')[0];

// ── Photos and images ────────────────────────────────────────────────────────

/** One photo or image file as a page item (see the header). `keep`: Settings › Keep original photos. */
export async function prepareImageItem(uri: string, origin: ImageOrigin, quality: number, keep: boolean, label: string): Promise<ImageItem> {
  const { pages, uncropped } = await autoCropWithMisses([uri], 0.95);
  const input = pages[0];
  const temps = [uri];
  if (isSourceInput(input) && canWarp()) {
    const prepared = await prepareSourcePage(input, quality, keep);
    // The picker's copy is done with: the page and its source are our own files now.
    deleteDisposableTemps([uri]);
    temps.length = 0;
    temps.push(prepared.page);
    if (prepared.source) temps.push(prepared.source);
    return {
      key: newKey('img'),
      kind: 'image',
      origin,
      page: prepared.page,
      source: prepared.source,
      geometry: prepared.geometry,
      uncropped: uncropped.length > 0,
      temps,
      label,
      turn: 0,
    };
  }
  const page = isSourceInput(input) ? input.sourceUri : input;
  temps.push(page);
  return { key: newKey('img'), kind: 'image', origin, page, source: null, geometry: null, uncropped: uncropped.length > 0, temps, label, turn: 0 };
}

// ── Passwords ────────────────────────────────────────────────────────────────

/** Asks for a PDF's password (iOS secure prompt). Null when the user cancels. */
export function askPassword(name: string, retry: boolean): Promise<string | null> {
  return new Promise(resolve => {
    Alert.prompt(
      retry ? 'That password isn’t right' : 'Enter the PDF’s password',
      retry
        ? 'Check it and try again. Passwords are case-sensitive.'
        : `“${name}” is protected. Enter its password to add its pages.`,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
        { text: 'Unlock', isPreferred: true, onPress: (value?: string) => resolve(value ?? '') },
      ],
      'secure-text',
    );
  });
}

type Info = { pageCount: number; locked: boolean; restricted?: boolean };

async function pdfInfo(uri: string): Promise<Info | null> {
  const info = VisionOcr?.pdfInfo;
  if (typeof info !== 'function') return null;
  return info(clean(uri), null);
}

export type SourceRefusal = 'restricted' | 'unreadable' | 'cancelled' | 'unavailable';

export class SourceError extends Error {
  constructor(readonly kind: SourceRefusal, readonly sourceName: string) {
    super(kind);
    this.name = 'SourceError';
  }
}

// ── PDFs from Files ──────────────────────────────────────────────────────────

/** Thumbnails of every page of `uri` into `dir` (empty when this build can't draw them). */
async function renderThumbs(uri: string, dir: string): Promise<string[]> {
  const render = VisionOcr?.renderPdfPages;
  if (!canRenderPdfThumbs() || typeof render !== 'function') return [];
  try {
    return await render(clean(uri), dir, 200);
  } catch (err) {
    console.warn('Create PDF: thumbnails failed', err);
    return [];
  }
}

/**
 * Stages a PDF picked in Files (asking for its password when it has one) and
 * returns it with an item per page. Throws SourceError when it can't be used.
 */
export async function stageFilesPdf(uri: string, name: string): Promise<{ source: StagedSource; items: PdfItem[] }> {
  const dir = createTempDir('file');
  const fail = (kind: SourceRefusal): never => {
    deleteQuietly(dir.uri);
    throw new SourceError(kind, name);
  };
  let staged = new File(dir, 'source.pdf');
  try {
    new File(clean(uri)).copy(staged);
  } catch {
    fail('unreadable');
  }
  // The picker's copy (Caches/DocumentPicker) isn't needed once ours exists.
  deleteDisposableTemps([uri]);
  let info: Info | null = null;
  try {
    info = await pdfInfo(staged.uri);
  } catch {
    fail('unreadable');
  }
  if (info?.locked) {
    const unlock = VisionOcr?.unlockPdf;
    if (typeof unlock !== 'function' || !canUnlockForSession()) fail('unavailable');
    const out = new File(dir, 'unlocked.pdf');
    let retry = false;
    for (;;) {
      const pw = await askPassword(name, retry);
      if (pw == null) fail('cancelled');
      try {
        await unlock!(staged.uri, out.uri, pw as string);
        break;
      } catch {
        deleteQuietly(out.uri);
        retry = true;
      }
    }
    deleteQuietly(staged.uri);
    staged = out;
    info = await pdfInfo(staged.uri).catch(() => null);
  }
  if (info?.restricted) fail('restricted');
  if (info && (info.locked || info.pageCount < 1)) fail('unreadable');
  const thumbs = await renderThumbs(staged.uri, new File(dir, 'thumbs').uri);
  const pageCount = info?.pageCount ?? thumbs.length;
  if (pageCount < 1) fail('unreadable');
  const source: StagedSource = { id: newKey('pdf'), uri: staged.uri, name, pageCount, staged: true, tempDir: dir.uri };
  return { source, items: pdfItems(source, Array.from({ length: pageCount }, (_, i) => i), thumbs) };
}

export function pdfItems(source: PdfSource, indices: number[], thumbs: string[]): PdfItem[] {
  return indices.map(i => ({
    key: newKey('pdfp'),
    kind: 'pdf' as const,
    pdf: source.id,
    index: i,
    thumb: thumbs[i] ?? null,
    label: source.name,
    turn: 0 as const,
  }));
}

// ── Documents in Scan Kit ────────────────────────────────────────────────────

/**
 * Gets a PDF document ready to take pages from: unlocked for this session
 * (asking for the password, like the viewer) and allowed. Returns the fresh
 * record, its page count, page thumbnails and the file to read (the session
 * copy of a protected PDF). Throws SourceError.
 */
export async function readyStoredPdf(doc: Document): Promise<{ doc: Document; pageCount: number; thumbs: string[]; uri: string }> {
  const fresh = (await getDocument(doc.id)) ?? doc;
  if (!fresh.pdfUri) throw new SourceError('unreadable', doc.name);
  const readable = async (): Promise<string> => {
    try {
      return clean(await readablePdfUri(fresh, { needs: ['assemblePages'] }));
    } catch (err) {
      throw new SourceError(err instanceof PdfSessionError && err.kind === 'restricted' ? 'restricted' : 'unreadable', doc.name);
    }
  };
  let uri = await readable();
  let info: Info | null;
  try {
    info = await pdfInfo(uri);
  } catch {
    throw new SourceError('unreadable', doc.name);
  }
  if (info?.locked && !isSessionUnlocked(fresh.id)) {
    if (!canUnlockForSession()) throw new SourceError('unavailable', doc.name);
    let retry = false;
    for (;;) {
      const pw = await askPassword(doc.name, retry);
      if (pw == null) throw new SourceError('cancelled', doc.name);
      try {
        await unlockForSession(fresh, pw);
        break;
      } catch (err) {
        if (err instanceof PdfSessionError && err.kind === 'wrong-password') {
          retry = true;
          continue;
        }
        throw new SourceError('unreadable', doc.name);
      }
    }
    uri = await readable();
    info = await pdfInfo(uri).catch(() => null);
  }
  if (info?.restricted) throw new SourceError('restricted', doc.name);
  if (info?.locked) throw new SourceError('unreadable', doc.name);
  let thumbs: string[] = [];
  if (canRenderPdfThumbs()) {
    try {
      thumbs = await pdfPageThumbnails(fresh.id, uri);
    } catch (err) {
      console.warn('Create PDF: page thumbnails failed', err);
    }
  }
  const pageCount = info?.pageCount ?? thumbs.length;
  if (pageCount < 1) throw new SourceError('unreadable', doc.name);
  return { doc: fresh, pageCount, thumbs, uri };
}

/**
 * A Scan Kit PDF document as a source (with the print the build checks).
 * `uri`: the file its pages come from when it isn't the stored one (the
 * session copy of a protected PDF, readyStoredPdf).
 */
export function storedPdfSource(doc: Document, pageCount: number, uri?: string): PdfSource {
  const from = clean(uri ?? (doc.pdfUri as string));
  return { id: newKey('doc'), docId: doc.id, uri: from, name: doc.name, pageCount, print: filePrint(from) };
}

/** Items for pages `indices` of a scanned document. */
export function scanItems(doc: Document, indices: number[]): ScanItem[] {
  return indices.map(i => ({
    key: newKey('scan'),
    kind: 'scan' as const,
    docId: doc.id,
    docName: doc.name,
    index: i,
    uri: doc.pages[i],
    identity: fileIdentity(clean(doc.pages[i])),
    label: doc.name,
    turn: 0 as const,
  }));
}
