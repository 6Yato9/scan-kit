// lib/pdf.ts
import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system';
import { PageFilter } from '../types/document';
import { filterCss } from './filters';

export async function generatePdf(pages: string[], filters?: PageFilter[]): Promise<string> {
  const imgTags = await Promise.all(
    pages.map(async (uri, i) => {
      const css = filterCss(filters?.[i]);
      const filterAttr = css !== 'none' ? `filter:${css};` : '';
      const b64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      return `<img src="data:image/jpeg;base64,${b64}" style="width:100%;display:block;page-break-after:always;${filterAttr}" />`;
    })
  );
  const html = `<html><body style="margin:0;padding:0;">${imgTags.join('')}</body></html>`;
  const { uri } = await Print.printToFileAsync({ html });
  return uri;
}
