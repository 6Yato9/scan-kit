// __tests__/document-detect.test.ts
// Import must never fail because of auto-crop: every failure mode falls back
// to the original photo.

function load(native: unknown) {
  let mod!: typeof import('../lib/document-detect');
  jest.isolateModules(() => {
    jest.doMock('../modules/vision-ocr/src', () => ({ VisionOcr: native }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../lib/document-detect');
  });
  return mod;
}

test('returns the corrected image when a document is detected', async () => {
  const detectDocument = jest.fn().mockResolvedValue({ uri: 'file:///tmp/doc-1.jpg', detected: true });
  const { autoCropDocument } = load({ recognize: jest.fn(), detectDocument });
  expect(await autoCropDocument('file:///photo.jpg?v=3', 0.8)).toEqual({ uri: 'file:///tmp/doc-1.jpg', detected: true });
  expect(detectDocument).toHaveBeenCalledWith('file:///photo.jpg', 0.8);
});

test('falls back to the original when the native module is missing', async () => {
  const { autoCropDocument } = load(null);
  expect(await autoCropDocument('file:///photo.jpg')).toEqual({ uri: 'file:///photo.jpg', detected: false });
});

test('falls back when an older dev client lacks detectDocument', async () => {
  const { autoCropDocument } = load({ recognize: jest.fn() });
  expect(await autoCropDocument('file:///photo.jpg')).toEqual({ uri: 'file:///photo.jpg', detected: false });
});

test('falls back when detection throws, and keeps order across many photos', async () => {
  const detectDocument = jest.fn()
    .mockResolvedValueOnce({ uri: 'file:///tmp/a.jpg', detected: true })
    .mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValueOnce({ uri: 'file:///c.jpg', detected: false });
  const { autoCropDocuments } = load({ recognize: jest.fn(), detectDocument });
  expect(await autoCropDocuments(['file:///a.jpg', 'file:///b.jpg', 'file:///c.jpg'])).toEqual([
    'file:///tmp/a.jpg',
    'file:///b.jpg',
    'file:///c.jpg',
  ]);
});
