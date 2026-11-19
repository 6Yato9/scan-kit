// Round 12b product #3: Split and Add a blank page for SCANNED documents keep
// every page's files consistent — the page, its unfiltered .orig, its source
// photo (.src.jpg) and crop (.src.json) travel together, filters and
// adjustments stay aligned, and nothing half-made is left behind.
const mockFs = new Map<string, string>();
jest.mock('expo-file-system', () => {
  const part = (p: any) => (p && typeof p === 'object' ? p.uri : p);
  class MockFile {
    uri: string;
    constructor(...parts: any[]) { this.uri = parts.map(part).join('/'); }
    get exists() { return mockFs.has(this.uri); }
    delete() { mockFs.delete(this.uri); }
    copy(dest: MockFile) { mockFs.set(dest.uri, mockFs.get(this.uri)!); }
    move(dest: MockFile) { mockFs.set(dest.uri, mockFs.get(this.uri)!); mockFs.delete(this.uri); }
    write(content: Uint8Array | string) { mockFs.set(this.uri, typeof content === 'string' ? content : `jpeg:${content.length}`); }
  }
  class MockDirectory {
    uri: string;
    constructor(...parts: any[]) { this.uri = parts.map(part).join('/'); }
    get exists() { return true; }
    create() {}
  }
  return { File: MockFile, Directory: MockDirectory, Paths: { document: 'file:///docs', cache: 'file:///caches' } };
});
let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `part-${++mockUuid}` }));
const ROOT = 'file:///docs/scan-kit';
const mockDocs = new Map<string, any>();
const mockTrash = jest.fn(async (id: string) => { const d = mockDocs.get(id); if (d) d.trashedAt = 1; return !!d; });
let mockFailSave: string | null = null;
jest.mock('../lib/storage', () => ({
  getDocument: jest.fn(async (id: string) => (mockDocs.has(id) ? { ...mockDocs.get(id) } : null)),
  saveDocument: jest.fn(async (d: any) => {
    if (mockFailSave && d.id === mockFailSave) throw new Error('disk full');
    mockDocs.set(d.id, { ...d });
  }),
  deleteDocument: jest.fn(async (id: string) => { mockDocs.delete(id); }),
  patchDocument: jest.fn(async () => true),
  trashDocument: (id: string) => mockTrash(id),
}));
jest.mock('../lib/storage-layout', () => ({
  docDir: (id: string) => new (jest.requireMock('expo-file-system').Directory)(`${ROOT}/${id}`),
}));
const SHADOWS = ['.orig.jpg', '.src.jpg', '.src.json'];
let mockLayout = 0;
jest.mock('../lib/files', () => {
  const family = ['.jpg', '.orig.jpg', '.src.jpg', '.src.json'];
  return {
    copyPageWithShadow: (src: string, destId: string, i: number) => {
      const base = src.split('?')[0].replace(/\.jpg$/, '');
      const dest = `${ROOT}/${destId}/page-${i}`;
      if (!mockFs.has(`${base}.jpg`)) throw new Error('no such page');
      mockFs.set(`${dest}.jpg`, mockFs.get(`${base}.jpg`)!);
      for (const s of ['.orig.jpg', '.src.jpg', '.src.json']) {
        mockFs.delete(`${dest}${s}`);
        if (mockFs.has(`${base}${s}`)) mockFs.set(`${dest}${s}`, mockFs.get(`${base}${s}`)!);
      }
      return `${dest}.jpg`;
    },
    deleteDocumentFiles: (id: string) => { for (const k of [...mockFs.keys()]) if (k.startsWith(`${ROOT}/${id}/`)) mockFs.delete(k); },
    copyDocumentFiles: jest.fn(),
    copyPdfToStorage: jest.fn(),
    pageLayoutGeneration: () => mockLayout,
    // The real reorder: page-i (every family member) takes old page order[i].
    reorderPages: (id: string, order: number[]) => {
      mockLayout++;
      const snap = new Map(mockFs);
      for (const s of family) for (let i = 0; i < order.length; i++) mockFs.delete(`${ROOT}/${id}/page-${i}${s}`);
      order.forEach((from, to) => {
        for (const s of family) {
          const v = snap.get(`${ROOT}/${id}/page-${from}${s}`);
          if (v !== undefined) mockFs.set(`${ROOT}/${id}/page-${to}${s}`, v);
        }
      });
      return order.map((_, i) => `${ROOT}/${id}/page-${i}.jpg`);
    },
    deleteSinglePage: (id: string, index: number, total: number) => {
      mockLayout++;
      for (const s of family) {
        mockFs.delete(`${ROOT}/${id}/page-${index}${s}`);
        for (let i = index + 1; i < total; i++) {
          const v = mockFs.get(`${ROOT}/${id}/page-${i}${s}`);
          mockFs.delete(`${ROOT}/${id}/page-${i}${s}`);
          if (v !== undefined) mockFs.set(`${ROOT}/${id}/page-${i - 1}${s}`, v);
        }
      }
    },
  };
});
jest.mock('../lib/bake', () => ({
  withDocLock: (_id: string, fn: () => unknown) => Promise.resolve().then(fn),
  runPageEdit: (_id: string, _e: any, fn: () => unknown) => Promise.resolve().then(fn),
  remapForReorder: () => (i: number) => i,
}));
const mockIndex = jest.fn(async () => {});
jest.mock('../lib/save-scan', () => ({ indexDocText: () => mockIndex() }));

import { splitDocument, splitDocumentParts, splitRanges } from '../lib/doc-ops';
import { blankPageSize, blankPageUndo, canUndoBlankPage, insertBlankPageFiles, removeBlankPageFiles, solidGrayJpeg } from '../lib/blank-page';

/** A scanned document whose page i is "p<i>", with shadows on some pages. */
function seed(id: string, n: number, extra: any = {}) {
  const pages = Array.from({ length: n }, (_, i) => `${ROOT}/${id}/page-${i}.jpg`);
  pages.forEach((p, i) => mockFs.set(p, `p${i}`));
  const doc = { id, name: 'Lease', folder: 'Home', pages, createdAt: 1, updatedAt: 1, ...extra };
  mockDocs.set(id, doc);
  return doc;
}
const file = (id: string, i: number, s = '.jpg') => mockFs.get(`${ROOT}/${id}/page-${i}${s}`);

beforeEach(() => {
  mockFs.clear();
  mockDocs.clear();
  mockUuid = 0;
  mockLayout = 0;
  mockFailSave = null;
  mockTrash.mockClear();
});

describe('splitDocument', () => {
  test('ranges', () => {
    expect(splitRanges(5, 1)).toEqual([[0, 1], [2, 3, 4]]);
    expect(() => splitRanges(3, 2)).toThrow();
    expect(() => splitRanges(1, 0)).toThrow();
  });

  test('two parts, each page with its shadows, filters and adjustments aligned; the original kept', async () => {
    seed('src', 4, {
      filters: ['enhanced', 'original', 'bw', 'noshadow'],
      adjustments: [
        { brightness: 0, contrast: 0, saturation: 0 },
        { brightness: 10, contrast: 0, saturation: 0 },
        { brightness: 0, contrast: 0, saturation: 0 },
        { brightness: 0, contrast: 0, saturation: 0, sharpness: 20 },
      ],
    });
    mockFs.set(`${ROOT}/src/page-0.orig.jpg`, 'o0');
    mockFs.set(`${ROOT}/src/page-2.orig.jpg`, 'o2');
    mockFs.set(`${ROOT}/src/page-2.src.jpg`, 'photo2');
    mockFs.set(`${ROOT}/src/page-2.src.json`, 'crop2');
    mockFs.set(`${ROOT}/src/page-3.orig.jpg`, 'o3');

    const r = await splitDocument('src', 1, { expectedCount: 4 });
    expect(r.originalTrashed).toBe(false);
    expect(r.first.name).toBe('Lease (1)');
    expect(r.second.name).toBe('Lease (2)');
    expect(r.first.folder).toBe('Home');
    expect([file(r.first.id, 0), file(r.first.id, 1)]).toEqual(['p0', 'p1']);
    expect(file(r.first.id, 0, '.orig.jpg')).toBe('o0');
    expect(file(r.first.id, 1, '.orig.jpg')).toBeUndefined();
    expect([file(r.second.id, 0), file(r.second.id, 1)]).toEqual(['p2', 'p3']);
    expect(file(r.second.id, 0, '.orig.jpg')).toBe('o2');
    expect(file(r.second.id, 0, '.src.jpg')).toBe('photo2');
    expect(file(r.second.id, 0, '.src.json')).toBe('crop2');
    expect(file(r.second.id, 1, '.orig.jpg')).toBe('o3');
    expect(r.first.filters).toEqual(['enhanced', 'original']);
    expect(r.second.filters).toEqual(['bw', 'noshadow']);
    expect(r.first.adjustments?.[1].brightness).toBe(10);
    expect(r.second.adjustments?.[1].sharpness).toBe(20);
    // The source is untouched and still listed.
    expect(file('src', 3)).toBe('p3');
    expect(mockDocs.get('src').trashedAt).toBeUndefined();
    expect(mockIndex).toHaveBeenCalled();
  });

  test('all-default parts store no filters / adjustments', async () => {
    seed('src', 3);
    const r = await splitDocument('src', 0);
    expect(r.first.filters).toBeUndefined();
    expect(r.second.adjustments).toBeUndefined();
    expect(r.second.pages).toHaveLength(2);
  });

  test('"delete the original" moves it to Recently deleted', async () => {
    seed('src', 2);
    const r = await splitDocument('src', 0, { trashOriginal: true });
    expect(r.originalTrashed).toBe(true);
    expect(mockTrash).toHaveBeenCalledWith('src');
  });

  test('refuses when the page count changed, and for PDFs; nothing is made', async () => {
    seed('src', 3);
    await expect(splitDocument('src', 0, { expectedCount: 4 })).rejects.toThrow();
    mockDocs.set('pdf', { id: 'pdf', name: 'x', pages: [], pdfUri: 'file:///x.pdf', createdAt: 1, updatedAt: 1 });
    await expect(splitDocument('pdf', 0)).rejects.toThrow();
    expect([...mockDocs.keys()].sort()).toEqual(['pdf', 'src']);
  });

  test('if the second part can’t be saved, the first is removed again, files and record', async () => {
    seed('src', 3);
    mockFailSave = 'part-2';
    await expect(splitDocument('src', 0)).rejects.toThrow('disk full');
    expect(mockDocs.has('part-1')).toBe(false);
    expect([...mockFs.keys()].some(k => k.includes('/part-'))).toBe(false);
    expect(mockTrash).not.toHaveBeenCalled();
  });
});

describe('splitDocumentParts (round 16: every N pages, by ranges)', () => {
  test('one document per part, named (1), (2), (3); pages left out are not copied', async () => {
    seed('src', 5, { filters: ['bw', 'original', 'enhanced', 'original', 'grayscale'] });
    mockFs.set(`${ROOT}/src/page-4.orig.jpg`, 'o4');
    const r = await splitDocumentParts('src', [[0, 1], [2], [4]], { expectedCount: 5 });
    expect(r.parts.map(d => d.name)).toEqual(['Lease (1)', 'Lease (2)', 'Lease (3)']);
    expect(r.parts.map(d => d.pages.length)).toEqual([2, 1, 1]);
    expect(file(r.parts[2].id, 0)).toBe('p4');
    expect(file(r.parts[2].id, 0, '.orig.jpg')).toBe('o4');
    expect(r.parts[0].filters).toEqual(['bw', 'original']);
    expect(r.parts[2].filters).toEqual(['grayscale']);
    // Newest first in "Date added": (1) before (2) before (3).
    expect(r.parts[0].createdAt).toBeGreaterThan(r.parts[1].createdAt);
    expect(r.parts[1].createdAt).toBeGreaterThan(r.parts[2].createdAt);
    expect(mockDocs.get('src').trashedAt).toBeUndefined();
  });

  test('the original is never trashed while some of its pages are in no part (data safety)', async () => {
    seed('src', 5);
    const r = await splitDocumentParts('src', [[0, 1], [3]], { trashOriginal: true });
    expect(r.originalTrashed).toBe(false);
    expect(mockTrash).not.toHaveBeenCalled();
    // Every page in some part: it may go.
    seed('all', 3);
    const r2 = await splitDocumentParts('all', [[2], [0, 1]], { trashOriginal: true });
    expect(r2.originalTrashed).toBe(true);
    expect(mockTrash).toHaveBeenCalledWith('all');
  });

  test('parts planned from the stored page count; a page outside it is refused, nothing made', async () => {
    seed('src', 4);
    const r = await splitDocumentParts('src', n => [[0, 1], [2, 3]].filter(p => p[0] < n));
    expect(r.parts).toHaveLength(2);
    seed('two', 2);
    await expect(splitDocumentParts('two', [[0], [5]])).rejects.toThrow();
    await expect(splitDocumentParts('two', [[]])).rejects.toThrow();
    expect([...mockDocs.keys()].filter(k => k !== 'src' && k !== 'two').length).toBe(2);
  });
});

describe('blank page', () => {
  test('the JPEG is a valid baseline grayscale frame of the asked size', () => {
    const b = solidGrayJpeg(1240, 1754);
    expect([b[0], b[1]]).toEqual([0xff, 0xd8]);
    expect([b[b.length - 2], b[b.length - 1]]).toEqual([0xff, 0xd9]);
    const sof = b.findIndex((v, i) => v === 0xff && b[i + 1] === 0xc0);
    expect(sof).toBeGreaterThan(0);
    expect((b[sof + 5] << 8) | b[sof + 6]).toBe(1754);
    expect((b[sof + 7] << 8) | b[sof + 8]).toBe(1240);
    expect(b[sof + 9]).toBe(1);
    // Small: about two bits per 8 × 8 block.
    expect(b.length).toBeLessThan(20_000);
    // Every 0xFF inside the scan is followed by a stuffed 0x00.
    const sos = b.findIndex((v, i) => v === 0xff && b[i + 1] === 0xda);
    const scanStart = sos + 2 + ((b[sos + 2] << 8) | b[sos + 3]);
    for (let i = scanStart; i < b.length - 2; i++) if (b[i] === 0xff) expect(b[i + 1]).toBe(0x00);
  });

  test('sized like its neighbour; A4 when that is unknown', () => {
    expect(blankPageSize({ width: 1600.4, height: 2100 })).toEqual({ width: 1600, height: 2100 });
    expect(blankPageSize(null)).toEqual({ width: 1654, height: 2339 });
  });

  test('inserted after a page, every family member moves with its page; Undo takes it out again', () => {
    const doc = seed('d', 3, { filters: ['bw', 'enhanced', 'original'] });
    mockFs.set(`${ROOT}/d/page-1.orig.jpg`, 'o1');
    mockFs.set(`${ROOT}/d/page-2.src.jpg`, 'photo2');
    mockFs.set(`${ROOT}/d/page-2.src.json`, 'crop2');
    // A stale shadow at the new slot from an interrupted edit must not pair with the blank page.
    mockFs.set(`${ROOT}/d/page-3.orig.jpg`, 'stale');

    const patch = insertBlankPageFiles(doc as any, 0, { width: 800, height: 1000 });
    expect(patch.pages).toHaveLength(4);
    expect([file('d', 0), file('d', 1)?.startsWith('jpeg:'), file('d', 2), file('d', 3)]).toEqual(['p0', true, 'p1', 'p2']);
    expect(file('d', 1, '.orig.jpg')).toBeUndefined();
    expect(file('d', 2, '.orig.jpg')).toBe('o1');
    expect(file('d', 3, '.src.jpg')).toBe('photo2');
    expect(file('d', 3, '.src.json')).toBe('crop2');
    expect(patch.filters).toEqual(['bw', 'original', 'enhanced', 'original']);
    expect(patch.adjustments).toBeUndefined();

    const after = { ...doc, ...patch } as any;
    const undo = blankPageUndo('d', 1);
    expect(canUndoBlankPage(undo, after)).toBe(true);
    const back = removeBlankPageFiles(after, undo);
    expect(back.pages).toHaveLength(3);
    expect([file('d', 0), file('d', 1), file('d', 2)]).toEqual(['p0', 'p1', 'p2']);
    expect(file('d', 1, '.orig.jpg')).toBe('o1');
    expect(file('d', 2, '.src.json')).toBe('crop2');
    expect(file('d', 3)).toBeUndefined();
    expect(back.filters).toEqual(['bw', 'enhanced', 'original']);
  });

  test('after the last page: appended without a reorder', () => {
    const doc = seed('e', 2);
    const patch = insertBlankPageFiles(doc as any, 1, { width: 10, height: 10 });
    expect(patch.pages).toEqual([`${ROOT}/e/page-0.jpg`, `${ROOT}/e/page-1.jpg`, `${ROOT}/e/page-2.jpg`]);
    expect(file('e', 2)?.startsWith('jpeg:')).toBe(true);
    expect(patch.filters).toBeUndefined();
  });

  test('Undo refuses once pages were moved or deleted since', () => {
    const doc = seed('f', 2);
    const patch = insertBlankPageFiles(doc as any, 0, { width: 10, height: 10 });
    const undo = blankPageUndo('f', 1);
    mockLayout++; // a reorder or delete happened
    expect(canUndoBlankPage(undo, { ...doc, ...patch })).toBe(false);
    expect(() => removeBlankPageFiles({ ...doc, ...patch } as any, undo)).toThrow();
  });
});
