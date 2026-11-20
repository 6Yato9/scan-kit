// __tests__/ocr.test.ts
// lib/ocr has one engine on both platforms: VisionOcr.recognize from the local
// module (Apple Vision on iOS; ML Kit Latin + Tesseract Arabic on Android).
// Each suite loads lib/ocr in isolation with the native-module mock it needs.

type OcrModule = typeof import('../lib/ocr');

function loadOcr(opts: { os: 'ios' | 'android'; vision: jest.Mock | null }): OcrModule {
  let mod!: OcrModule;
  jest.isolateModules(() => {
    jest.doMock('react-native', () => ({ Platform: { OS: opts.os } }));
    jest.doMock('../modules/vision-ocr/src', () => ({
      VisionOcr: opts.vision ? { recognize: opts.vision } : null,
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../lib/ocr');
  });
  return mod;
}

const result = (text: string) => ({ text, lines: [{ text, left: 5, top: 6, width: 180, height: 20 }] });

describe.each(['ios', 'android'] as const)('%s (VisionOcr.recognize)', os => {
  test('passes the native lines straight through', async () => {
    const vision = jest.fn().mockResolvedValue(result('Hello world'));
    const ocr = loadOcr({ os, vision });
    expect(ocr.ocrAvailable()).toBe(true);
    const { text, lines } = await ocr.recognizeLines('file:///page0.jpg?v=12345');
    expect(vision).toHaveBeenCalledWith('file:///page0.jpg');
    expect(text).toBe('Hello world');
    expect(lines).toEqual([{ text: 'Hello world', left: 5, top: 6, width: 180, height: 20 }]);
  });

  test('without the native module OCR is unavailable and returns no text', async () => {
    const ocr = loadOcr({ os, vision: null });
    expect(ocr.ocrAvailable()).toBe(false);
    expect(await ocr.recognizeLines('file:///p.jpg')).toEqual({ text: '', lines: [] });
    expect(await ocr.extractDocText(['file:///p.jpg'])).toBe('');
  });

  test('extractDocText OCRs each page sequentially and joins with blank lines', async () => {
    const vision = jest.fn()
      .mockResolvedValueOnce(result('Page one'))
      .mockResolvedValueOnce(result('Page two'));
    const ocr = loadOcr({ os, vision });
    const text = await ocr.extractDocText(['file:///p0.jpg', 'file:///p1.jpg?v=9']);
    expect(text).toBe('Page one\n\nPage two');
    expect(vision).toHaveBeenNthCalledWith(1, 'file:///p0.jpg');
    expect(vision).toHaveBeenNthCalledWith(2, 'file:///p1.jpg');
  });

  test('a result without text or lines yields empty values', async () => {
    const vision = jest.fn().mockResolvedValueOnce({});
    const ocr = loadOcr({ os, vision });
    expect(await ocr.recognizeLines('file:///blank.jpg')).toEqual({ text: '', lines: [] });
  });
});
