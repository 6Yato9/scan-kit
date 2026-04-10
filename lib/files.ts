// lib/files.ts
import { Directory, File, Paths } from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

export function copyPageToStorage(
  tempUri: string,
  docId: string,
  pageIndex: number
): string {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  dir.create({ intermediates: true, idempotent: true });
  const dest = new File(dir, `page-${pageIndex}.jpg`);
  const src = new File(tempUri);
  src.copy(dest);
  return dest.uri;
}

export function deleteDocumentFiles(docId: string): void {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  if (dir.exists) {
    dir.delete();
  }
}

/** Overwrites a stored page with a new file (e.g. after rotation). */
export function replacePage(newUri: string, docId: string, pageIndex: number): string {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  const dest = new File(dir, `page-${pageIndex}.jpg`);
  if (dest.exists) dest.delete();
  const src = new File(newUri);
  src.copy(dest);
  return dest.uri;
}

/** Copies an array of temp URIs into a doc's storage, starting at startIndex. */
export function appendPages(
  tempUris: string[],
  docId: string,
  startIndex: number
): string[] {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  dir.create({ intermediates: true, idempotent: true });
  return tempUris.map((uri, i) => {
    const dest = new File(dir, `page-${startIndex + i}.jpg`);
    const src = new File(uri);
    src.copy(dest);
    return dest.uri;
  });
}

/**
 * Deletes a single page file and shifts subsequent pages down by one index.
 * After calling this, update document.pages in the caller.
 */
export function deleteSinglePage(
  docId: string,
  pageIndex: number,
  totalPages: number
): void {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  const target = new File(dir, `page-${pageIndex}.jpg`);
  if (target.exists) target.delete();
  for (let i = pageIndex + 1; i < totalPages; i++) {
    const src = new File(dir, `page-${i}.jpg`);
    const dest = new File(dir, `page-${i - 1}.jpg`);
    if (src.exists) {
      src.copy(dest);
      src.delete();
    }
  }
}

/**
 * Reorders page files according to newOrderIndices.
 * newOrderIndices[i] = old index that should become new index i.
 * Returns the new URIs in new order.
 */
export function reorderPages(docId: string, newOrderIndices: number[]): string[] {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  const n = newOrderIndices.length;
  // Step 1: copy originals to temp names
  for (let i = 0; i < n; i++) {
    const src = new File(dir, `page-${newOrderIndices[i]}.jpg`);
    const tmp = new File(dir, `page-tmp-${i}.jpg`);
    src.copy(tmp);
  }
  // Step 2: delete old files
  for (let i = 0; i < n; i++) {
    const old = new File(dir, `page-${i}.jpg`);
    if (old.exists) old.delete();
  }
  // Step 3: move temp to final
  for (let i = 0; i < n; i++) {
    const tmp = new File(dir, `page-tmp-${i}.jpg`);
    const dest = new File(dir, `page-${i}.jpg`);
    tmp.copy(dest);
    tmp.delete();
  }
  return Array.from({ length: n }, (_, i) => new File(dir, `page-${i}.jpg`).uri);
}

/** Copies all page files from sourceId to a new destId directory. */
export function copyDocumentFiles(
  sourceId: string,
  destId: string,
  pages: string[]
): string[] {
  const destDir = new Directory(Paths.document, 'scan-kit', destId);
  destDir.create({ intermediates: true, idempotent: true });
  return pages.map((_, i) => {
    const src = new File(new Directory(Paths.document, 'scan-kit', sourceId), `page-${i}.jpg`);
    const dest = new File(destDir, `page-${i}.jpg`);
    src.copy(dest);
    return dest.uri;
  });
}

/**
 * Copies a temp page URI to storage, compressing to the given quality (0–1).
 * When quality === 1, copies the file directly (no recompression).
 */
export async function copyPageWithQuality(
  tempUri: string,
  docId: string,
  pageIndex: number,
  quality: number
): Promise<string> {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  dir.create({ intermediates: true, idempotent: true });
  const dest = new File(dir, `page-${pageIndex}.jpg`);
  if (quality === 1) {
    const src = new File(tempUri);
    src.copy(dest);
  } else {
    const result = await manipulateAsync(tempUri, [], { compress: quality, format: SaveFormat.JPEG });
    const src = new File(result.uri);
    src.copy(dest);
    src.delete();
  }
  return dest.uri;
}

/**
 * Copies an imported PDF from a temp URI to permanent storage.
 * Returns the stored file:// URI.
 */
export function copyPdfToStorage(tempUri: string, docId: string): string {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  dir.create({ intermediates: true, idempotent: true });
  const dest = new File(dir, 'document.pdf');
  const src = new File(tempUri);
  src.copy(dest);
  return dest.uri;
}
