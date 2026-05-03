// lib/pdf.ts
import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system';
import { PageAdjustment, PageFilter } from '../types/document';
import { combinedFilterCss } from './filters';

type PageSize = 'A4' | 'Letter';

export async function generatePdf(
  pages: string[],
  filters?: PageFilter[],
  adjustments?: PageAdjustment[],
  pageSize: PageSize = 'A4',
): Promise<string> {
  const imgTags = await Promise.all(
    pages.map(async (uri, i) => {
      const css = combinedFilterCss(filters?.[i], adjustments?.[i]);
      const filterAttr = css !== 'none' ? `filter:${css};` : '';
      const mime = uri.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      const b64 = await FileSystem.readAsStringAsync(uri, {
        encoding: 'base64',
      }).catch((err: Error) => {
        throw new Error(`generatePdf: failed to read page ${i} (${uri}): ${err.message}`);
      });
      return `<img src="data:${mime};base64,${b64}" style="width:100%;display:block;page-break-after:always;${filterAttr}" />`;
    })
  );
  const sizeCss = pageSize === 'Letter' ? 'letter' : 'A4';
  const html = `<html><head><style>@page { size: ${sizeCss}; margin: 0; }</style></head><body style="margin:0;padding:0;">${imgTags.join('')}</body></html>`;
  const { uri } = await Print.printToFileAsync({ html });
  return uri;
}
