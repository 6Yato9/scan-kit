import { requireOptionalNativeModule } from 'expo';

export type VisionLine = { text: string; left: number; top: number; width: number; height: number };
export type VisionResult = { text: string; lines: VisionLine[] };

type VisionOcrNative = { recognize(uri: string): Promise<VisionResult> };

/** null on Android, on web, and in a dev client built before this module existed. */
export const VisionOcr = requireOptionalNativeModule<VisionOcrNative>('VisionOcr');
