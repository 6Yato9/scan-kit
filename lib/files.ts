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

/**
 * Overwrites a stored page with a new file (e.g. after rotation).
 * Atomic: copies the new file to a side path first; only deletes the old
 * page and promotes the side file after the copy succeeds.
 */
export function replacePage(newUri: string, docId: string, pageIndex: number): string {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  const dest = new File(dir, `page-${pageIndex}.jpg`);
  const side = new File(dir, `page-${pageIndex}.new.jpg`);
  const src = new File(newUri);

  if (side.exists) {
    try { side.delete(); } catch {}
  }
  src.copy(side); // throws if the copy fails — dest is untouched

  // Copy succeeded. Swap.
  if (dest.exists) {
    try { dest.delete(); } catch {}
  }
  side.copy(dest);
  try { side.delete(); } catch {}
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
 *
 * Implementation: 2-phase copy-to-tmp then promote so a crash mid-shift can be
 * rolled back (caller can re-call after recovering from the failure).
 */
export function deleteSinglePage(
  docId: string,
  pageIndex: number,
  totalPages: number
): void {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  const tmpName = (i: number) => `page-${i}.shifting.jpg`;
  const cleanupTmps = () => {
    for (let i = pageIndex + 1; i < totalPages; i++) {
      const t = new File(dir, tmpName(i));
      if (t.exists) {
        try { t.delete(); } catch {}
      }
    }
  };

  try {
    // Phase 1: copy each shifted source to a tmp name keyed to its destination.
    for (let i = pageIndex + 1; i < totalPages; i++) {
      const src = new File(dir, `page-${i}.jpg`);
      if (!src.exists) continue; // tolerate gaps
      const tmp = new File(dir, tmpName(i));
      if (tmp.exists) tmp.delete();
      src.copy(tmp);
    }

    // Phase 2: delete the target, delete the old src files, promote tmps.
    const target = new File(dir, `page-${pageIndex}.jpg`);
    if (target.exists) target.delete();

    for (let i = pageIndex + 1; i < totalPages; i++) {
      const src = new File(dir, `page-${i}.jpg`);
      if (src.exists) {
        try { src.delete(); } catch {}
      }
    }

    for (let i = pageIndex + 1; i < totalPages; i++) {
      const tmp = new File(dir, tmpName(i));
      if (!tmp.exists) continue;
      const dest = new File(dir, `page-${i - 1}.jpg`);
      if (dest.exists) {
        try { dest.delete(); } catch {}
      }
      tmp.copy(dest);
      try { tmp.delete(); } catch {}
    }
  } catch (err) {
    cleanupTmps();
    throw err;
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

  const cleanupTemps = () => {
    for (let i = 0; i < n; i++) {
      const tmp = new File(dir, `page-tmp-${i}.jpg`);
      if (tmp.exists) {
        try { tmp.delete(); } catch {}
      }
    }
  };

  try {
    // Step 1: copy originals to temp names. Bail early if any source is missing.
    for (let i = 0; i < n; i++) {
      const src = new File(dir, `page-${newOrderIndices[i]}.jpg`);
      if (!src.exists) {
        cleanupTemps();
        throw new Error(`reorderPages: source page-${newOrderIndices[i]}.jpg missing`);
      }
      const tmp = new File(dir, `page-tmp-${i}.jpg`);
      if (tmp.exists) tmp.delete();
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
  } catch (err) {
    cleanupTemps();
    throw err;
  }
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

/** Returns the last path segment of a file:// uri (the basename), or ''. */
function baseName(uri: string): string {
  const trimmed = uri.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

const STALE_TEMP = [/\.tmp\.jpg$/, /\.new\.jpg$/, /\.shifting\.jpg$/, /^page-tmp-.*\.jpg$/];

/**
 * Startup sweep. Deletes:
 *  - any directory under scan-kit/ whose name is NOT in validDocIds (orphans
 *    whose doc record is gone), and
 *  - stale interrupted-operation temp files inside the VALID doc dirs.
 *
 * Extremely defensive: every item is wrapped in its own try/catch so a single
 * failure never aborts the sweep, and if listing fails entirely it returns 0.
 * NEVER deletes a directory whose id IS in validDocIds.
 */
export async function garbageCollectOrphans(validDocIds: string[]): Promise<number> {
  let deleted = 0;
  const valid = new Set(validDocIds);
  let children: (Directory | File)[];
  try {
    const root = new Directory(Paths.document, 'scan-kit');
    if (!root.exists) return 0;
    children = root.list();
  } catch {
    return 0;
  }

  for (const child of children) {
    try {
      if (child instanceof Directory) {
        const id = baseName(child.uri);
        if (valid.has(id)) {
          // Valid doc dir: sweep only interrupted-operation leftovers inside it.
          let inner: (Directory | File)[];
          try {
            inner = child.list();
          } catch {
            continue;
          }
          for (const item of inner) {
            try {
              if (item instanceof File && STALE_TEMP.some(re => re.test(baseName(item.uri)))) {
                item.delete();
                deleted++;
              }
            } catch {}
          }
        } else {
          // Orphan directory: its doc record is gone. Remove it entirely.
          child.delete();
          deleted++;
        }
      }
    } catch {}
  }

  return deleted;
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
