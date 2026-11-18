import { requireOptionalNativeModule } from 'expo';

export type VisionLine = { text: string; left: number; top: number; width: number; height: number };
export type VisionResult = { text: string; lines: VisionLine[] };
export type DetectResult = { uri: string; detected: boolean };

type VisionOcrNative = {
  recognize(uri: string): Promise<VisionResult>;
  /** Present only in dev clients built after document detection was added. */
  detectDocument?: (uri: string, quality: number) => Promise<DetectResult>;
  /** Present only in dev clients built after PDF protection was added. */
  protectPdf?: (inputUri: string, outputUri: string, password: string) => Promise<string>;
  /** Present only in dev clients built after PDF page rendering was added. */
  renderPdfPages?: (inputUri: string, outputDirUri: string, maxEdge: number) => Promise<string[]>;
};

/** null on Android, on web, and in a dev client built before this module existed. */
export const VisionOcr = requireOptionalNativeModule<VisionOcrNative>('VisionOcr');
