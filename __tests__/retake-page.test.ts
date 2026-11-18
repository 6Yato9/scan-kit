// Retake page: the new capture replaces the page in place, its shadow is
// dropped, per-page metadata is reset at that index only, and Undo restores the
// old pixels and shadow exactly. Runs against an in-memory file system holding
// fake image bytes, so the assertions are about which bytes end up where.

const mockFs = new Map<string, string>(); // uri -> contents
jest.mock('expo-file-system', () => {
  const part = (p: any) => (p && typeof p === 'object' ? p.uri : p);
  class MockFile {
    uri: string;
    constructor(dir: any, name?: string) { this.uri = name ? `${part(dir)}/${name}` : String(part(dir)); }
    get exists() { return mockFs.has(this.uri); }
    delete() { mockFs.delete(this.uri); }
  }
  class MockDirectory {
    uri: string;
    constructor(...parts: any[]) { this.uri = parts.map(part).join('/'); }
    get exists() { return [...mockFs.keys()].some(k => k.startsWith(`${this.uri}/`)); }
    delete() { for (const k of [...mockFs.keys()]) if (k.startsWith(`${this.uri}/`)) mockFs.delete(k); }
  }
  return { File: MockFile, Directory: MockDirectory, Paths: { document: { uri: 'file:///docs' }, cache: { uri: 'file:///cache' } } };
});

const root = 'file:///docs/scan-kit';
const pageUri = (doc: string, i: number) => `${root}/${doc}/page-${i}.jpg`;
const origUri = (doc: string, i: number) => `${root}/${doc}/page-${i}.orig.jpg`;
let mockLayout = 0;
const mockDeleteTemps = jest.fn((uris: string[]) => uris.forEach(u => mockFs.delete(u)));

jest.mock('../lib/files', () => ({
  // "Re-encodes" by tagging the bytes with the quality, so the test can see the
  // page went through the quality step.
  copyPageWithQuality: jest.fn(async (src: string, doc: string, i: number, q: number) => {
    const bytes = mockFs.get(src);
    if (bytes === undefined) throw new Error('no source');
    mockFs.set(pageUri(doc, i), `${bytes}@q${q}`);
    return pageUri(doc, i);
  }),
  replacePage: jest.fn((src: string, doc: string, i: number) => {
    mockFs.set(pageUri(doc, i), mockFs.get(src)!);
    return pageUri(doc, i);
  }),
  copyPageWithShadow: jest.fn((src: string, doc: string, i: number) => {
    mockFs.set(pageUri(doc, i), mockFs.get(src)!);
    mockFs.delete(origUri(doc, i));
    const shadow = src.replace(/\.jpg$/, '.orig.jpg');
    if (mockFs.has(shadow)) mockFs.set(origUri(doc, i), mockFs.get(shadow)!);
    return pageUri(doc, i);
  }),
  restorePageWithShadow: jest.fn((src: string, doc: string, i: number) => {
    if (!mockFs.has(src)) throw new Error('saved copy is gone');
    mockFs.set(pageUri(doc, i), mockFs.get(src)!);
    mockFs.delete(origUri(doc, i));
    const shadow = src.replace(/\.jpg$/, '.orig.jpg');
    if (mockFs.has(shadow)) mockFs.set(origUri(doc, i), mockFs.get(shadow)!);
    return pageUri(doc, i);
  }),
  pageLayoutGeneration: () => mockLayout,
  deleteDisposableTemps: (uris: string[]) => mockDeleteTemps(uris),
  isScannerOutput: (uri: string) => /DOCUMENT_SCAN_/.test(uri),
}));

jest.mock('../lib/page-undo', () => ({
  stashPage: jest.fn((doc: string, i: number) => {
    const stash = 'file:///cache/page-undo/1/page-0.jpg';
    mockFs.set(stash, mockFs.get(pageUri(doc, i))!);
    const o = origUri(doc, i);
    if (mockFs.has(o)) mockFs.set('file:///cache/page-undo/1/page-0.orig.jpg', mockFs.get(o)!);
    return stash;
  }),
}));

let mockDoc: any;
const mockUpdate = jest.fn(async (d: any) => { mockDoc = d; return true; });
jest.mock('../lib/storage', () => ({
  getDocument: jest.fn(async () => mockDoc),
  updateDocument: (d: any) => mockUpdate(d),
}));
const mockEdits: unknown[] = [];
let mockPending = new Map<number, unknown>();
const mockBakePage = jest.fn(async (..._args: unknown[]) => true);
jest.mock('../lib/bake', () => ({
  runPageEdit: (_id: string, edit: unknown, fn: () => unknown) => { mockEdits.push(edit); return Promise.resolve().then(fn); },
  pendingBakesFor: () => mockPending,
  bakePage: (...args: unknown[]) => mockBakePage(...args),
}));
const mockAutoCrop = jest.fn(async (uri: string) => {
  const out = uri.replace('photo', 'cropped');
  mockFs.set(out, `cropped(${mockFs.get(uri)})`);
  return { uri: out, detected: true };
});
jest.mock('../lib/document-detect', () => ({ autoCropDocument: (uri: string) => mockAutoCrop(uri) }));

import { RetakeError, retakePage, undoRetake } from '../lib/retake-page';

const SCAN = 'file:///tmp/DOCUMENT_SCAN_0_new.jpg';
const PHOTO = 'file:///Caches/ImagePicker/photo-1.jpg';

beforeEach(() => {
  jest.clearAllMocks();
  mockFs.clear();
  mockLayout = 0;
  mockPending = new Map();
  mockEdits.length = 0;
  for (let i = 0; i < 3; i++) mockFs.set(pageUri('d1', i), `page${i}-enhanced`);
  mockFs.set(origUri('d1', 1), 'page1-raw');
  mockDoc = {
    id: 'd1',
    name: 'Lease',
    pages: [0, 1, 2].map(i => pageUri('d1', i)),
    filters: ['enhanced', 'enhanced', 'bw'],
    adjustments: [
      { brightness: 0, contrast: 0, saturation: 0 },
      { brightness: 20, contrast: 0, saturation: 0 },
      { brightness: 0, contrast: 0, saturation: 0 },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
  mockFs.set(SCAN, 'NEWSCAN');
  mockFs.set(PHOTO, 'NEWPHOTO');
});

test('replaces the page in place, at the scan quality, without touching the others', async () => {
  const { doc } = await retakePage('d1', 1, SCAN, 0.75);
  expect(mockFs.get(pageUri('d1', 1))).toBe('NEWSCAN@q0.75');
  expect(mockFs.get(pageUri('d1', 0))).toBe('page0-enhanced');
  expect(mockFs.get(pageUri('d1', 2))).toBe('page2-enhanced');
  expect(doc.pages).toEqual([0, 1, 2].map(i => pageUri('d1', i)));
  expect(mockUpdate).toHaveBeenCalledTimes(1);
  // The bake queue is told which page's pixels changed.
  expect(mockEdits).toEqual([{ pages: [1] }]);
});

test('drops the old shadow so the next bake starts from the new pixels', async () => {
  await retakePage('d1', 1, SCAN, 0.9);
  expect(mockFs.has(origUri('d1', 1))).toBe(false);
});

test('resets filter and adjustment for that page only', async () => {
  const { doc } = await retakePage('d1', 1, SCAN, 0.9);
  expect(doc.filters).toEqual(['enhanced', 'original', 'bw']);
  expect(doc.adjustments).toBeUndefined(); // the only non-default one was page 2's
});

test('library photos are auto-cropped first; scanner output is not', async () => {
  await retakePage('d1', 0, PHOTO, 0.9);
  expect(mockAutoCrop).toHaveBeenCalledWith(PHOTO);
  expect(mockFs.get(pageUri('d1', 0))).toBe('cropped(NEWPHOTO)@q0.9');
  mockAutoCrop.mockClear();
  await retakePage('d1', 2, SCAN, 0.9);
  expect(mockAutoCrop).not.toHaveBeenCalled();
});

test('temp inputs and the staging copy are cleaned up', async () => {
  await retakePage('d1', 0, PHOTO, 0.9);
  expect(mockDeleteTemps).toHaveBeenCalledWith([PHOTO, 'file:///Caches/ImagePicker/cropped-1.jpg']);
  expect([...mockFs.keys()].some(k => k.includes('.retake-staging'))).toBe(false);
});

test('a page that no longer exists is refused and nothing changes', async () => {
  await expect(retakePage('d1', 5, SCAN, 0.9)).rejects.toThrow('no longer exists');
  expect(mockUpdate).not.toHaveBeenCalled();
  expect(mockFs.get(origUri('d1', 1))).toBe('page1-raw');
});

test('a failed encode leaves the page and its shadow untouched', async () => {
  mockFs.delete(SCAN); // unreadable source
  await expect(retakePage('d1', 1, SCAN, 0.9)).rejects.toThrow();
  expect(mockFs.get(pageUri('d1', 1))).toBe('page1-enhanced');
  expect(mockFs.get(origUri('d1', 1))).toBe('page1-raw');
  expect(mockUpdate).not.toHaveBeenCalled();
});

test('undo puts the old pixels, shadow, filter and adjustment back', async () => {
  const { undo } = await retakePage('d1', 1, SCAN, 0.9);
  expect(undo).toEqual({
    stash: expect.any(String),
    filter: 'enhanced',
    adjustment: { brightness: 20, contrast: 0, saturation: 0 },
    layout: 0,
  });
  const restored = await undoRetake('d1', 1, undo!);
  expect(mockFs.get(pageUri('d1', 1))).toBe('page1-enhanced');
  expect(mockFs.get(origUri('d1', 1))).toBe('page1-raw');
  expect(restored.filters).toEqual(['enhanced', 'enhanced', 'bw']);
  expect(restored.adjustments?.[1]).toEqual({ brightness: 20, contrast: 0, saturation: 0 });
});

test('works on a document with no per-page metadata yet', async () => {
  mockDoc = { ...mockDoc, filters: undefined, adjustments: undefined };
  const { doc } = await retakePage('d1', 0, SCAN, 0.9);
  expect(doc.filters).toBeUndefined();
  expect(doc.adjustments).toBeUndefined();
});

test('undo is refused once the pages have been reordered or deleted (critique M1)', async () => {
  const { undo } = await retakePage('d1', 1, SCAN, 0.9);
  mockUpdate.mockClear();
  mockLayout++; // a reorder: index 1 is now another page
  const err = await undoRetake('d1', 1, undo!).catch(e => e);
  expect(err).toBeInstanceOf(RetakeError);
  expect(err.kind).toBe('pages-moved');
  expect(mockFs.get(pageUri('d1', 1))).toBe('NEWSCAN@q0.9');
  expect(mockUpdate).not.toHaveBeenCalled();
});

test('undo is refused, touching nothing, when the saved copy is gone (critique M2)', async () => {
  const { undo } = await retakePage('d1', 1, SCAN, 0.9);
  mockUpdate.mockClear();
  mockFs.delete(undo!.stash); // iOS purged Caches, or a later delete replaced the stash
  const err = await undoRetake('d1', 1, undo!).catch(e => e);
  expect(err).toBeInstanceOf(RetakeError);
  expect(err.kind).toBe('expired');
  expect(mockFs.get(pageUri('d1', 1))).toBe('NEWSCAN@q0.9');
  expect(mockUpdate).not.toHaveBeenCalled();
});

test('a filter bake already running for the page is superseded by "original" (critique L2)', async () => {
  mockPending = new Map([[1, { filter: 'bw', adjustment: undefined }]]);
  await retakePage('d1', 1, SCAN, 0.9);
  expect(mockBakePage).toHaveBeenCalledWith('d1', 1, 'original', undefined);
});

test('no extra bake when nothing was running for the page', async () => {
  mockPending = new Map([[2, { filter: 'bw', adjustment: undefined }]]);
  await retakePage('d1', 1, SCAN, 0.9);
  expect(mockBakePage).not.toHaveBeenCalled();
});
