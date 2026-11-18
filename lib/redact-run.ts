// lib/redact-run.ts
// The device half of Redact: reading pages to find matches, checking a
// redacted document, and tidying what a redaction leaves behind. The pure
// logic is lib/redact.ts; the pixels and storage are lib/page-stamp.ts
// (stampPages / stampCopy with `redact`).
import { Directory, Paths } from 'expo-file-system';
import { recognizeLines, ocrAvailable, OcrAbortedError, type OcrLine } from './ocr';
import { getImageSize } from './image-size';
import { CONVERT_DIR } from './convert-pdf';
import { findOnPage, leftoverMatches, type Finder, type RedactRect } from './redact';

export { ocrAvailable };

type PageText = { lines: OcrLine[]; size: { width: number; height: number } | null };

/** One page's recognised lines (cached after the first read: lib/ocr-cache) and pixel size. */
async function readPage(uri: string, signal?: AbortSignal): Promise<PageText> {
  const [ocr, size] = await Promise.all([recognizeLines(uri, signal), getImageSize(uri)]);
  return { lines: ocr.lines, size };
}

/**
 * Every match of `finder` on every page, page by page (one Vision pass at a
 * time). `onPage(i, n)` reports progress; a page that can't be read counts as
 * having no matches. Rejects with OcrAbortedError when `signal` fires.
 */
export async function findInDocument(
  pages: readonly string[],
  finder: Finder,
  options: { signal?: AbortSignal; onPage?: (done: number, total: number) => void } = {},
): Promise<RedactRect[][]> {
  const out: RedactRect[][] = [];
  for (let i = 0; i < pages.length; i++) {
    if (options.signal?.aborted) throw new OcrAbortedError();
    options.onPage?.(i, pages.length);
    try {
      const { lines, size } = await readPage(pages[i], options.signal);
      out.push(findOnPage(lines, size, finder));
    } catch (err) {
      if (err instanceof OcrAbortedError) throw err;
      out.push([]);
    }
  }
  return out;
}

/**
 * After redacting: pages (by index) where something searched for can still be read
 * under a box that was applied there, i.e. a box that didn't fully cover the
 * word. The redacted pages are new files, so this reads them afresh.
 */
export async function findLeftovers(
  pages: readonly string[],
  applied: ReadonlyMap<number, readonly RedactRect[]>,
  finders: readonly Finder[],
): Promise<Map<number, RedactRect[]>> {
  const left = new Map<number, RedactRect[]>();
  if (!finders.length || !ocrAvailable()) return left;
  for (const [index, boxes] of applied) {
    const uri = pages[index];
    if (!uri) continue;
    try {
      const { lines, size } = await readPage(uri);
      const found = leftoverMatches(lines, size, finders, boxes);
      if (found.length) left.set(index, found);
    } catch {
      // Unreadable now: nothing to report.
    }
  }
  return left;
}

/**
 * An imported PDF converted to pages for redacting keeps the original PDF in
 * an Undo stash (Caches/pdf-convert/undo-<docId>-…, lib/convert-pdf.ts) — its
 * text layer still holds every redacted word. Once the pages are redacted in
 * place, that stash goes: the conversion can no longer be undone, which is
 * the point. Never throws.
 */
export function discardConvertStashes(docId: string): number {
  let removed = 0;
  try {
    const root = new Directory(Paths.cache, CONVERT_DIR);
    if (!root.exists) return 0;
    for (const item of root.list()) {
      const name = item.uri.replace(/\/+$/, '').split('/').pop() ?? '';
      if (!(item instanceof Directory) || !name.startsWith(`undo-${docId}-`)) continue;
      try {
        item.delete();
        removed += 1;
      } catch {}
    }
  } catch {}
  return removed;
}
