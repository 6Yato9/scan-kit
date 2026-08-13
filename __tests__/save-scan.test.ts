import { saveScan, indexDocText } from '../lib/save-scan';

jest.mock('expo-crypto', () => ({ randomUUID: () => 'fixed-id' }));
jest.mock('../lib/files', () => ({
  copyPageWithQuality: jest.fn(async (_uri: string, docId: string, i: number) =>
    `file:///docs/${docId}/page-${i}.jpg`),
  copyPdfToStorage: jest.fn(() => 'file:///docs/fixed-id/document.pdf'),
  deleteDocumentFiles: jest.fn(),
}));
jest.mock('../lib/storage', () => ({
  saveDocument: jest.fn(async () => {}),
  getDocuments: jest.fn(async () => []),
  updateDocument: jest.fn(async () => {}),
}));
jest.mock('../lib/ocr', () => ({
  ocrAvailable: jest.fn(() => true),
  extractDocText: jest.fn(async () => ''),
}));

const { saveDocument, getDocuments, updateDocument } = require('../lib/storage');
const { deleteDocumentFiles, copyPageWithQuality, copyPdfToStorage } = require('../lib/files');
const { ocrAvailable, extractDocText } = require('../lib/ocr');

beforeEach(() => jest.clearAllMocks());

test('saves pages in order and returns the new document id', async () => {
  const id = await saveScan({ pages: ['a.jpg', 'b.jpg'], name: 'Doc', quality: 0.9 });
  expect(id).toBe('fixed-id');
  const doc = (saveDocument as jest.Mock).mock.calls[0][0];
  expect(doc.pages).toEqual([
    'file:///docs/fixed-id/page-0.jpg',
    'file:///docs/fixed-id/page-1.jpg',
  ]);
  expect(doc.name).toBe('Doc');
});

test('cleans up partial files when a page fails', async () => {
  (copyPageWithQuality as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
  await expect(saveScan({ pages: ['a.jpg'], name: 'Doc', quality: 0.9 }))
    .rejects.toThrow('Page 1: disk full');
  expect(deleteDocumentFiles).toHaveBeenCalledWith('fixed-id');
  expect(saveDocument).not.toHaveBeenCalled();
});

test('a pdf import stores the pdf and saves no pages', async () => {
  const id = await saveScan({ pdfUri: 'tmp.pdf', name: 'Scanned PDF', quality: 0.9 });
  const doc = (saveDocument as jest.Mock).mock.calls[0][0];
  expect(id).toBe('fixed-id');
  expect(doc.pages).toEqual([]);
  expect(doc.pdfUri).toBe('file:///docs/fixed-id/document.pdf');
});

test('throws and never saves when there are no pages and no pdfUri', async () => {
  await expect(saveScan({ pages: [], name: 'Doc', quality: 0.9 }))
    .rejects.toThrow('nothing to save');
  expect(saveDocument).not.toHaveBeenCalled();
});

test('cleans up when the pdf branch fails to persist', async () => {
  (saveDocument as jest.Mock).mockRejectedValueOnce(new Error('write failed'));
  await expect(saveScan({ pdfUri: 'tmp.pdf', name: 'Doc', quality: 0.9 }))
    .rejects.toThrow('write failed');
  expect(copyPdfToStorage).toHaveBeenCalled();
  expect(deleteDocumentFiles).toHaveBeenCalledWith('fixed-id');
});

describe('indexDocText', () => {
  test('does not resurrect a document deleted during indexing', async () => {
    (extractDocText as jest.Mock).mockResolvedValueOnce('recognized text');
    (getDocuments as jest.Mock).mockResolvedValueOnce([]); // document was deleted

    await indexDocText('fixed-id', ['file:///docs/fixed-id/page-0.jpg']);

    expect(updateDocument).not.toHaveBeenCalled();
  });

  test('merges ocrText onto the current record, not a stale snapshot', async () => {
    (extractDocText as jest.Mock).mockResolvedValueOnce('recognized text');
    const currentDoc = {
      id: 'fixed-id',
      name: 'Renamed While Indexing',
      pages: ['file:///docs/fixed-id/page-0.jpg'],
      createdAt: 1,
      updatedAt: 2,
    };
    (getDocuments as jest.Mock).mockResolvedValueOnce([currentDoc]);

    await indexDocText('fixed-id', ['file:///docs/fixed-id/page-0.jpg']);

    expect(updateDocument).toHaveBeenCalledWith({
      ...currentDoc,
      ocrText: 'recognized text',
    });
  });

  test('writes nothing when OCR is unavailable', async () => {
    (ocrAvailable as jest.Mock).mockReturnValueOnce(false);

    await indexDocText('fixed-id', ['file:///docs/fixed-id/page-0.jpg']);

    expect(extractDocText).not.toHaveBeenCalled();
    expect(getDocuments).not.toHaveBeenCalled();
    expect(updateDocument).not.toHaveBeenCalled();
  });

  test('writes nothing when extractDocText returns an empty string', async () => {
    (extractDocText as jest.Mock).mockResolvedValueOnce('');

    await indexDocText('fixed-id', ['file:///docs/fixed-id/page-0.jpg']);

    expect(getDocuments).not.toHaveBeenCalled();
    expect(updateDocument).not.toHaveBeenCalled();
  });
});
