import { saveScan } from '../lib/save-scan';

jest.mock('expo-crypto', () => ({ randomUUID: () => 'fixed-id' }));
jest.mock('../lib/files', () => ({
  copyPageWithQuality: jest.fn(async (_uri: string, docId: string, i: number) =>
    `file:///docs/${docId}/page-${i}.jpg`),
  copyPdfToStorage: jest.fn(() => 'file:///docs/fixed-id/document.pdf'),
  deleteDocumentFiles: jest.fn(),
}));
jest.mock('../lib/storage', () => ({ saveDocument: jest.fn(async () => {}) }));

const { saveDocument } = require('../lib/storage');
const { deleteDocumentFiles, copyPageWithQuality } = require('../lib/files');

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
