// lib/document-detect.ts
// Auto-crop for photos imported from the library: finds the page in the photo
// and returns a perspective-corrected copy (Apple Vision on iOS). Anywhere it
// isn't available, or when no confident outline is found, the original photo
// is returned unchanged — import must never fail because of this step.
import { VisionOcr } from '../modules/vision-ocr/src';

export async function autoCropDocument(uri: string, quality = 0.9): Promise<{ uri: string; detected: boolean }> {
  const clean = uri.split('?')[0];
  if (!VisionOcr?.detectDocument) return { uri: clean, detected: false };
  try {
    return await VisionOcr.detectDocument(clean, quality);
  } catch {
    return { uri: clean, detected: false };
  }
}

/** Auto-crop several imported photos in order, one at a time (bounded memory). */
export async function autoCropDocuments(uris: string[], quality = 0.9): Promise<string[]> {
  const out: string[] = [];
  for (const uri of uris) out.push((await autoCropDocument(uri, quality)).uri);
  return out;
}
