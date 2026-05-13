// lib/pdf.ts
import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system';
import { PageAdjustment, PageFilter } from '../types/document';
import { combinedFilterCss } from './filters';

type PageSize = 'A4' | 'Letter';

// Paper sizes in points (1 inch = 72 points). expo-print's `width`/`height`
// options control the actual PDF page geometry — the CSS @page rule is only
// a hint that mobile renderers often ignore.
const PAPER_DIMENSIONS: Record<PageSize, { width: number; height: number }> = {
  A4:     { width: 595, height: 842 },
  Letter: { width: 612, height: 792 },
};

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
  const dims = PAPER_DIMENSIONS[pageSize];
  const { uri } = await Print.printToFileAsync({
    html,
    width: dims.width,
    height: dims.height,
    margins: { left: 0, right: 0, top: 0, bottom: 0 },
  } as any);
  return uri;
}
