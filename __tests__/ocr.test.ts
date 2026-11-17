// __tests__/ocr.test.ts
// lib/ocr picks its engine at import time: Apple Vision (modules/vision-ocr) when
// that native module exists, else ML Kit on Android. Each suite loads lib/ocr in
// isolation with the platform and native-module mocks it needs.

type OcrModule = typeof import('../lib/ocr');

function fakeMlKitResult(text: string) {
  return {
    text,
    blocks: [
      {
        text,
        frame: { left: 0, top: 0, width: 200, height: 40 },
        lines: [
          { text, frame: { left: 5, top: 6, width: 180, height: 20 } },
          // A line with no frame must be skipped.
          { text: 'no-frame line' },
        ],
      },
    ],
  };
}

function loadOcr(opts: { os: 'ios' | 'android'; vision: jest.Mock | null; mlkit: jest.Mock | null }): OcrModule {
  let mod!: OcrModule;
  jest.isolateModules(() => {
    jest.doMock('react-native', () => ({ Platform: { OS: opts.os } }));
    jest.doMock('../modules/vision-ocr/src', () => ({
      VisionOcr: opts.vision ? { recognize: opts.vision } : null,
    }));
    jest.doMock('@react-native-ml-kit/text-recognition', () => ({
      __esModule: true,
      default: opts.mlkit ? { recognize: opts.mlkit } : undefined,
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../lib/ocr');
  });
  return mod;
}

describe('iOS (Apple Vision)', () => {
  test('uses Vision and passes its lines straight through', async () => {
    const vision = jest.fn().mockResolvedValue({
      text: 'Hello world',
      lines: [{ text: 'Hello world', left: 5, top: 6, width: 180, height: 20 }],
    });
    const mlkit = jest.fn();
    const ocr = loadOcr({ os: 'ios', vision, mlkit });
    expect(ocr.ocrAvailable()).toBe(true);
    const { text, lines } = await ocr.recognizeLines('file:///page0.jpg?v=12345');
    expect(vision).toHaveBeenCalledWith('file:///page0.jpg');
    expect(mlkit).not.toHaveBeenCalled();
    expect(text).toBe('Hello world');
    expect(lines).toEqual([{ text: 'Hello world', left: 5, top: 6, width: 180, height: 20 }]);
  });

  test('ML Kit is never loaded on iOS, so OCR is unavailable without Vision', async () => {
    const mlkit = jest.fn();
    const ocr = loadOcr({ os: 'ios', vision: null, mlkit });
    expect(ocr.ocrAvailable()).toBe(false);
    expect(await ocr.recognizeLines('file:///p.jpg')).toEqual({ text: '', lines: [] });
    expect(await ocr.extractDocText(['file:///p.jpg'])).toBe('');
    expect(mlkit).not.toHaveBeenCalled();
  });
});

describe('Android (ML Kit)', () => {
  test('flattens lines with frames and skips frameless lines', async () => {
    const mlkit = jest.fn().mockResolvedValueOnce(fakeMlKitResult('Hello world'));
    const ocr = loadOcr({ os: 'android', vision: null, mlkit });
    expect(ocr.ocrAvailable()).toBe(true);
    const { text, lines } = await ocr.recognizeLines('file:///page0.jpg');
    expect(text).toBe('Hello world');
    expect(lines).toEqual([{ text: 'Hello world', left: 5, top: 6, width: 180, height: 20 }]);
  });

  test('strips the ?v= cache-bust suffix before calling the engine', async () => {
    const mlkit = jest.fn().mockResolvedValueOnce(fakeMlKitResult('Cached'));
    const ocr = loadOcr({ os: 'android', vision: null, mlkit });
    await ocr.recognizeLines('file:///page0.jpg?v=12345');
    expect(mlkit).toHaveBeenCalledWith('file:///page0.jpg');
  });

  test('extractDocText OCRs each page sequentially and joins with blank lines', async () => {
    const mlkit = jest.fn()
      .mockResolvedValueOnce(fakeMlKitResult('Page one'))
      .mockResolvedValueOnce(fakeMlKitResult('Page two'));
    const ocr = loadOcr({ os: 'android', vision: null, mlkit });
    const text = await ocr.extractDocText(['file:///p0.jpg', 'file:///p1.jpg?v=9']);
    expect(text).toBe('Page one\n\nPage two');
    expect(mlkit).toHaveBeenNthCalledWith(1, 'file:///p0.jpg');
    expect(mlkit).toHaveBeenNthCalledWith(2, 'file:///p1.jpg');
  });

  test('a result with no blocks yields empty text and no lines', async () => {
    const mlkit = jest.fn().mockResolvedValueOnce({ text: '', blocks: [] });
    const ocr = loadOcr({ os: 'android', vision: null, mlkit });
    expect(await ocr.recognizeLines('file:///blank.jpg')).toEqual({ text: '', lines: [] });
  });
});
