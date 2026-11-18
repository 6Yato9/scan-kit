// Scan Kit's own document camera (iOS, native view `DocumentCameraView` of
// the VisionOcr module): live preview, native page-outline overlay and
// steady-page auto-capture. Every capture keeps the ORIGINAL full photo plus
// the detected outline, so a crop can later be widened as well as narrowed.
//
// The native view draws only the camera and the outline: buttons, hints and
// the auto-capture progress ring belong in React Native (use onDetection).
//
// `DocumentCameraView` is null when this build doesn't register the view
// (older dev clients, Android, web): check `isDocumentCameraAvailable()`.
import { requireNativeView } from 'expo';
import type { Ref } from 'react';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';

/** [x0,y0, x1,y1, x2,y2, x3,y3]: TL, TR, BR, BL, normalised 0..1, top-left origin, upright. */
export type CameraQuad = number[];

export type CameraDetectionEvent = {
  /** The outline drawn on screen (smoothed), in the preview image's normalised space; null when none. */
  quad: CameraQuad | null;
  /** 0..1 progress toward auto-capture (0 while auto-capture is disarmed after a shot). */
  stability: number;
};

export type CameraCaptureEvent = {
  /** file:// URI of the full, upright JPEG (q 0.92) in Caches/scanner-src/. The caller owns it. */
  sourceUri: string;
  width: number;
  height: number;
  /**
   * Page outline in the photo (detected on the still; else the last steady
   * live outline), same convention as VisionOcr.detectQuad. null when none.
   */
  quad: CameraQuad | null;
};

export type CameraErrorEvent = {
  /** 'permission': access denied/restricted; 'unavailable': no camera (or unreadable simulator image); 'failed': anything else. */
  code: 'permission' | 'unavailable' | 'failed';
  message: string;
};

export type DocumentCameraViewProps = ViewProps & {
  /** Fire the shutter by itself once a page holds steady (~1 s). Default true. */
  autoCapture?: boolean;
  /** Default 'auto'. */
  flash?: 'off' | 'on' | 'auto';
  /** Default false. */
  torch?: boolean;
  /** false pauses the camera session (it also stops while the app is in the background). Default true. */
  active?: boolean;
  /** Run on this still image instead of the camera (simulator, tests). */
  simulatorImageUri?: string;
  /** ~8 Hz. */
  onDetection?: (e: NativeSyntheticEvent<CameraDetectionEvent>) => void;
  /** The shutter fired (auto or manual); the page arrives in onCapture shortly after. */
  onCaptureStart?: (e: NativeSyntheticEvent<Record<string, never>>) => void;
  onCapture?: (e: NativeSyntheticEvent<CameraCaptureEvent>) => void;
  onCameraError?: (e: NativeSyntheticEvent<CameraErrorEvent>) => void;
  ref?: Ref<DocumentCameraRef>;
};

export type DocumentCameraRef = {
  /**
   * Manual shutter. Resolves (undefined) after the page was delivered via
   * onCapture — handle the page there, not here. Rejects with code
   * 'not-running', 'busy' (a capture is in flight) or 'failed'.
   */
  capture(): Promise<void>;
};

type ExpoGlobal = { getViewConfig?: (moduleName: string, viewName?: string) => unknown };

export const DOCUMENT_CAMERA_VIEW_NAME = 'DocumentCameraView';

/** Whether this build registers the native document camera view. */
export function isDocumentCameraAvailable(
  expo: ExpoGlobal | undefined = (globalThis as { expo?: ExpoGlobal }).expo,
): boolean {
  try {
    return !!expo?.getViewConfig?.('VisionOcr', DOCUMENT_CAMERA_VIEW_NAME);
  } catch {
    return false;
  }
}

function load(): React.ComponentType<DocumentCameraViewProps> | null {
  if (!isDocumentCameraAvailable()) return null;
  try {
    return requireNativeView<DocumentCameraViewProps>('VisionOcr', DOCUMENT_CAMERA_VIEW_NAME);
  } catch {
    return null;
  }
}

export const DocumentCameraView = load();
