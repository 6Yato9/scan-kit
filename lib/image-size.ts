// lib/image-size.ts
// Page size limits shared by import (lib/files.ts copyPageWithQuality) and the
// filter bake (lib/image.ts capStoredPageSize).
import { Image } from 'react-native';

/**
 * Longest edge a stored page may have, in pixels. Big enough for sharp A4
 * prints (≈ 340 dpi) and OCR, small enough that every page fits the bake's
 * WebKit canvas (4000 × 4000 = 16 M px; see lib/bake-html.ts BAKE_MAX_PIXELS) —
 * a 24 MP phone photo (5712 × 4284) would not.
 */
export const MAX_PAGE_EDGE = 4000;

/**
 * The size to shrink a `width` × `height` image to so its long edge is at most
 * `maxEdge`, keeping the aspect ratio — or null when it already fits.
 */
export function cappedSize(
  width: number,
  height: number,
  maxEdge: number = MAX_PAGE_EDGE,
): { width: number; height: number } | null {
  const long = Math.max(width, height);
  if (!(long > maxEdge)) return null;
  const k = maxEdge / long;
  return {
    width: Math.max(1, Math.round(width * k)),
    height: Math.max(1, Math.round(height * k)),
  };
}

/** Natural pixel size of a local image, or null when it can't be read. */
export function getImageSize(uri: string): Promise<{ width: number; height: number } | null> {
  return new Promise(resolve => {
    try {
      Image.getSize(
        uri.split('?')[0],
        (width, height) => resolve(width > 0 && height > 0 ? { width, height } : null),
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
}
