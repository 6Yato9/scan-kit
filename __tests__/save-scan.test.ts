import { saveScan, indexDocText } from '../lib/save-scan';

jest.mock('expo-crypto', () => ({ randomUUID: () => 'fixed-id' }));
jest.mock('../lib/files', () => ({
  copyPageWithQuality: jest.fn(async (_uri: string, docId: string, i: number) =>
    `file:///docs/${docId}/page-${i}.jpg`),
  copyPdfToStorage: jest.fn(() => 'file:///docs/fixed-id/document.pdf'),
  deleteDocumentFiles: jest.fn(),
  deleteDisposableTemps: jest.fn(),
}));
// updateDocumentWith runs the updater against `mockStored` (the current record),
// like the real one does under the storage lock.
let mockStored: any = null;
const mockApplied: any[] = [];
jest.mock('../lib/storage', () => ({
  saveDocument: jest.fn(async () => {}),
  updateDocumentWith: jest.fn(async (_id: string, fn: (cur: any) => any) => {
    if (!mockStored) return false;
    const patch = fn(mockStored);
    if (!patch) return false;
    mockApplied.push(patch);
    mockStored = JSON.parse(JSON.stringify({ ...mockStored, ...patch }));
    return true;
  }),
}));
jest.mock('../lib/ocr', () => ({
  ocrAvailable: jest.fn(() => true),
  extractDocText: jest.fn(async () => ''),
}));

const { saveDocument, updateDocumentWith } = require('../lib/storage');
const { deleteDocumentFiles, copyPageWithQuality, copyPdfToStorage, deleteDisposableTemps } = require('../lib/files');
const { ocrAvailable, extractDocText } = require('../lib/ocr');

beforeEach(() => {
  jest.clearAllMocks();
  mockStored = { id: 'fixed-id', name: 'Doc', pages: [] };
  mockApplied.length = 0;
});

test('new pages are saved as original — a filter is only recorded by its bake (critique #2)', async () => {
  await saveScan({ pages: ['a.jpg'], name: 'Doc', quality: 0.9 });
  const doc = (saveDocument as jest.Mock).mock.calls[0][0];
  expect(doc.filters).toBeUndefined();
  expect(doc.adjustments).toBeUndefined();
});

test('an automatic name is remembered as the default name', async () => {
  await saveScan({ pages: ['a.jpg'], name: 'Scan Nov 18, 2026 at 12.35 AM', quality: 0.9, nameIsDefault: true });
  expect((saveDocument as jest.Mock).mock.calls[0][0].defaultName).toBe('Scan Nov 18, 2026 at 12.35 AM');
  await saveScan({ pages: ['a.jpg'], name: 'ID card', quality: 0.9 });
  expect((saveDocument as jest.Mock).mock.calls[1][0].defaultName).toBeUndefined();
});

test('temp inputs are deleted once stored, and kept when the save fails', async () => {
  await saveScan({ pages: ['file:///tmp/a.jpg'], name: 'Doc', quality: 0.9 });
  expect(deleteDisposableTemps).toHaveBeenCalledWith(['file:///tmp/a.jpg']);
  (deleteDisposableTemps as jest.Mock).mockClear();
  (saveDocument as jest.Mock).mockRejectedValueOnce(new Error('full'));
  await expect(saveScan({ pages: ['file:///tmp/a.jpg'], name: 'Doc', quality: 0.9 })).rejects.toThrow();
  expect(deleteDisposableTemps).not.toHaveBeenCalled();
});

test('saves pages in order and returns the new document id and page uris', async () => {
  const result = await saveScan({ pages: ['a.jpg', 'b.jpg'], name: 'Doc', quality: 0.9 });
  expect(result.id).toBe('fixed-id');
  expect(result.pages).toEqual([
    'file:///docs/fixed-id/page-0.jpg',
    'file:///docs/fixed-id/page-1.jpg',
  ]);
  const doc = (saveDocument as jest.Mock).mock.calls[0][0];
  expect(doc.pages).toEqual(result.pages);
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
  const result = await saveScan({ pdfUri: 'tmp.pdf', name: 'Scanned PDF', quality: 0.9 });
  const doc = (saveDocument as jest.Mock).mock.calls[0][0];
  expect(result.id).toBe('fixed-id');
  expect(result.pages).toEqual([]);
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
  test('merges the recognised text onto the current record', async () => {
    (extractDocText as jest.Mock).mockResolvedValueOnce('recognized text');

    await indexDocText('fixed-id', ['file:///docs/fixed-id/page-0.jpg']);

    expect(updateDocumentWith).toHaveBeenCalledTimes(1);
    expect(mockApplied).toEqual([{ ocrText: 'recognized text' }]);
  });

  test('does not recreate a document that was deleted meanwhile', async () => {
    (extractDocText as jest.Mock).mockResolvedValueOnce('recognized text');
    mockStored = null;

    await indexDocText('fixed-id', ['file:///docs/fixed-id/page-0.jpg']);

    expect(mockApplied).toEqual([]);
    expect(saveDocument).not.toHaveBeenCalled();
  });

  test('names a document that still has its automatic name after its first strong line', async () => {
    mockStored = { id: 'fixed-id', name: 'Scan Nov 18', defaultName: 'Scan Nov 18', pages: [] };
    (extractDocText as jest.Mock).mockResolvedValueOnce('12/04/2026\nINVOICE #2026-0417\nAcme Supplies');

    await indexDocText('fixed-id', ['p0']);

    expect(mockStored.name).toBe('Invoice #2026-0417');
    expect(mockStored.defaultName).toBeUndefined();
    expect(mockStored.ocrText).toContain('Acme Supplies');
  });

  test('never renames a document the user has renamed', async () => {
    mockStored = { id: 'fixed-id', name: 'My taxes', defaultName: 'Scan Nov 18', pages: [] };
    (extractDocText as jest.Mock).mockResolvedValueOnce('INVOICE #2026-0417');

    await indexDocText('fixed-id', ['p0']);

    expect(mockStored.name).toBe('My taxes');
  });

  test('never renames a document created without an automatic name', async () => {
    mockStored = { id: 'fixed-id', name: 'ID card Nov 18', pages: [] };
    (extractDocText as jest.Mock).mockResolvedValueOnce('DRIVER LICENSE');

    await indexDocText('fixed-id', ['p0']);

    expect(mockStored.name).toBe('ID card Nov 18');
  });

  test('keeps the automatic name (and the chance to rename later) when no line reads like a title', async () => {
    mockStored = { id: 'fixed-id', name: 'Scan Nov 18', defaultName: 'Scan Nov 18', pages: [] };
    (extractDocText as jest.Mock).mockResolvedValueOnce('123 456\n$ 12.00');

    await indexDocText('fixed-id', ['p0']);

    expect(mockStored.name).toBe('Scan Nov 18');
    expect(mockStored.defaultName).toBe('Scan Nov 18');
  });

  test('writes nothing when OCR is unavailable', async () => {
    (ocrAvailable as jest.Mock).mockReturnValueOnce(false);

    await indexDocText('fixed-id', ['file:///docs/fixed-id/page-0.jpg']);

    expect(extractDocText).not.toHaveBeenCalled();
    expect(updateDocumentWith).not.toHaveBeenCalled();
  });

  test('writes nothing when no text is found and the document had none', async () => {
    (extractDocText as jest.Mock).mockResolvedValueOnce('');

    await indexDocText('fixed-id', ['file:///docs/fixed-id/page-0.jpg']);

    expect(mockApplied).toEqual([]);
  });

  // r6 code review #6: replacing the only text page with a blank one left the
  // old text in the index, so search still found the document by those words.
  test('clears the old text when the newest pass finds none', async () => {
    mockStored = { id: 'fixed-id', name: 'Doc', pages: [], ocrText: 'Invoice 42 Acme' };
    (extractDocText as jest.Mock).mockResolvedValueOnce('\n\n'); // two blank pages

    await indexDocText('fixed-id', ['p0', 'p1']);

    expect(mockApplied).toEqual([{ ocrText: '' }]);
    expect(mockStored.ocrText).toBe('');
    expect(mockStored.name).toBe('Doc');
  });

  test('an older pass that finds nothing never clears a newer pass\'s text', async () => {
    mockStored = { id: 'fixed-id', name: 'Doc', pages: [], ocrText: 'old' };
    let finishOld!: (t: string) => void;
    (extractDocText as jest.Mock)
      .mockReturnValueOnce(new Promise<string>(r => { finishOld = r; }))
      .mockResolvedValueOnce('new text');

    const older = indexDocText('fixed-id', ['p0']);
    await indexDocText('fixed-id', ['p0']);
    finishOld('');
    await older;

    expect(mockStored.ocrText).toBe('new text');
  });
});
