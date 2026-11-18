// lib/doc-ops.ts
// Whole-document operations shared by Home and Files: duplicate and merge.
//
// Merging copies each page's `.orig` shadow alongside it. Without it the next
// launch's bake migration re-applies the recorded filter on top of pixels that
// already carry it, and "Original" can no longer be restored for those pages.
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { Document, PageAdjustment, PageFilter } from '../types/document';
import { copyDocumentFiles, copyPdfToStorage } from './files';
import { patchDocument, saveDocument } from './storage';

const DEFAULT_ADJ: PageAdjustment = { brightness: 0, contrast: 0, saturation: 0 };

function docDir(id: string): Directory {
  return new Directory(Paths.document, 'scan-kit', id);
}

/**
 * Copies `source`'s pages (and their `.orig` shadows) into `destId`'s folder
 * starting at `startIndex`. Returns the new page URIs.
 */
export function copyPagesWithOriginals(source: Document, destId: string, startIndex: number): string[] {
  const dest = docDir(destId);
  dest.create({ intermediates: true, idempotent: true });
  const srcDir = docDir(source.id);
  return source.pages.map((uri, i) => {
    const to = new File(dest, `page-${startIndex + i}.jpg`);
    if (to.exists) to.delete();
    new File(uri.split('?')[0]).copy(to);
    const srcOrig = new File(srcDir, `page-${i}.orig.jpg`);
    const destOrig = new File(dest, `page-${startIndex + i}.orig.jpg`);
    if (destOrig.exists) destOrig.delete();
    if (srcOrig.exists) srcOrig.copy(destOrig);
    return to.uri;
  });
}

/** Per-page filters/adjustments for a merged page list, collapsed when all default. */
export function combinePageMeta(docs: Document[]): Pick<Document, 'filters' | 'adjustments'> {
  const filters: PageFilter[] = docs.flatMap(d => d.filters ?? d.pages.map((): PageFilter => 'original'));
  const adjustments: PageAdjustment[] = docs.flatMap(d => d.adjustments ?? d.pages.map(() => ({ ...DEFAULT_ADJ })));
  const allOriginal = filters.every(f => f === 'original');
  const allDefault = adjustments.every(a => a.brightness === 0 && a.contrast === 0 && a.saturation === 0);
  return {
    filters: allOriginal ? undefined : filters,
    adjustments: allDefault ? undefined : adjustments,
  };
}

/** Saves and returns a copy of `doc` named "Copy of …". */
export async function duplicateDocument(doc: Document): Promise<Document> {
  const newId = Crypto.randomUUID();
  const now = Date.now();
  const base = { id: newId, name: `Copy of ${doc.name}`, folder: doc.folder, ocrText: doc.ocrText, createdAt: now, updatedAt: now };
  const newDoc: Document = doc.pdfUri
    ? { ...base, pages: [], pdfUri: copyPdfToStorage(doc.pdfUri.split('?')[0], newId) }
    : {
        ...base,
        pages: copyDocumentFiles(doc.id, newId, doc.pages),
        filters: doc.filters ? [...doc.filters] : undefined,
        adjustments: doc.adjustments ? doc.adjustments.map(a => ({ ...a })) : undefined,
      };
  await saveDocument(newDoc);
  return newDoc;
}

/**
 * Appends `source`'s pages to `target` (the source is left untouched).
 * Returns the updated target, or null if the target was deleted meanwhile.
 */
export async function mergeInto(target: Document, source: Document): Promise<Document | null> {
  const newPages = copyPagesWithOriginals(source, target.id, target.pages.length);
  const updated: Document = {
    ...target,
    pages: [...target.pages, ...newPages],
    ...combinePageMeta([target, source]),
    updatedAt: Date.now(),
  };
  const ok = await patchDocument(target.id, {
    pages: updated.pages,
    filters: updated.filters,
    adjustments: updated.adjustments,
    updatedAt: updated.updatedAt,
  });
  return ok ? updated : null;
}

/** Creates a new document holding every page of `docs`, in order. Sources are kept. */
export async function mergeIntoNew(docs: Document[], name: string): Promise<Document> {
  const newId = Crypto.randomUUID();
  const now = Date.now();
  const pages: string[] = [];
  for (const d of docs) pages.push(...copyPagesWithOriginals(d, newId, pages.length));
  const newDoc: Document = {
    id: newId,
    name,
    pages,
    ...combinePageMeta(docs),
    createdAt: now,
    updatedAt: now,
  };
  await saveDocument(newDoc);
  return newDoc;
}
