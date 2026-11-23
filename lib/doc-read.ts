// lib/doc-read.ts
// A saved document's pages as images to read text from, for the tools that
// read or search what is printed (Find text, Extract text, QR code): a scan's
// own page images, or an imported PDF's pages rendered large enough for OCR
// (lib/pdf-thumb.ts pdfPageImages, cached, so a second read is instant —
// lib/ocr caches the recognised lines per image too). Nothing is written to
// the document.
import { pdfPageImages } from './pdf-thumb';
import { PdfSessionError, readablePdfUri } from './pdf-session';
import type { Document } from '@/types/document';

export type DocReadErrorKind = 'locked' | 'unreadable';

export class DocReadError extends Error {
  constructor(readonly kind: DocReadErrorKind) {
    super(kind);
    this.name = 'DocReadError';
  }
}

/** A page URI without the cache-busting query the app adds for <Image>. */
const bare = (uri: string) => uri.split('?')[0];

/**
 * The document's pages, in order, as image URIs. Rejects with DocReadError:
 * 'locked' for a password-protected PDF that isn't unlocked this session,
 * 'unreadable' for a PDF that can't be rendered (damaged, missing, or a build
 * without the rasterizer).
 */
export async function documentReadPages(doc: Pick<Document, 'id' | 'pages' | 'pdfUri' | 'trashedAt'>): Promise<string[]> {
  if (!doc.pdfUri) return doc.pages.map(bare);
  let uri: string;
  try {
    uri = await readablePdfUri(doc);
  } catch (err) {
    throw new DocReadError(err instanceof PdfSessionError && err.kind === 'locked' ? 'locked' : 'unreadable');
  }
  try {
    const pages = await pdfPageImages(doc.id, uri);
    if (!pages.length) throw new Error('no pages');
    return pages;
  } catch (err) {
    const message = err instanceof Error ? err.message.toLowerCase() : '';
    throw new DocReadError(message.includes('lock') || message.includes('password') ? 'locked' : 'unreadable');
  }
}

/** What to tell someone whose document couldn't be read: [title, message]. */
export function docReadErrorText(err: unknown): [string, string] {
  if (err instanceof DocReadError && err.kind === 'locked') {
    return ['This PDF is password protected', 'Open it in Scan Kit and enter its password first, then try again.'];
  }
  return ['Couldn’t read this document', 'The file may be damaged. Try importing it again.'];
}
