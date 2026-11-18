// lib/pdf-thumb.ts
// First-page thumbnails for PDF documents, so a PDF in Home and Files shows
// its page like a scan does instead of a generic icon. Rendered once by the
// native PDF rasterizer (VisionOcr.renderPdfPages) at a small size, kept in
// Caches (never in the document's folder, which Files may show) and keyed by
// the PDF file's modification time, so a changed PDF gets a new thumbnail.
// Builds without the rasterizer, locked PDFs and unreadable files keep the
// icon: callers get null.
import { useEffect, useState } from 'react';
import { Directory, File, Paths } from 'expo-file-system';
import { VisionOcr } from '../modules/vision-ocr/src';

/** Long edge of the thumbnail: sharp in a three-column grid on a 3x screen. */
const THUMB_EDGE = 360;
const DIR_NAME = 'pdf-thumbs';

/** key → thumbnail URI, or null when this PDF can't have one. */
const known = new Map<string, string | null>();
const waiting = new Map<string, Promise<string | null>>();
let queue: Promise<unknown> = Promise.resolve();

function thumbDir(): Directory {
  return new Directory(Paths.cache, DIR_NAME);
}

function keyFor(docId: string, pdfUri: string): string | null {
  try {
    const f = new File(pdfUri.split('?')[0]);
    if (!f.exists) return null;
    return `${docId}-${Math.round(f.modificationTime ?? 0)}-${f.size}`;
  } catch {
    return null;
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
  const key = keyFor(docId, pdfUri);
  if (!key) return Promise.resolve(null);
  if (known.has(key)) return Promise.resolve(known.get(key) ?? null);
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
    return key ? known.get(key) ?? null : null;
  });
  useEffect(() => {
    if (!pdfUri || !pdfThumbsAvailable()) {
      setUri(null);
      return;
    }
    let alive = true;
    pdfThumbnail(docId, pdfUri).then(u => { if (alive) setUri(u); });
    return () => { alive = false; };
  }, [docId, pdfUri]);
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
