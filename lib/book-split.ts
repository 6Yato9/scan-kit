// lib/book-split.ts
// Splits a photographed two-page book spread into its left and right pages.
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

/** Crop rectangles for the left and right halves of a width × height image. */
export function spreadHalves(width: number, height: number) {
  const half = Math.floor(width / 2);
  return [
    { originX: 0, originY: 0, width: half, height },
    { originX: half, originY: 0, width: width - half, height },
  ];
}

/**
 * Returns the left and right page of each spread, in reading order, plus every
 * temp file created (callers delete them once the pages are saved).
 * Images in portrait orientation are already single pages and pass through.
 */
export async function splitSpreads(uris: string[]): Promise<{ pages: string[]; temps: string[] }> {
  const pages: string[] = [];
  const temps: string[] = [];
  for (const uri of uris) {
    // Normalise first so EXIF rotation is applied and width/height are real.
    const base = await manipulateAsync(uri, [], { compress: 1, format: SaveFormat.JPEG });
    temps.push(base.uri);
    if (base.height > base.width) {
      pages.push(base.uri);
      continue;
    }
    for (const crop of spreadHalves(base.width, base.height)) {
      const half = await manipulateAsync(base.uri, [{ crop }], { compress: 0.92, format: SaveFormat.JPEG });
      temps.push(half.uri);
      pages.push(half.uri);
    }
  }
  return { pages, temps };
}
