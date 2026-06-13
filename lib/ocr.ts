// lib/ocr.ts
// Single OCR code path for the whole app. The native module throws at import
// when the dev client isn't rebuilt with @react-native-ml-kit/text-recognition
// linked, so we lazy-require it into a module-level var (null when unavailable)
// and every consumer routes through here.

type TextLine = { text: string; frame?: { left: number; top: number; width: number; height: number } };
type TextBlock = { text: string; frame?: { left: number; top: number; width: number; height: number }; lines: TextLine[] };
type RecognizeResult = { text: string; blocks: TextBlock[] };

let TextRecognition: { recognize: (uri: string) => Promise<RecognizeResult> } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  TextRecognition = require('@react-native-ml-kit/text-recognition').default;
} catch {
  // package not linked — OCR features will degrade gracefully.
}

export function ocrAvailable(): boolean {
  return TextRecognition !== null;
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
  if (!TextRecognition) return { text: '', lines: [] };
  const result = await TextRecognition.recognize(cleanUri(uri));
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

/**
 * OCR every page sequentially (NOT Promise.all — keeps peak memory bounded) and
 * join each page's recognized text with a blank line. Used to build the content
 * search index. Returns '' when OCR is unavailable.
 */
export async function extractDocText(pages: string[]): Promise<string> {
  if (!TextRecognition) return '';
  const parts: string[] = [];
  for (const page of pages) {
    const result = await TextRecognition.recognize(cleanUri(page));
    parts.push(result.text ?? '');
  }
  return parts.join('\n\n');
}
