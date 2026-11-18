import { requireOptionalNativeModule } from 'expo';

export type VisionLine = { text: string; left: number; top: number; width: number; height: number };
export type VisionResult = { text: string; lines: VisionLine[] };
export type DetectResult = { uri: string; detected: boolean };

type VisionOcrNative = {
  recognize(uri: string): Promise<VisionResult>;
  /** Present only in dev clients built after document detection was added. */
  detectDocument?: (uri: string, quality: number) => Promise<DetectResult>;
};

/** null on Android, on web, and in a dev client built before this module existed. */
export const VisionOcr = requireOptionalNativeModule<VisionOcrNative>('VisionOcr');
