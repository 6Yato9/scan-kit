// The native document camera view is optional (older dev clients, Android,
// web, jest): callers feature-check with isDocumentCameraAvailable().
import {
  DocumentCameraView,
  isDocumentCameraAvailable,
  VisionOcr,
  type CameraDetectionEvent,
  type CameraErrorEvent,
  type CameraStateEvent,
  type DocumentCameraRef,
} from '../modules/vision-ocr/src';
import { DOCUMENT_CAMERA_VIEW_NAME } from '../modules/vision-ocr/src/DocumentCameraView';

describe('isDocumentCameraAvailable', () => {
  it('asks for the named camera view of the VisionOcr module, not the default (PDF) view', () => {
    const getViewConfig = jest.fn((module: string, view?: string) =>
      module === 'VisionOcr' && view === 'DocumentCameraView' ? { validAttributes: {} } : null,
    );
    expect(isDocumentCameraAvailable({ getViewConfig })).toBe(true);
    expect(getViewConfig).toHaveBeenCalledWith('VisionOcr', DOCUMENT_CAMERA_VIEW_NAME);
  });

  it('is false for a build that only has the PDF view', () => {
    const getViewConfig = (_m: string, view?: string) => (view === undefined ? { validAttributes: {} } : null);
    expect(isDocumentCameraAvailable({ getViewConfig })).toBe(false);
  });

  it('is false without the expo global, without getViewConfig, or when it throws', () => {
    expect(isDocumentCameraAvailable(undefined)).toBe(false);
    expect(isDocumentCameraAvailable({})).toBe(false);
    expect(
      isDocumentCameraAvailable({
        getViewConfig: () => {
          throw new Error('no view');
        },
      }),
    ).toBe(false);
  });

  it('exports a null component when the view is not registered (jest has no native views)', () => {
    expect(DocumentCameraView).toBeNull();
  });

  it('keeps the image functions optional so callers must feature-check', () => {
    // Checked by `tsc --noEmit` (tests are in the project): each line fails to
    // compile if the member stops being optional, because the directive then
    // has no error to expect. Never called at runtime.
    const callsWithoutFeatureCheck = (n: NonNullable<typeof VisionOcr>) => {
      // @ts-expect-error detectQuad is optional
      n.detectQuad('file:///p.jpg');
      // @ts-expect-error warpQuad is optional
      n.warpQuad('file:///p.jpg', [0, 0, 1, 0, 1, 1, 0, 1], 'file:///o.jpg', 0.9, 4096);
      // @ts-expect-error normalizeImage is optional
      n.normalizeImage('file:///p.jpg', 'file:///o.jpg', 4096, 0.9);
      // @ts-expect-error detectDocument is optional
      n.detectDocument('file:///p.jpg', 0.9);
    };
    expect(typeof callsWithoutFeatureCheck).toBe('function');
  });

  it('keeps the newer camera features optional on the ref and the events', () => {
    // Older builds have no rearm(), no aspect, no capture flag: tsc enforces the `?.`.
    const ref: DocumentCameraRef = { capture: async () => {} };
    expect(ref.rearm).toBeUndefined();
    const usesRearm = (r: DocumentCameraRef) => {
      // @ts-expect-error rearm is optional
      r.rearm();
    };
    expect(typeof usesRearm).toBe('function');
    const detection: CameraDetectionEvent = { quad: null, stability: 0 };
    const error: CameraErrorEvent = { code: 'failed', message: 'x' };
    const state: CameraStateEvent = { state: 'paused', reason: 'multitasking' };
    expect([detection.aspect, error.capture, state.reason]).toEqual([undefined, undefined, 'multitasking']);
  });
});
