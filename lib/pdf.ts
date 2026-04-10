// lib/pdf.ts
import * as Print from 'expo-print';
import { PageFilter } from '../types/document';
import { filterCss } from './filters';

export async function generatePdf(pages: string[], filters?: PageFilter[]): Promise<string> {
  const imgTags = pages
    .map((uri, i) => {
      const css = filterCss(filters?.[i]);
      const filterAttr = css !== 'none' ? `filter:${css};` : '';
      return `<img src="${uri}" style="width:100%;display:block;page-break-after:always;${filterAttr}" />`;
    })
    .join('');
  const html = `<html><body style="margin:0;padding:0;">${imgTags}</body></html>`;
  const { uri } = await Print.printToFileAsync({ html });
  return uri;
}
