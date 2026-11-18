// lib/compress.ts
// Re-encodes a document's page images smaller, in place. Each page's .orig
// shadow (the unfiltered source every filter bake re-derives from) is
// compressed with the same settings, otherwise the next filter change would
// re-bake from the full-size original and silently undo the saving.
import { Image } from 'react-native';
import { File } from 'expo-file-system';
import { manipulateAsync, SaveFormat, type Action } from 'expo-image-manipulator';
import { originalUri, replaceOriginal, replacePage } from './files';
import { patchDocument } from './storage';
import { runPageEdit } from './bake';
import type { Document } from '../types/document';

export type CompressLevel = 'small' | 'balanced' | 'sharp';

export const COMPRESS_LEVELS: Record<CompressLevel, { maxEdge: number; quality: number }> = {
  small: { maxEdge: 1600, quality: 0.5 },
  balanced: { maxEdge: 2200, quality: 0.65 },
  sharp: { maxEdge: 3000, quality: 0.8 },
};

/** The resize step that brings the long edge down to `maxEdge`, or none if it already fits. */
export function resizeFor(width: number, height: number, maxEdge: number): Action[] {
  if (!(width > 0 && height > 0) || Math.max(width, height) <= maxEdge) return [];
  return width >= height ? [{ resize: { width: maxEdge } }] : [{ resize: { height: maxEdge } }];
}

export function fileSize(uri: string): number {
  try {
    const f = new File(uri.split('?')[0]);
    return f.exists ? f.size ?? 0 : 0;
  } catch {
    return 0;
  }
}

/** Total bytes of a document's pages (not counting .orig shadows). */
export function documentSize(doc: Document): number {
  return doc.pages.reduce((sum, p) => sum + fileSize(p), 0);
}

function imageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise(resolve => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), () => resolve({ width: 0, height: 0 }));
  });
}

/** Compress one file; returns a temp URI, or null if the result wouldn't be smaller. */
async function compressFile(uri: string, level: CompressLevel): Promise<string | null> {
  const { maxEdge, quality } = COMPRESS_LEVELS[level];
  const clean = uri.split('?')[0];
  const { width, height } = await imageSize(clean);
  const actions = resizeFor(width, height, maxEdge);
  const out = await manipulateAsync(clean, actions, {
    compress: quality,
    format: SaveFormat.JPEG,
  });
  // A resize is always kept, so a page and its .orig keep matching dimensions
  // (crop coordinates are mirrored between them). Without a resize, re-encoding
  // an already small JPEG can make it bigger — then keep the existing file.
  if (actions.length === 0 && fileSize(out.uri) >= fileSize(clean)) {
    try { new File(out.uri).delete(); } catch {}
    return null;
  }
  return out.uri;
}

export type CompressResult = { before: number; after: number; changedPages: number };

/**
 * Compresses every page (and its .orig shadow) of an image document in place,
 * sequentially to keep memory bounded. Records the change with patchDocument so
 * edits made meanwhile (rename, OCR index) are not overwritten.
 */
export async function compressDocument(
  doc: Document,
  level: CompressLevel,
  onProgress?: (done: number, total: number) => void,
): Promise<CompressResult> {
  const before = documentSize(doc);
  const total = doc.pages.length;
  let changedPages = 0;

  for (let i = 0; i < total; i++) {
    // Under the document lock, and announced as a pixel edit, so a filter bake
    // in flight for this page re-runs from the compressed .orig instead of
    // writing the full-size result over it.
    const changed = await runPageEdit(doc.id, { pages: [i] }, async () => {
      const page = await compressFile(doc.pages[i], level);
      if (page) {
        replacePage(page, doc.id, i);
        try { new File(page).delete(); } catch {}
      }
      const origPath = originalUri(doc.id, i);
      if (new File(origPath).exists) {
        const orig = await compressFile(origPath, level);
        if (orig) {
          replaceOriginal(orig, doc.id, i);
          try { new File(orig).delete(); } catch {}
        }
      }
      return !!page;
    });
    if (changed) changedPages++;
    onProgress?.(i + 1, total);
  }

  // Page file names are unchanged; bumping updatedAt refreshes cached thumbnails.
  await patchDocument(doc.id, { updatedAt: Date.now() });
  return { before, after: documentSize(doc), changedPages };
}
