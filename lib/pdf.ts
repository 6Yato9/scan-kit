// lib/pdf.ts
import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system/legacy';
import { Image } from 'react-native';
import { PageAdjustment, PageFilter } from '../types/document';
import { combinedFilterCss } from './filters';
import { recognizeLines, OcrLine } from './ocr';

type PageSize = 'A4' | 'Letter';

// Paper sizes in points (1 inch = 72 points). expo-print's `width`/`height`
// options control the actual PDF page geometry — the CSS @page rule is only
// a hint that mobile renderers often ignore.
const PAPER_DIMENSIONS: Record<PageSize, { width: number; height: number }> = {
  A4:     { width: 595, height: 842 },
  Letter: { width: 612, height: 792 },
};

/** Render the document HTML to a PDF file via expo-print at the given paper size. */
async function printHtmlToPdf(html: string, pageSize: PageSize): Promise<string> {
  const dims = PAPER_DIMENSIONS[pageSize];
  const { uri } = await Print.printToFileAsync({
    html,
    width: dims.width,
    height: dims.height,
    margins: { left: 0, right: 0, top: 0, bottom: 0 },
  } as any);
  return uri;
}

/** Strip any `?v=` cache-bust suffix the viewer applies before reading a file. */
function cleanUri(uri: string): string {
  return uri.split('?')[0];
}

/** Promisified Image.getSize — resolves natural pixel dimensions. */
function getImageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
  });
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

export async function generatePdf(
  pages: string[],
  filters?: PageFilter[],
  adjustments?: PageAdjustment[],
  pageSize: PageSize = 'A4',
): Promise<string> {
  // Read each page sequentially to keep peak JS heap bounded. A 50-page doc at
  // 90% JPEG quality can easily push ~200MB through Promise.all otherwise.
  const imgTags: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const uri = pages[i];
    const css = combinedFilterCss(filters?.[i], adjustments?.[i]);
    const filterAttr = css !== 'none' ? `filter:${css};` : '';
    const mime = uri.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    let b64: string;
    try {
      b64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`generatePdf: failed to read page ${i} (${uri}): ${msg}`);
    }
    imgTags.push(
      `<img src="data:${mime};base64,${b64}" style="width:100%;display:block;page-break-after:always;${filterAttr}" />`,
    );
  }

  const sizeCss = pageSize === 'Letter' ? 'letter' : 'A4';
  const html = `<html><head><style>@page { size: ${sizeCss}; margin: 0; }</style></head><body style="margin:0;padding:0;">${imgTags.join('')}</body></html>`;
  return printHtmlToPdf(html, pageSize);
}

/**
 * Searchable PDF: same image rendering as generatePdf, but with an invisible,
 * absolutely-positioned text layer behind each word so the output is
 * selectable/searchable in any PDF reader.
 *
 * Coordinates use a vw-normalized system: each page wrapper is `width:100vw`, so
 * `s = 100 / imgW` converts an image pixel offset into vw. This keeps the text
 * layer aligned with the image at ANY paper size, since both the image and the
 * spans scale with the page width.
 */
export async function generateSearchablePdf(
  pages: string[],
  filters?: PageFilter[],
  adjustments?: PageAdjustment[],
  pageSize: PageSize = 'A4',
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const pageHtml: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const uri = pages[i];
    const clean = cleanUri(uri);
    const css = combinedFilterCss(filters?.[i], adjustments?.[i]);
    const filterAttr = css !== 'none' ? `filter:${css};` : '';
    const mime = clean.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

    let b64: string;
    try {
      b64 = await FileSystem.readAsStringAsync(clean, { encoding: 'base64' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`generateSearchablePdf: failed to read page ${i} (${clean}): ${msg}`);
    }

    // Natural pixel dimensions drive the vw scale factor. Fall back to a
    // 1:1-ish guess if getSize fails so a single bad page can't abort export.
    let imgW = 1000;
    let imgH = 1414;
    try {
      const size = await getImageSize(clean);
      if (size.width > 0 && size.height > 0) {
        imgW = size.width;
        imgH = size.height;
      }
    } catch {
      // keep fallback dims
    }

    const { lines } = await recognizeLines(uri);
    onProgress?.(i + 1, pages.length);

    const s = 100 / imgW; // vw per image pixel
    const spans = lines
      .filter((l: OcrLine) => l.text.trim().length > 0)
      .map((l: OcrLine) => {
        const left = l.left * s;
        const top = l.top * s;
        const width = l.width * s;
        const height = l.height * s;
        const fontSize = height * 0.85;
        return `<span style="position:absolute; left:${left}vw; top:${top}vw; width:${width}vw; height:${height}vw; font-size:${fontSize}vw; line-height:${height}vw; color:transparent; white-space:pre; overflow:hidden;">${escapeHtml(l.text)}</span>`;
      })
      .join('');

    // wrapperHeight in vw keeps the wrapper exactly as tall as the scaled image.
    pageHtml.push(
      `<div style="position:relative; width:100vw; page-break-after:always; overflow:hidden;">` +
        `<img src="data:${mime};base64,${b64}" style="width:100vw; height:auto; display:block; ${filterAttr}" />` +
        spans +
      `</div>`,
    );
  }

  const sizeCss = pageSize === 'Letter' ? 'letter' : 'A4';
  const html = `<html><head><style>@page { size: ${sizeCss}; margin: 0; }</style></head><body style="margin:0;padding:0;">${pageHtml.join('')}</body></html>`;
  return printHtmlToPdf(html, pageSize);
}
