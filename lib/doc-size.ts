// lib/doc-size.ts
// How much space a document takes, for the sizes shown in the export, share
// and long-press sheets. Counts what an export starts from: the page images
// (not their unfiltered .orig shadows), or the imported PDF.
import { File } from 'expo-file-system';
import type { Document } from '../types/document';

function bytesOf(uri: string): number {
  try {
    const f = new File(uri.split('?')[0]);
    return f.exists ? f.size ?? 0 : 0;
  } catch {
    return 0;
  }
}

/** Bytes on disk for one document. Synchronous file stats; cheap for a handful of pages. */
export function documentBytes(doc: Pick<Document, 'pages' | 'pdfUri'>): number {
  if (doc.pdfUri) return bytesOf(doc.pdfUri);
  return doc.pages.reduce((sum, p) => sum + bytesOf(p), 0);
}

/** Total bytes for several documents, off the current frame. */
export async function documentsBytes(docs: Pick<Document, 'pages' | 'pdfUri'>[]): Promise<number> {
  await Promise.resolve();
  return docs.reduce((sum, d) => sum + documentBytes(d), 0);
}
