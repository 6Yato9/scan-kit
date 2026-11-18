import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { Directory, File, Paths } from 'expo-file-system';
import { replaceOriginal, replacePage } from './files';
import { cappedSize, getImageSize } from './image-size';

/**
 * Rotates a stored page JPEG by 90° and overwrites the original file.
 * Returns the same URI (file content replaced).
 *
 * Uses replacePage's atomic swap and cleans up the manipulator temp file.
 * Defensive against the edge case where manipulateAsync returns the same
 * URI as the input (older versions of the lib have done this).
 */
export async function rotatePage(
  uri: string,
  direction: 'cw' | 'ccw',
  docId: string,
  pageIndex: number
): Promise<string> {
  const degrees = direction === 'cw' ? 90 : -90;
  const result = await manipulateAsync(uri, [{ rotate: degrees }], {
    compress: 0.9,
    format: SaveFormat.JPEG,
  });

  // Strip query strings (e.g. `?v=…` cache-bust suffixes used by viewer Images).
  const normalize = (u: string) => u.split('?')[0];
  const resultPath = normalize(result.uri);
  const inputPath = normalize(uri);

  // If the manipulator returned the same path (rare but possible), nothing to do:
  // the file at the canonical doc location already contains the rotated bytes.
  if (resultPath === inputPath) {
    await mirrorGeometryToOriginal(docId, pageIndex, [{ rotate: degrees }]);
    const dir = new Directory(Paths.document, 'scan-kit', docId);
    return new File(dir, `page-${pageIndex}.jpg`).uri;
  }

  const stored = replacePage(resultPath, docId, pageIndex);
  // Keep the unfiltered shadow the same shape as the page it backs.
  await mirrorGeometryToOriginal(docId, pageIndex, [{ rotate: degrees }]);
  // Clean up the manipulator temp file so it doesn't accumulate in cache.
  try {
    const tmp = new File(resultPath);
    if (tmp.exists) tmp.delete();
  } catch {}
  return stored;
}

/**
 * Applies the same geometry transform to a page's `page-N.orig.jpg` shadow.
 *
 * `.orig` is the unfiltered source every filter bake re-derives from, so it must
 * always match its page's SHAPE — it differs only in colour. Without this, a
 * rotate or crop lands on the page but not the shadow, and the next filter change
 * re-derives from the stale shape and silently throws the rotate/crop away.
 *
 * No-op when the page has no `.orig` yet (it has never been filtered), and never
 * fatal: losing the mirror is worse than an un-mirrored shadow, but neither
 * should cost the user the edit they just made.
 */
export async function mirrorGeometryToOriginal(
  docId: string,
  pageIndex: number,
  actions: Parameters<typeof manipulateAsync>[1],
): Promise<void> {
  try {
    const dir = new Directory(Paths.document, 'scan-kit', docId);
    const orig = new File(dir, `page-${pageIndex}.orig.jpg`);
    if (!orig.exists) return;

    const result = await manipulateAsync(orig.uri, actions, {
      compress: 0.9,
      format: SaveFormat.JPEG,
    });
    const resultPath = result.uri.split('?')[0];
    if (resultPath === orig.uri.split('?')[0]) return; // manipulator wrote in place

    replaceOriginal(resultPath, docId, pageIndex);
    try { new File(resultPath).delete(); } catch {}
  } catch (err) {
    console.error('mirrorGeometryToOriginal failed', err);
  }
}

/** Canonical file:// URI of page `pageIndex` of `docId` (pages are stored by position). */
export function pageFileUri(docId: string, pageIndex: number): string {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  return new File(dir, `page-${pageIndex}.jpg`).uri;
}

/**
 * Crops a stored page in place and applies the identical crop to its `.orig`
 * shadow. `rect` is in the page's natural pixels; `.orig` has the same
 * dimensions, so the two stay the same shape — otherwise the next filter change
 * would re-derive from the uncropped original and silently undo the crop.
 */
export async function cropPage(
  docId: string,
  pageIndex: number,
  rect: { originX: number; originY: number; width: number; height: number },
): Promise<string> {
  const src = pageFileUri(docId, pageIndex);
  const result = await manipulateAsync(src, [{ crop: rect }], { compress: 0.9, format: SaveFormat.JPEG });
  const resultPath = result.uri.split('?')[0];
  let stored = src;
  if (resultPath !== src) {
    stored = replacePage(resultPath, docId, pageIndex);
    try {
      const tmp = new File(resultPath);
      if (tmp.exists) tmp.delete();
    } catch {}
  }
  await mirrorGeometryToOriginal(docId, pageIndex, [{ crop: rect }]);
  return stored;
}

/**
 * Shrinks page `pageIndex` of `docId` — and its `.orig` shadow, to exactly the
 * same size — when it is larger than MAX_PAGE_EDGE on its long edge. Pages
 * imported before imports were capped can be 24 MP or more, which the filter
 * bake's WebKit canvas can't hold; bakePage calls this (under the page lock)
 * before baking. Both files must stay the same shape, or a later crop measured
 * on the page would be applied to the wrong region of the shadow. Returns true
 * when something was resized. Never throws: an oversized page still bakes
 * (lib/bake-html.ts scales the canvas), just with mismatched sizes.
 */
export async function capStoredPageSize(docId: string, pageIndex: number): Promise<boolean> {
  try {
    const dir = new Directory(Paths.document, 'scan-kit', docId);
    const page = new File(dir, `page-${pageIndex}.jpg`);
    const orig = new File(dir, `page-${pageIndex}.orig.jpg`);
    const source = orig.exists ? orig : page;
    const size = await getImageSize(source.uri);
    const capped = size ? cappedSize(size.width, size.height) : null;
    if (!size || !capped) return false;
    const longEdge = size.width >= size.height ? { width: capped.width } : { height: capped.height };
    const first = await manipulateAsync(source.uri, [{ resize: longEdge }], { compress: 0.92, format: SaveFormat.JPEG });
    const temps = [first.uri];
    try {
      if (source === orig) {
        // The page gets the shadow's exact output size, so the two still match.
        const second = await manipulateAsync(page.uri, [{ resize: { width: first.width, height: first.height } }], { compress: 0.92, format: SaveFormat.JPEG });
        temps.push(second.uri);
        replaceOriginal(first.uri, docId, pageIndex);
        replacePage(second.uri, docId, pageIndex);
      } else {
        replacePage(first.uri, docId, pageIndex);
      }
    } finally {
      for (const uri of temps) {
        try { new File(uri.split('?')[0]).delete(); } catch {}
      }
    }
    return true;
  } catch (err) {
    console.warn('capStoredPageSize failed', err);
    return false;
  }
}
