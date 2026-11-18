// lib/document-detect.ts
// Auto-crop for photos imported from the library: finds the page in the photo
// and returns a perspective-corrected copy (Apple Vision on iOS). Anywhere it
// isn't available, or when no confident outline is found, the original photo
// is returned unchanged — import must never fail because of this step.
import { VisionOcr } from '../modules/vision-ocr/src';
import { deleteDisposableTemps } from './files';

export async function autoCropDocument(uri: string, quality = 0.9): Promise<{ uri: string; detected: boolean }> {
  const clean = uri.split('?')[0];
  if (!VisionOcr?.detectDocument) return { uri: clean, detected: false };
  try {
    return await VisionOcr.detectDocument(clean, quality);
  } catch {
    return { uri: clean, detected: false };
  }
}

/**
 * Auto-crop several imported photos in order, one at a time (bounded memory).
 * A photo that was replaced by its cropped copy is deleted when it was only a
 * temp (a picker's cache copy) — nothing reads it afterwards.
 */
export async function autoCropDocuments(uris: string[], quality = 0.9): Promise<string[]> {
  const out: string[] = [];
  for (const uri of uris) {
    const result = await autoCropDocument(uri, quality);
    out.push(result.uri);
    if (result.uri.split('?')[0] !== uri.split('?')[0]) deleteDisposableTemps([uri]);
  }
  return out;
}
