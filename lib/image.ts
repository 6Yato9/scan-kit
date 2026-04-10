import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { Directory, File, Paths } from 'expo-file-system';

/**
 * Rotates a stored page JPEG by 90° and overwrites the original file.
 * Returns the same URI (file content replaced).
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
  // Overwrite the original file with the rotated result
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  const dest = new File(dir, `page-${pageIndex}.jpg`);
  if (dest.exists) dest.delete();
  const src = new File(result.uri);
  src.copy(dest);
  return dest.uri;
}
