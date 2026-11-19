// lib/pdf-thumb.ts
// First-page thumbnails for PDF documents, so a PDF in Home and Files shows
// its page like a scan does instead of a generic icon. Rendered once by the
// native PDF rasterizer (VisionOcr.renderPdfPages) at a small size, kept in
// Caches (never in the document's folder, which Files may show) and keyed by
// the PDF file's modification time and size plus this session's edit
// generation of the document, so a changed PDF gets a new thumbnail.
// Builds without the rasterizer, locked PDFs and unreadable files keep the
// icon: callers get null.
//
// The generation matters for Undo: it puts back a copy of the PDF that kept
// its modification time (File.copy), so time and size alone would name the
// pre-edit thumbnail — already deleted — and show a blank one (r12 code
// review #3). Every edit, Undo, conversion or redaction calls
// invalidatePdfThumbs, which also deletes the renders (they show the pages:
// r12 code review #2) and tells the cards showing them to look again.
//
// A password-protected PDF never gets a card thumbnail, even while it is
// unlocked for the session (lib/pdf-session.ts): cards render the stored,
// encrypted file, which fails, so the icon stays. The page thumbnails Reorder,
// Split and Create PDF need of a session copy go into the copy's scratch
// folder, deleted with it, never into Caches/pdf-thumbs.
import { useEffect, useState } from 'react';
import { Directory, File, Paths } from 'expo-file-system';
import { VisionOcr } from '../modules/vision-ocr/src';
import { PDF_THUMB_DIR, removePdfThumbFiles } from './files';
import { isSessionPath, sessionScratchDir } from './pdf-session';

/** Long edge of the thumbnail: sharp in a three-column grid on a 3x screen. */
const THUMB_EDGE = 360;
const DIR_NAME = PDF_THUMB_DIR;

/** key → thumbnail URI, or null when this PDF can't have one. */
const known = new Map<string, string | null>();
const waiting = new Map<string, Promise<string | null>>();
let queue: Promise<unknown> = Promise.resolve();

/** Document id → how many times its PDF was changed this session (see the header). */
const generations = new Map<string, number>();
const listeners = new Set<(docId: string) => void>();

function thumbDir(): Directory {
  return new Directory(Paths.cache, DIR_NAME);
}

function keyFor(docId: string, pdfUri: string): string | null {
  try {
    const f = new File(pdfUri.split('?')[0]);
    if (!f.exists) return null;
    return `${docId}-${Math.round(f.modificationTime ?? 0)}-${f.size}-g${generations.get(docId) ?? 0}`;
  } catch {
    return null;
  }
}

/** A remembered thumbnail, unless its file has gone since (null: none known). */
function knownUri(key: string): { uri: string | null } | null {
  if (!known.has(key)) return null;
  const uri = known.get(key) ?? null;
  if (uri) {
    try {
      if (!new File(uri).exists) {
        known.delete(key);
        return null;
      }
    } catch {
      return null;
    }
  }
  return { uri };
}

/**
 * Document `docId`'s PDF changed, was converted to pages, redacted or deleted:
 * its renders are deleted, forgotten, and every card showing one looks again.
 * Never throws.
 */
export function invalidatePdfThumbs(docId: string): void {
  generations.set(docId, (generations.get(docId) ?? 0) + 1);
  for (const key of [...known.keys()]) if (key.startsWith(`${docId}-`)) known.delete(key);
  try { removePdfThumbFiles(docId); } catch {}
  for (const fn of listeners) {
    try { fn(docId); } catch {}
  }
}

export function pdfThumbsAvailable(): boolean {
  return typeof VisionOcr?.renderPdfPages === 'function';
}

async function render(docId: string, key: string, pdfUri: string): Promise<string | null> {
  const out = new File(thumbDir(), `${key}.jpg`);
  if (out.exists && out.size > 0) return out.uri;
  const renderPages = VisionOcr?.renderPdfPages;
  if (typeof renderPages !== 'function') return null;
  const tmp = new Directory(Paths.cache, DIR_NAME, `tmp-${key}-${Date.now().toString(36)}`);
  try {
    tmp.create({ intermediates: true, idempotent: true });
    const pages = await renderPages(pdfUri.split('?')[0], tmp.uri, THUMB_EDGE);
    if (!pages.length) return null;
    // Changed while rendering: this picture is of a PDF that is gone.
    if (keyFor(docId, pdfUri) !== key) return null;
    // Older thumbnails of this document (an earlier version of its PDF) go.
    for (const item of thumbDir().list()) {
      if (item instanceof File && item.name.startsWith(`${docId}-`)) {
        try { item.delete(); } catch {}
      }
    }
    new File(pages[0].split('?')[0]).move(out);
    return out.uri;
  } catch {
    return null; // locked, damaged, or no space: the icon stays
  } finally {
    try { if (tmp.exists) tmp.delete(); } catch {}
  }
}

/** The thumbnail for a PDF document, rendering it (one at a time) if needed. */
export function pdfThumbnail(docId: string, pdfUri: string): Promise<string | null> {
  // Never a picture of a protected PDF's page that outlives its session (see the header).
  if (isSessionPath(pdfUri)) return Promise.resolve(null);
  const key = keyFor(docId, pdfUri);
  if (!key) return Promise.resolve(null);
  const remembered = knownUri(key);
  if (remembered) return Promise.resolve(remembered.uri);
  const pending = waiting.get(key);
  if (pending) return pending;
  const job = queue.then(() => render(docId, key, pdfUri)).then(
    uri => {
      known.set(key, uri);
      waiting.delete(key);
      return uri;
    },
    () => {
      known.set(key, null);
      waiting.delete(key);
      return null;
    },
  );
  queue = job;
  waiting.set(key, job);
  return job;
}

/** React hook: the first-page thumbnail URI for a PDF document, or null (show the icon). */
export function usePdfThumbnail(docId: string, pdfUri: string | undefined): string | null {
  const [uri, setUri] = useState<string | null>(() => {
    if (!pdfUri) return null;
    const key = keyFor(docId, pdfUri);
    return key ? knownUri(key)?.uri ?? null : null;
  });
  // Bumped when the document's PDF changes (invalidatePdfThumbs): look again.
  const [generation, setGeneration] = useState(() => generations.get(docId) ?? 0);
  useEffect(() => {
    const onChange = (changed: string) => {
      if (changed === docId) setGeneration(generations.get(docId) ?? 0);
    };
    listeners.add(onChange);
    return () => { listeners.delete(onChange); };
  }, [docId]);
  useEffect(() => {
    if (!pdfUri || !pdfThumbsAvailable()) {
      setUri(null);
      return;
    }
    let alive = true;
    pdfThumbnail(docId, pdfUri).then(u => { if (alive) setUri(u); });
    return () => { alive = false; };
  }, [docId, pdfUri, generation]);
  return uri;
}

// ── Every page, for Reorder pages ───────────────────────────────────────────

/** Long edge of a page thumbnail in the Reorder list (44 × 58 pt rows on a 3x screen). */
const PAGE_THUMB_EDGE = 200;

/**
 * Thumbnails of every page of a PDF document, in page order, rendered on
 * demand into Caches/pdf-thumbs/pages-<key> (kept while the PDF is unchanged;
 * an earlier version's set is removed). Rejects when the PDF can't be
 * rendered (locked, damaged, a build without the rasterizer).
 */
export async function pdfPageThumbnails(docId: string, pdfUri: string): Promise<string[]> {
  const renderPages = VisionOcr?.renderPdfPages;
  if (typeof renderPages !== 'function') throw new Error('renderPdfPages missing');
  const key = keyFor(docId, pdfUri);
  if (!key) throw new Error('PDF missing');
  // A session copy (unique per version of the stored bytes): beside it.
  const scratch = sessionScratchDir(pdfUri);
  if (scratch) return renderPageSet(renderPages, pdfUri, new Directory(scratch, 'pages'));
  const dir = new Directory(thumbDir(), `pages-${key}`);
  const done = new File(dir, 'done');
  if (dir.exists && done.exists) {
    const pages = dir
      .list()
      .filter((f): f is File => f instanceof File && /^pdfpage-\d+\.jpg$/.test(f.name))
      .sort((a, b) => parseInt(a.name.slice(8), 10) - parseInt(b.name.slice(8), 10))
      .map(f => f.uri);
    if (pages.length > 0) return pages;
  }
  for (const item of thumbDir().exists ? thumbDir().list() : []) {
    if (item instanceof Directory && item.name.startsWith(`pages-${docId}-`)) {
      try { item.delete(); } catch {}
    }
  }
  return renderPageSet(renderPages, pdfUri, dir);
}

/** Renders every page of `pdfUri` into `dir` (marked done), or reuses a finished set there. */
async function renderPageSet(
  renderPages: (inputUri: string, outputDirUri: string, maxEdge: number) => Promise<string[]>,
  pdfUri: string,
  dir: Directory,
): Promise<string[]> {
  const done = new File(dir, 'done');
  if (dir.exists && done.exists) {
    const pages = dir
      .list()
      .filter((f): f is File => f instanceof File && /^pdfpage-\d+\.jpg$/.test(f.name))
      .sort((a, b) => parseInt(a.name.slice(8), 10) - parseInt(b.name.slice(8), 10))
      .map(f => f.uri);
    if (pages.length > 0) return pages;
  }
  dir.create({ intermediates: true, idempotent: true });
  try {
    const pages = await renderPages(pdfUri.split('?')[0], dir.uri, PAGE_THUMB_EDGE);
    done.create();
    return pages;
  } catch (err) {
    try { if (dir.exists) dir.delete(); } catch {}
    throw err;
  }
}
