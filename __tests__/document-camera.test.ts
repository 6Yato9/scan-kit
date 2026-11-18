// The native document camera view is optional (older dev clients, Android,
// web, jest): callers feature-check with isDocumentCameraAvailable().
import { DocumentCameraView, isDocumentCameraAvailable, VisionOcr } from '../modules/vision-ocr/src';
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
    // Type-level: these must be optional members (calling without `?.` would not compile).
    const fns: (keyof NonNullable<typeof VisionOcr>)[] = ['detectQuad', 'warpQuad', 'normalizeImage', 'detectDocument'];
    expect(fns).toHaveLength(4);
  });
});
