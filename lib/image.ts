import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { Directory, File, Paths } from 'expo-file-system';
import { replacePage } from './files';

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

    const side = new File(dir, `page-${pageIndex}.orig.new.jpg`);
    if (side.exists) { try { side.delete(); } catch {} }
    new File(resultPath).copy(side);
    try { orig.delete(); } catch {}
    side.copy(orig);
    try { side.delete(); } catch {}
    try { new File(resultPath).delete(); } catch {}
  } catch (err) {
    console.error('mirrorGeometryToOriginal failed', err);
  }
}
