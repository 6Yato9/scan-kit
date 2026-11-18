import { requireOptionalNativeModule } from 'expo';

export type VisionLine = { text: string; left: number; top: number; width: number; height: number };
export type VisionResult = { text: string; lines: VisionLine[] };
export type DetectResult = { uri: string; detected: boolean };
/** A written JPEG: file:// URI and pixel size. */
export type ImageResult = { uri: string; width: number; height: number };

type VisionOcrNative = {
  recognize(uri: string): Promise<VisionResult>;
  /** Present only in dev clients built after document detection was added. */
  detectDocument?: (uri: string, quality: number) => Promise<DetectResult>;
  /** Present only in dev clients built after PDF protection was added. */
  protectPdf?: (inputUri: string, outputUri: string, password: string) => Promise<string>;
  /** Present only in dev clients built after PDF page rendering was added. */
  renderPdfPages?: (inputUri: string, outputDirUri: string, maxEdge: number) => Promise<string[]>;
  /** Present only in dev clients built after PDF merging was added. */
  mergePdfs?: (inputUris: string[], outputUri: string) => Promise<string>;
  /** Embedded text per page; rejects with message "locked" when a password is needed. */
  pdfPageTexts?: (uri: string, password?: string | null) => Promise<string[]>;
  /** Unencrypted copy of a protected PDF; rejects with "wrong-password". */
  unlockPdf?: (inputUri: string, outputUri: string, password: string) => Promise<string>;
  /** One share sheet with several files; only lib/share.ts may call it (lock gate). */
  shareFiles?: (uris: string[], title?: string | null) => Promise<void>;
  /** Copy a system-provided (possibly security-scoped) file into the app. */
  copyIncomingFile?: (sourceUri: string, destUri: string) => Promise<string>;
  /**
   * Page outline in a photo: [x0,y0, x1,y1, x2,y2, x3,y3] = top-left, top-right,
   * bottom-right, bottom-left, normalised 0..1, top-left origin, in the photo's
   * UPRIGHT orientation (EXIF applied). Corners sit on the paper edge (no
   * inset). null when no confident outline (>= 15% of the photo) is found.
   * Rejects ERR_IMAGE_READ for an unreadable file.
   */
  detectQuad?: (uri: string) => Promise<number[] | null>;
  /**
   * Perspective-correct `quad` (same convention as detectQuad) of the upright
   * source into an upright JPEG (no EXIF rotation) with the long edge capped at
   * `maxEdge`. The corner order decides the output's orientation: a cyclic
   * shift of the list turns the page by 90 degrees clockwise per step. An
   * upright axis-aligned quad is a plain crop, so [0,0,1,0,1,1,0,1] returns the
   * whole image unchanged in geometry. Rejects ERR_BAD_QUAD (not 8 finite
   * numbers within -0.01..1.01, or not a convex, clockwise, non-degenerate
   * quad), ERR_BAD_ARGS, ERR_IMAGE_READ, ERR_IMAGE_WRITE, ERR_WARP.
   */
  warpQuad?: (srcUri: string, quad: number[], outUri: string, quality: number, maxEdge: number) => Promise<ImageResult>;
  /** Upright JPEG copy (EXIF orientation baked into the pixels), long edge capped at maxEdge (never upscaled). */
  normalizeImage?: (srcUri: string, outUri: string, maxEdge: number, quality: number) => Promise<ImageResult>;
};

/** null on Android, on web, and in a dev client built before this module existed. */
export const VisionOcr = requireOptionalNativeModule<VisionOcrNative>('VisionOcr');

export {
  DocumentCameraView,
  isDocumentCameraAvailable,
  type DocumentCameraRef,
  type DocumentCameraViewProps,
  type CameraDetectionEvent,
  type CameraCaptureEvent,
  type CameraErrorEvent,
} from './DocumentCameraView';
