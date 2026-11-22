// lib/photos.ts
// Saving pages to the photo library, lock-aware.
//
// Pages leave the app here: once in Photos they can be seen without unlocking
// Scan Kit. So, like the share sheet and print dialog (lib/share.ts), saving
// waits while App Lock is engaged (lib/nav-guard whenUnlocked) — before the
// permission prompt, which is system UI presented over the top screen, and
// before every page. A save the user started and then locked the phone on
// simply continues after they unlock; one whose sheet was closed meanwhile
// (`signal` aborted) stops without saving anything more.
//
// This is the ONLY place allowed to call MediaLibrary.saveToLibraryAsync /
// createAssetAsync (eslint-rules/lock-safe.js enforces it).
//
// Android 10+ saves through VisionOcr.saveImageToPhotos (MediaStore, no
// permission): expo-media-library wants WRITE_EXTERNAL_STORAGE below Android
// 13, which the app declares only up to Android 9.
import { Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import { VisionOcr } from '../modules/vision-ocr/src';
import { whenUnlocked } from './nav-guard';

export type PhotosOutcome = 'saved' | 'denied' | 'cancelled';

export type SaveToPhotosOptions = {
  signal?: AbortSignal;
  /** Called before page `index` (0-based) of `total` is written. */
  onProgress?: (index: number, total: number) => void;
};

/**
 * Adds every image in `uris` to the photo library (add-only permission).
 * Resolves 'denied' when the user has not allowed it (the caller explains how
 * to fix that), 'cancelled' when `signal` fired. Rejects when a write fails.
 */
export async function savePagesToPhotos(uris: string[], options: SaveToPhotosOptions = {}): Promise<PhotosOutcome> {
  const { signal, onProgress } = options;
  await whenUnlocked();
  if (signal?.aborted) return 'cancelled';
  const native = Platform.OS === 'android' && typeof VisionOcr?.saveImageToPhotos === 'function'
    ? VisionOcr.saveImageToPhotos
    : null;
  if (native) {
    for (let i = 0; i < uris.length; i++) {
      await whenUnlocked();
      if (signal?.aborted) return 'cancelled';
      onProgress?.(i, uris.length);
      await native(uris[i].split('?')[0]);
    }
    return 'saved';
  }
  let perm = await MediaLibrary.getPermissionsAsync(true);
  if (!perm.granted && perm.canAskAgain) {
    await whenUnlocked();
    if (signal?.aborted) return 'cancelled';
    perm = await MediaLibrary.requestPermissionsAsync(true);
  }
  if (!perm.granted) return 'denied';
  for (let i = 0; i < uris.length; i++) {
    await whenUnlocked();
    if (signal?.aborted) return 'cancelled';
    onProgress?.(i, uris.length);
    await MediaLibrary.saveToLibraryAsync(uris[i].split('?')[0]);
  }
  return 'saved';
}
