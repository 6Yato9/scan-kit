// __tests__/add-pages.test.ts
const mockExisting = new Set<string>();
const mockDeleted: string[] = [];
jest.mock('expo-file-system', () => {
  const part = (p: any) => (p && typeof p === 'object' ? p.uri : p);
  class MockFile {
    uri: string;
    constructor(dir: any, name?: string) { this.uri = name ? `${part(dir)}/${name}` : String(part(dir)); }
    get exists() { return mockExisting.has(this.uri); }
    delete() { mockExisting.delete(this.uri); mockDeleted.push(this.uri); }
  }
  class MockDirectory {
    uri: string;
    constructor(...parts: any[]) { this.uri = parts.map(part).join('/'); }
  }
  return { File: MockFile, Directory: MockDirectory, Paths: { document: { uri: 'file:///docs' } } };
});

const mockCopyPage = jest.fn(async (_uri: string, docId: string, i: number) => {
  const uri = `file:///docs/scan-kit/${docId}/page-${i}.jpg`;
  mockExisting.add(uri);
  return uri;
});
const mockDeleteTemps = jest.fn();
jest.mock('../lib/files', () => ({
  copyPageWithQuality: (...a: [string, string, number]) => mockCopyPage(...a),
  deleteDisposableTemps: (...a: any[]) => mockDeleteTemps(...a),
  isScannerOutput: (uri: string) => /DOCUMENT_SCAN_/.test(uri),
}));

let mockDoc: any;
// Merges the patch onto the stored record, like the real updateDocumentWith.
const mockUpdate = jest.fn(async (_id: string, fn: (cur: any) => any) => {
  if (!mockDoc) return false;
  const patch = fn(mockDoc);
  if (!patch) return false;
  mockDoc = { ...mockDoc, ...patch };
  return true;
});
jest.mock('../lib/storage', () => ({
  getDocument: jest.fn(async () => mockDoc),
  updateDocumentWith: (id: string, fn: (cur: any) => any) => mockUpdate(id, fn),
}));
jest.mock('../lib/bake', () => ({
  bakePages: jest.fn(async () => {}),
  runPageEdit: (_id: string, _edit: unknown, fn: () => unknown) => Promise.resolve().then(fn),
}));
jest.mock('../lib/save-scan', () => ({ indexDocText: jest.fn(async () => {}) }));
const mockAutoCrop = jest.fn(async (uri: string) => ({ uri: uri.replace('photo', 'cropped'), detected: true }));
jest.mock('../lib/document-detect', () => ({ autoCropDocument: (uri: string) => mockAutoCrop(uri) }));

import { addPagesToDocument } from '../lib/add-pages';

const page = (i: number) => `file:///docs/scan-kit/d1/page-${i}.jpg`;

beforeEach(() => {
  jest.clearAllMocks();
  mockExisting.clear();
  mockDeleted.length = 0;
  mockDoc = { id: 'd1', name: 'Doc', pages: [page(0)], filters: ['enhanced'], createdAt: 1, updatedAt: 1 };
  mockExisting.add(page(0));
});

test('library photos are auto-cropped, scanner pages are not', async () => {
  await addPagesToDocument('d1', [
    'file:///Caches/ImagePicker/photo-1.jpg',
    'file:///docs/DOCUMENT_SCAN_0_x.jpg',
  ], 0.9);
  expect(mockAutoCrop).toHaveBeenCalledTimes(1);
  expect(mockAutoCrop).toHaveBeenCalledWith('file:///Caches/ImagePicker/photo-1.jpg');
  expect(mockCopyPage.mock.calls.map(c => c[0])).toEqual([
    'file:///Caches/ImagePicker/cropped-1.jpg',
    'file:///docs/DOCUMENT_SCAN_0_x.jpg',
  ]);
});

test('records the new pages on the current document, padded with original', async () => {
  const { doc, added } = await addPagesToDocument('d1', ['file:///docs/DOCUMENT_SCAN_0_x.jpg'], 0.9);
  expect(added).toEqual([1]);
  expect(doc.pages).toEqual([page(0), page(1)]);
  expect(doc.filters).toEqual(['enhanced', 'original']);
});

test('temps — inputs and crop output — are deleted once stored', async () => {
  await addPagesToDocument('d1', ['file:///Caches/ImagePicker/photo-1.jpg'], 0.9);
  expect(mockDeleteTemps).toHaveBeenCalledWith([
    'file:///Caches/ImagePicker/photo-1.jpg',
    'file:///Caches/ImagePicker/cropped-1.jpg',
  ]);
});

test('a failure part-way removes the pages already written, so a retry can succeed (critique #5)', async () => {
  mockCopyPage
    .mockImplementationOnce(async (_u, docId, i) => { const u = `file:///docs/scan-kit/${docId}/page-${i}.jpg`; mockExisting.add(u); return u; })
    .mockRejectedValueOnce(new Error('disk full'));
  await expect(addPagesToDocument('d1', ['a', 'b'], 0.9, { autoCrop: false })).rejects.toThrow('disk full');
  expect(mockExisting.has(page(1))).toBe(false);
  expect(mockExisting.has(page(0))).toBe(true); // existing page untouched
  expect(mockUpdate).not.toHaveBeenCalled();
  expect(mockDeleteTemps).not.toHaveBeenCalled();
});

test('a stale shadow at a new index is removed before the page lands there', async () => {
  mockExisting.add('file:///docs/scan-kit/d1/page-1.orig.jpg');
  await addPagesToDocument('d1', ['x'], 0.9, { autoCrop: false });
  expect(mockDeleted).toContain('file:///docs/scan-kit/d1/page-1.orig.jpg');
});

test('fails cleanly when the document was deleted meanwhile', async () => {
  mockDoc = null;
  await expect(addPagesToDocument('d1', ['x'], 0.9, { autoCrop: false })).rejects.toThrow('document missing');
  expect(mockCopyPage).not.toHaveBeenCalled();
});

test('writes only the page fields, so a rename or text index stored meanwhile survives', async () => {
  await addPagesToDocument('d1', ['x'], 0.9, { autoCrop: false });
  const patch = mockUpdate.mock.calls[0][1]({ ...mockDoc, name: 'Invoice', ocrText: 'text' });
  expect(Object.keys(patch).sort()).toEqual(['adjustments', 'filters', 'pages', 'updatedAt']);
  expect(patch.name).toBeUndefined();
});
