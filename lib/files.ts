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

/**
 * Overwrites a page's `.orig` shadow with a new file (e.g. after compression),
 * using the same copy-then-swap as replacePage. No-op when the page has no
 * shadow. Returns true when a shadow was replaced.
 */
export function replaceOriginal(newUri: string, docId: string, pageIndex: number): boolean {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  const dest = new File(dir, `page-${pageIndex}.orig.jpg`);
  if (!dest.exists) return false;
  const side = new File(dir, `page-${pageIndex}.orig.new.jpg`);
  if (side.exists) {
    try { side.delete(); } catch {}
  }
  new File(stripQuery(newUri)).copy(side);
  try { dest.delete(); } catch {}
  side.copy(dest);
  try { side.delete(); } catch {}
  return true;
}

/** Removes the `?v=` cache-bust suffix the UI appends to page URIs. */
function stripQuery(uri: string): string {
  return uri.split('?')[0];
}

/**
 * The `.orig` shadow that belongs to a stored page URI, or null when the URI
 * is not a stored page (e.g. a scanner or picker temp file).
 */
export function shadowOf(pageUri: string): string | null {
  const clean = stripQuery(pageUri);
  if (!/\/page-\d+\.jpg$/.test(clean)) return null;
  return clean.replace(/\.jpg$/, '.orig.jpg');
}

/**
 * Copies one page into `destDocId` at `destIndex`, carrying its unfiltered
 * `.orig` shadow along when the source has one.
 *
 * Every tool that copies pages between documents must go through this: the
 * startup migration treats "no .orig" as "filter never baked", so a page copied
 * without its shadow but with its filter metadata gets the filter applied a
 * second time on the next launch, and its real original is lost for good.
 *
 * A stale `.orig` already sitting at the destination index is removed when the
 * source has none — otherwise the copied page would be paired with the wrong
 * image the next time a filter is baked.
 */
export function copyPageWithShadow(srcUri: string, destDocId: string, destIndex: number): string {
  const dir = new Directory(Paths.document, 'scan-kit', destDocId);
  dir.create({ intermediates: true, idempotent: true });
  const dest = new File(dir, `page-${destIndex}.jpg`);
  const destOrig = new File(dir, `page-${destIndex}.orig.jpg`);
  const src = new File(stripQuery(srcUri));
  if (dest.exists) dest.delete();
  src.copy(dest);

  const shadowUri = shadowOf(srcUri);
  const srcOrig = shadowUri ? new File(shadowUri) : null;
  if (destOrig.exists) {
    try { destOrig.delete(); } catch {}
  }
  if (srcOrig && srcOrig.exists) srcOrig.copy(destOrig);
  return dest.uri;
}

/**
 * Copies page URIs into a doc's storage, starting at startIndex. Accepts both
 * temp files (fresh scans) and another document's stored pages (merge), whose
 * `.orig` shadows are carried across — see copyPageWithShadow.
 */
export function appendPages(
  tempUris: string[],
  docId: string,
  startIndex: number
): string[] {
  return tempUris.map((uri, i) => copyPageWithShadow(uri, docId, startIndex + i));
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

  // Runs the shift for one file family. Called for the pages themselves and
  // again for their page-N.orig.jpg shadows, which must move in lockstep: the
  // .orig is the unfiltered source every filter bake re-derives from, so if it
  // stays behind after a delete, page N's next bake silently swaps in the image
  // that used to be at N+1.
  const shift = (suffix: string) => {
    const name = (i: number) => `page-${i}${suffix}.jpg`;
    const tmpName = (i: number) => `page-${i}${suffix}.shifting.jpg`;
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
        const src = new File(dir, name(i));
        if (!src.exists) continue; // tolerate gaps (and pages with no .orig yet)
        const tmp = new File(dir, tmpName(i));
        if (tmp.exists) tmp.delete();
        src.copy(tmp);
      }

      // Phase 2: delete the target, delete the old src files, promote tmps.
      const target = new File(dir, name(pageIndex));
      if (target.exists) target.delete();

      for (let i = pageIndex + 1; i < totalPages; i++) {
        const src = new File(dir, name(i));
        if (src.exists) {
          try { src.delete(); } catch {}
        }
      }

      for (let i = pageIndex + 1; i < totalPages; i++) {
        const tmp = new File(dir, tmpName(i));
        if (!tmp.exists) continue;
        const dest = new File(dir, name(i - 1));
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
  };

  shift('');
  shift('.orig');
}

/**
 * Reorders page files according to newOrderIndices.
 * newOrderIndices[i] = old index that should become new index i.
 * Returns the new URIs in new order.
 */
export function reorderPages(docId: string, newOrderIndices: number[]): string[] {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  const n = newOrderIndices.length;

  // Reorders one file family. Run for the pages and again for their .orig
  // shadows so a reorder can't leave page N paired with another page's
  // unfiltered source — the next bake would swap in the wrong image entirely.
  // `required` is false for .orig: a page that has never been filtered has none.
  const reorder = (suffix: string, required: boolean) => {
    const name = (i: number) => `page-${i}${suffix}.jpg`;
    const tmpName = (i: number) => `page-tmp-${i}${suffix}.jpg`;
    const cleanupTemps = () => {
      for (let i = 0; i < n; i++) {
        const tmp = new File(dir, tmpName(i));
        if (tmp.exists) {
          try { tmp.delete(); } catch {}
        }
      }
    };

    try {
      // Step 1: copy originals to temp names. Bail early if a required source is missing.
      for (let i = 0; i < n; i++) {
        const src = new File(dir, name(newOrderIndices[i]));
        if (!src.exists) {
          if (!required) continue;
          cleanupTemps();
          throw new Error(`reorderPages: source ${name(newOrderIndices[i])} missing`);
        }
        const tmp = new File(dir, tmpName(i));
        if (tmp.exists) tmp.delete();
        src.copy(tmp);
      }
      // Step 2: delete old files
      for (let i = 0; i < n; i++) {
        const old = new File(dir, name(i));
        if (old.exists) old.delete();
      }
      // Step 3: move temp to final
      for (let i = 0; i < n; i++) {
        const tmp = new File(dir, tmpName(i));
        if (!tmp.exists) continue;
        const dest = new File(dir, name(i));
        tmp.copy(dest);
        tmp.delete();
      }
    } catch (err) {
      cleanupTemps();
      throw err;
    }
  };

  reorder('', true);
  reorder('.orig', false);

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
  const srcDir = new Directory(Paths.document, 'scan-kit', sourceId);
  return pages.map((_, i) => {
    const src = new File(srcDir, `page-${i}.jpg`);
    const dest = new File(destDir, `page-${i}.jpg`);
    src.copy(dest);
    // Carry the .orig shadow across too. Without it the duplicate has no
    // pristine source, so its first filter change would bake on top of pixels
    // that already have a filter in them.
    const srcOrig = new File(srcDir, `page-${i}.orig.jpg`);
    if (srcOrig.exists) srcOrig.copy(new File(destDir, `page-${i}.orig.jpg`));
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

/** Returns the file:// URI of a page's pristine, pre-filter source copy. */
export function originalUri(docId: string, pageIndex: number): string {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  return new File(dir, `page-${pageIndex}.orig.jpg`).uri;
}

/**
 * Ensures a pristine `.orig.jpg` copy of a page exists, copying it from the
 * current `page-N.jpg` only if the `.orig` doesn't already exist. Idempotent
 * by design: every filter change re-derives from this same pristine source,
 * so re-baking a filter never compounds JPEG generation loss, and reverting
 * to Original is always possible. Returns the `.orig` URI either way.
 */
export function ensureOriginal(docId: string, pageIndex: number): string {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  const orig = new File(dir, `page-${pageIndex}.orig.jpg`);
  if (!orig.exists) {
    const src = new File(dir, `page-${pageIndex}.jpg`);
    src.copy(orig);
  }
  return orig.uri;
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
  // An empty list almost always means the document index could not be read,
  // not that the user has no documents (deleting a document already removes
  // its folder). Sweeping against it would delete the whole library.
  if (valid.size === 0) return 0;
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
