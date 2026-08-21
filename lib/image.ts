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
    const dir = new Directory(Paths.document, 'scan-kit', docId);
    return new File(dir, `page-${pageIndex}.jpg`).uri;
  }

  const stored = replacePage(resultPath, docId, pageIndex);
  // Clean up the manipulator temp file so it doesn't accumulate in cache.
  try {
    const tmp = new File(resultPath);
    if (tmp.exists) tmp.delete();
  } catch {}
  return stored;
}
