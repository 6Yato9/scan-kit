// lib/ocr.ts
// Single OCR code path for the whole app.
//
// iOS: Apple Vision via the local module in modules/vision-ocr. Google ML Kit is
// excluded from iOS (react-native.config.js) — its frameworks have no
// arm64-simulator slice, and Vision is more accurate on iOS.
// Android: @react-native-ml-kit/text-recognition.
//
// Either native module can be missing (a dev client built before it was added),
// so both are resolved defensively and every consumer routes through here.
import { Platform } from 'react-native';
import { VisionOcr } from '../modules/vision-ocr/src';

type TextLine = { text: string; frame?: { left: number; top: number; width: number; height: number } };
type TextBlock = { text: string; frame?: { left: number; top: number; width: number; height: number }; lines: TextLine[] };
type RecognizeResult = { text: string; blocks: TextBlock[] };

let MlKit: { recognize: (uri: string) => Promise<RecognizeResult> } | null = null;
if (Platform.OS === 'android') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    MlKit = require('@react-native-ml-kit/text-recognition').default;
  } catch {
    // package not linked — OCR features will degrade gracefully.
  }
}

/** One recognition pass, normalised to text + positioned lines. */
async function recognize(uri: string): Promise<{ text: string; lines: OcrLine[] }> {
  if (VisionOcr) {
    const r = await VisionOcr.recognize(uri);
    return { text: r.text ?? '', lines: r.lines ?? [] };
  }
  if (MlKit) {
    const result = await MlKit.recognize(uri);
    const lines: OcrLine[] = [];
    for (const block of result.blocks ?? []) {
      for (const line of block.lines ?? []) {
        if (!line.frame) continue;
        lines.push({
          text: line.text,
          left: line.frame.left,
          top: line.frame.top,
          width: line.frame.width,
          height: line.frame.height,
        });
      }
    }
    return { text: result.text ?? '', lines };
  }
  return { text: '', lines: [] };
}

export function ocrAvailable(): boolean {
  return VisionOcr !== null || MlKit !== null;
}

export type OcrLine = {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

/** Strip any `?v=` cache-bust suffix the viewer applies before handing a URI to native OCR. */
function cleanUri(uri: string): string {
  return uri.split('?')[0];
}

/**
 * Recognize text on a single image. Flattens the block/line tree into a flat
 * list of positioned lines (image-pixel coordinates). Lines without a frame are
 * skipped since they can't be positioned in the searchable text layer.
 * Returns empty results when OCR is unavailable.
 */
export async function recognizeLines(uri: string): Promise<{ text: string; lines: OcrLine[] }> {
  if (!ocrAvailable()) return { text: '', lines: [] };
  return recognize(cleanUri(uri));
}

/**
 * OCR every page sequentially (NOT Promise.all — keeps peak memory bounded) and
 * join each page's recognized text with a blank line. Used to build the content
 * search index. Returns '' when OCR is unavailable.
 */
export async function extractDocText(pages: string[]): Promise<string> {
  if (!ocrAvailable()) return '';
  const parts: string[] = [];
  for (const page of pages) {
    const result = await recognize(cleanUri(page));
    parts.push(result.text);
  }
  return parts.join('\n\n');
}
