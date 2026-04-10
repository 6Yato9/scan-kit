// lib/pdf.ts
import * as Print from 'expo-print';

export async function generatePdf(pages: string[]): Promise<string> {
  const imgTags = pages
    .map(
      uri =>
        `<img src="${uri}" style="width:100%;display:block;page-break-after:always;" />`
    )
    .join('');
  const html = `<html><body style="margin:0;padding:0;">${imgTags}</body></html>`;
  const { uri } = await Print.printToFileAsync({ html });
  return uri;
}
