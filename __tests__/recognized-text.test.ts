// __tests__/recognized-text.test.ts
// Saving a correction from the Recognized text sheet (lib/recognized-text.ts).

const mockDocs: any[] = [];
const mockRecognize = jest.fn();
const mockWrite = jest.fn();
const mockIndex = jest.fn();

jest.mock('../lib/storage', () => ({ getDocuments: async () => mockDocs }));
jest.mock('../lib/image', () => ({ pageFileUri: (id: string, i: number) => `file:///docs/scan-kit/${id}/page-${i}.jpg` }));
jest.mock('../lib/ocr', () => ({ recognizeLines: (uri: string) => mockRecognize(uri) }));
jest.mock('../lib/ocr-cache', () => ({ writeOcrCorrection: (uri: string, text: string) => mockWrite(uri, text) }));
jest.mock('../lib/save-scan', () => ({ indexDocText: (id: string, pages: string[]) => mockIndex(id, pages) }));
jest.mock('../lib/bake', () => ({ withDocLock: (_id: string, fn: () => unknown) => Promise.resolve().then(fn) }));

import { normalizeRecognizedText, saveRecognizedText } from '../lib/recognized-text';

const DOC = { id: 'd1', pages: ['p0', 'p1'] };

beforeEach(() => {
  mockDocs.length = 0;
  mockDocs.push({ ...DOC });
  mockRecognize.mockReset().mockResolvedValue({ text: 'x', lines: [] });
  mockWrite.mockReset().mockReturnValue(true);
  mockIndex.mockReset().mockResolvedValue(undefined);
});

test('normalizes line breaks and trailing spaces', () => {
  expect(normalizeRecognizedText('  Invoice 42  \r\nTotal \t\r\n\n')).toBe('Invoice 42\nTotal');
});

test('stores the correction for the page and refreshes the search text', async () => {
  expect(await saveRecognizedText('d1', 1, 'Invoice 42 \n')).toBe(true);
  // The page is read first, so its current pixels have an entry to correct.
  expect(mockRecognize).toHaveBeenCalledWith('file:///docs/scan-kit/d1/page-1.jpg');
  expect(mockWrite).toHaveBeenCalledWith('file:///docs/scan-kit/d1/page-1.jpg', 'Invoice 42');
  expect(mockIndex).toHaveBeenCalledWith('d1', ['p0', 'p1']);
});

test('a missing document, a PDF or a page out of range saves nothing', async () => {
  expect(await saveRecognizedText('gone', 0, 'a')).toBe(false);
  mockDocs[0].pdfUri = 'file:///x.pdf';
  expect(await saveRecognizedText('d1', 0, 'a')).toBe(false);
  delete mockDocs[0].pdfUri;
  expect(await saveRecognizedText('d1', 5, 'a')).toBe(false);
  expect(mockWrite).not.toHaveBeenCalled();
  expect(mockIndex).not.toHaveBeenCalled();
});

test('a failed write or a failing OCR reports false and never rejects', async () => {
  mockWrite.mockReturnValue(false);
  expect(await saveRecognizedText('d1', 0, 'a')).toBe(false);
  expect(mockIndex).not.toHaveBeenCalled();
  mockRecognize.mockRejectedValue(new Error('vision'));
  await expect(saveRecognizedText('d1', 0, 'a')).resolves.toBe(false);
});
