// Sign / Watermark / Timestamp in place (lib/page-stamp.ts): the mark goes into
// the page AND its .orig shadow, every touched page is stashed first, Undo
// puts pixels, shadow, filter and adjustment back exactly, a failure part-way
// rolls the earlier pages back, and a reorder since makes Undo refuse.
// Runs against an in-memory file system of fake image bytes.

const mockFs = new Map<string, string>(); // uri -> contents
jest.mock('expo-file-system', () => {
  const part = (p: any) => (p && typeof p === 'object' ? p.uri : p);
  class MockFile {
    uri: string;
    constructor(...parts: any[]) { this.uri = parts.map(part).join('/'); }
    get exists() { return mockFs.has(this.uri); }
    delete() { mockFs.delete(this.uri); }
    copy(dest: any) { mockFs.set(dest.uri, mockFs.get(this.uri)!); }
  }
  class MockDirectory {
    uri: string;
    constructor(...parts: any[]) { this.uri = parts.map(part).join('/'); }
    get exists() { return [...mockFs.keys()].some(k => k.startsWith(`${this.uri}/`)); }
    create() {}
    delete() { for (const k of [...mockFs.keys()]) if (k.startsWith(`${this.uri}/`)) mockFs.delete(k); }
  }
  return { File: MockFile, Directory: MockDirectory, Paths: { document: { uri: 'file:///docs' }, cache: { uri: 'file:///cache' } } };
});
jest.mock('expo-file-system/legacy', () => ({
  writeAsStringAsync: jest.fn(async (uri: string, b64: string) => { mockFs.set(uri, `b64:${b64}`); }),
}));

const root = 'file:///docs/scan-kit';
const pageUri = (doc: string, i: number) => `${root}/${doc}/page-${i}.jpg`;
const origUri = (doc: string, i: number) => `${root}/${doc}/page-${i}.orig.jpg`;
let mockLayout = 0;

jest.mock('../lib/files', () => ({
  originalUri: (doc: string, i: number) => origUri(doc, i),
  pageSideUri: (doc: string, i: number) => `${root}/${doc}/page-${i}.new.jpg`,
  originalSideUri: (doc: string, i: number) => `${root}/${doc}/page-${i}.orig.new.jpg`,
  promotePageSide: (doc: string, i: number) => {
    const side = `${root}/${doc}/page-${i}.new.jpg`;
    mockFs.set(pageUri(doc, i), mockFs.get(side)!);
    mockFs.delete(side);
  },
  promoteOriginalSide: (doc: string, i: number) => {
    const side = `${root}/${doc}/page-${i}.orig.new.jpg`;
    mockFs.set(origUri(doc, i), mockFs.get(side)!);
    mockFs.delete(side);
  },
  restorePageWithShadow: (src: string, doc: string, i: number) => {
    if (!mockFs.has(src)) throw new Error('saved copy is gone');
    mockFs.set(pageUri(doc, i), mockFs.get(src)!);
    mockFs.delete(origUri(doc, i));
    const shadow = src.replace(/\.jpg$/, '.orig.jpg');
    if (mockFs.has(shadow)) mockFs.set(origUri(doc, i), mockFs.get(shadow)!);
    return pageUri(doc, i);
  },
  pageLayoutGeneration: () => mockLayout,
  deleteDocumentFiles: jest.fn(),
}));
jest.mock('../lib/image', () => ({ pageFileUri: (doc: string, i: number) => pageUri(doc, i) }));

let mockDoc: any;
const mockUpdate = jest.fn(async (d: any) => { mockDoc = d; return true; });
const mockPatch = jest.fn(async (_id: string, p: any) => { mockDoc = { ...mockDoc, ...p }; return true; });
jest.mock('../lib/storage', () => ({
  getDocument: jest.fn(async () => mockDoc),
  updateDocument: (d: any) => mockUpdate(d),
  patchDocument: (id: string, p: any) => mockPatch(id, p),
  deleteDocument: jest.fn(async () => {}),
}));
const mockEdits: unknown[] = [];
const mockBakePage = jest.fn(async (..._args: unknown[]) => true);
jest.mock('../lib/bake', () => ({
  runPageEdit: (_id: string, edit: unknown, fn: () => unknown) => { mockEdits.push(edit); return Promise.resolve().then(fn); },
  withDocLock: (_id: string, fn: () => unknown) => Promise.resolve().then(fn),
  waitForPendingBakes: jest.fn(async () => 'done'),
  bakePage: (...args: unknown[]) => mockBakePage(...args),
}));
const mockIndex = jest.fn(async (..._args: unknown[]) => {});
jest.mock('../lib/save-scan', () => ({ indexDocText: (...a: unknown[]) => mockIndex(...a) }));
jest.mock('../lib/doc-ops', () => ({ duplicateDocument: jest.fn() }));

import { lookOf, stampPages, StampError, targetPages, undoStamp } from '../lib/page-stamp';

/** A fake renderer: "draws" the mark by tagging the bytes it was given. */
const render = jest.fn(async (page: string, orig: string | null) => ({
  page: `data:image/jpeg;base64,SIGNED(${mockFs.get(page)})`,
  orig: orig ? `data:image/jpeg;base64,SIGNED(${mockFs.get(orig)})` : null,
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockFs.clear();
  mockLayout = 0;
  mockEdits.length = 0;
  for (let i = 0; i < 3; i++) mockFs.set(pageUri('d1', i), `page${i}-enhanced`);
  mockFs.set(origUri('d1', 1), 'page1-raw');
  mockFs.set(origUri('d1', 2), 'page2-raw');
  mockDoc = {
    id: 'd1',
    name: 'Lease',
    pages: [0, 1, 2].map(i => pageUri('d1', i)),
    filters: ['original', 'enhanced', 'bw'],
    adjustments: [
      { brightness: 0, contrast: 0, saturation: 0 },
      { brightness: 20, contrast: 0, saturation: 0 },
      { brightness: 0, contrast: 0, saturation: 0 },
    ],
    ocrText: 'Lease',
    createdAt: 1,
    updatedAt: 1,
  };
});

describe('targetPages', () => {
  test('one page, clamped; or every page', () => {
    expect(targetPages(3, 1, false)).toEqual([1]);
    expect(targetPages(3, 9, false)).toEqual([2]);
    expect(targetPages(3, -1, false)).toEqual([0]);
    expect(targetPages(3, 0, true)).toEqual([0, 1, 2]);
    expect(targetPages(0, 0, true)).toEqual([]);
  });
});

test('draws into the page and its shadow, and tells the bake queue which page changed', async () => {
  const { undo } = await stampPages('d1', [1], render);
  expect(mockFs.get(pageUri('d1', 1))).toBe('b64:SIGNED(page1-enhanced)');
  // The shadow carries the mark too, so a later filter change keeps it.
  expect(mockFs.get(origUri('d1', 1))).toBe('b64:SIGNED(page1-raw)');
  expect(mockFs.get(pageUri('d1', 0))).toBe('page0-enhanced');
  expect(mockEdits).toEqual([{ pages: [1] }]);
  expect(undo?.pages.map(p => p.index)).toEqual([1]);
  // The text index is refreshed (only changed pages are read again: ocr-cache).
  expect(mockIndex).toHaveBeenCalledWith('d1', mockDoc.pages);
  // The document stays image pages, with its filters.
  expect(mockDoc.pdfUri).toBeUndefined();
  expect(mockDoc.filters).toEqual(['original', 'enhanced', 'bw']);
});

test('a page without a shadow gets the mark on the page only', async () => {
  await stampPages('d1', [0], render);
  expect(mockFs.get(pageUri('d1', 0))).toBe('b64:SIGNED(page0-enhanced)');
  expect(mockFs.has(origUri('d1', 0))).toBe(false);
});

test('Undo restores pixels, shadows, filters and adjustments exactly, once', async () => {
  const { undo } = await stampPages('d1', [0, 1, 2], render);
  // A filter change after signing (recorded on the doc) is rolled back with it.
  mockDoc = { ...mockDoc, filters: ['grayscale', 'grayscale', 'grayscale'] };
  await undoStamp(undo!);
  expect(mockFs.get(pageUri('d1', 0))).toBe('page0-enhanced');
  expect(mockFs.get(pageUri('d1', 1))).toBe('page1-enhanced');
  expect(mockFs.get(origUri('d1', 1))).toBe('page1-raw');
  expect(mockFs.get(origUri('d1', 2))).toBe('page2-raw');
  expect(mockFs.has(origUri('d1', 0))).toBe(false);
  expect(mockDoc.filters).toEqual(['original', 'enhanced', 'bw']);
  expect(mockDoc.adjustments[1]).toEqual({ brightness: 20, contrast: 0, saturation: 0 });
  // The stash is single use.
  await expect(undoStamp(undo!)).rejects.toMatchObject({ kind: 'expired' });
});

test('Undo refuses after the pages were reordered or deleted, touching nothing', async () => {
  const { undo } = await stampPages('d1', [1], render);
  mockLayout = 1;
  await expect(undoStamp(undo!)).rejects.toBeInstanceOf(StampError);
  expect(mockFs.get(pageUri('d1', 1))).toBe('b64:SIGNED(page1-enhanced)');
});

test('a failure part-way puts the pages already done back', async () => {
  render.mockImplementationOnce(render.getMockImplementation()!);
  render.mockImplementationOnce(async () => { throw new Error('webview died'); });
  await expect(stampPages('d1', [0, 1], render)).rejects.toThrow('webview died');
  expect(mockFs.get(pageUri('d1', 0))).toBe('page0-enhanced');
  expect(mockFs.get(pageUri('d1', 1))).toBe('page1-enhanced');
});

test('refuses to stamp a page whose shadow came back unstamped', async () => {
  render.mockImplementationOnce(async () => ({ page: 'data:image/jpeg;base64,X', orig: null }));
  await expect(stampPages('d1', [1], render)).rejects.toMatchObject({ kind: 'render' });
  expect(mockFs.get(pageUri('d1', 1))).toBe('page1-enhanced');
  expect(mockFs.get(origUri('d1', 1))).toBe('page1-raw');
});

test('pages that no longer exist are skipped; none at all is an error', async () => {
  await expect(stampPages('d1', [7], render)).rejects.toMatchObject({ kind: 'missing-page' });
  await stampPages('d1', [2, 7, 2], render);
  expect(render).toHaveBeenCalledTimes(1);
});

test('without undo nothing is stashed (Save as a copy)', async () => {
  const { undo } = await stampPages('d1', [1], render, { undo: false });
  expect(undo).toBeNull();
  expect([...mockFs.keys()].some(k => k.includes('stamp-undo'))).toBe(false);
});

test('lookOf tells a re-filtered page apart', () => {
  expect(lookOf(mockDoc, 1)).not.toBe(lookOf({ ...mockDoc, filters: ['original', 'bw', 'bw'] }, 1));
  expect(lookOf({}, 0)).toBe(JSON.stringify(['original', null]));
});
