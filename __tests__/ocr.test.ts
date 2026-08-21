// __tests__/ocr.test.ts
import TextRecognition from '@react-native-ml-kit/text-recognition';
import { ocrAvailable, recognizeLines, extractDocText } from '../lib/ocr';

jest.mock('@react-native-ml-kit/text-recognition', () => ({
  __esModule: true,
  default: {
    recognize: jest.fn(),
  },
}));

const mockRecognize = (TextRecognition as any).recognize as jest.Mock;

function fakeResult(text: string) {
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

beforeEach(() => {
  jest.clearAllMocks();
});

test('ocrAvailable is true when the native module mock is present', () => {
  expect(ocrAvailable()).toBe(true);
});

test('recognizeLines flattens lines with frames and returns text', async () => {
  mockRecognize.mockResolvedValueOnce(fakeResult('Hello world'));
  const { text, lines } = await recognizeLines('file:///page0.jpg');
  expect(text).toBe('Hello world');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toEqual({ text: 'Hello world', left: 5, top: 6, width: 180, height: 20 });
});

test('recognizeLines strips ?v= cache-bust suffix before calling recognize', async () => {
  mockRecognize.mockResolvedValueOnce(fakeResult('Cached'));
  await recognizeLines('file:///page0.jpg?v=12345');
  expect(mockRecognize).toHaveBeenCalledWith('file:///page0.jpg');
});

test('extractDocText OCRs each page sequentially and joins with blank lines', async () => {
  mockRecognize
    .mockResolvedValueOnce(fakeResult('Page one'))
    .mockResolvedValueOnce(fakeResult('Page two'));
  const text = await extractDocText(['file:///p0.jpg', 'file:///p1.jpg?v=9']);
  expect(text).toBe('Page one\n\nPage two');
  expect(mockRecognize).toHaveBeenCalledTimes(2);
  expect(mockRecognize).toHaveBeenNthCalledWith(1, 'file:///p0.jpg');
  expect(mockRecognize).toHaveBeenNthCalledWith(2, 'file:///p1.jpg');
});

test('recognizeLines handles a result with no blocks gracefully', async () => {
  mockRecognize.mockResolvedValueOnce({ text: '', blocks: [] });
  const { text, lines } = await recognizeLines('file:///blank.jpg');
  expect(text).toBe('');
  expect(lines).toEqual([]);
});
