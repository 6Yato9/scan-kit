// lib/merge-undo.ts: Undo for merging (r13). Merging into a document takes
// exactly the appended pages out again — only while they are unchanged and
// still where the merge put them; a merge that made a new document removes
// that copy (deleted when untouched, else moved to Recently deleted).
const mockFiles = new Map<string, string>(); // uri -> identity
jest.mock('expo-file-system', () => {
  const part = (p: any) => (p && typeof p === 'object' ? p.uri : p);
  class MockFile {
    uri: string;
    constructor(dir: any, name?: string) { this.uri = name ? `${part(dir)}/${name}` : String(part(dir)); }
    get exists() { return mockFiles.has(this.uri); }
    delete() { mockFiles.delete(this.uri); }
  }
  return { File: MockFile, Directory: class {}, Paths: {} };
});
jest.mock('../lib/storage-layout', () => ({ docDir: (id: string) => ({ uri: `file:///as/scan-kit/${id}` }) }));
let mockLayout = 0;
jest.mock('../lib/files', () => ({ pageLayoutGeneration: () => mockLayout }));
const mockPruned: string[] = [];
jest.mock('../lib/ocr-cache', () => ({
  fileIdentity: (uri: string) => mockFiles.get(uri) ?? null,
  pruneDocumentOcr: (id: string) => { mockPruned.push(id); },
}));
const mockStored: Record<string, any> = {};
const mockDeletedForever: string[] = [];
const mockTrashed: string[] = [];
jest.mock('../lib/storage', () => ({
  getDocument: jest.fn(async (id: string) => mockStored[id] ?? null),
  updateDocumentWith: jest.fn(async (id: string, fn: (d: any) => any) => {
    const cur = mockStored[id];
    if (!cur) return false;
    const patch = fn(cur);
    if (!patch) return false;
    mockStored[id] = { ...cur, ...patch };
    return true;
  }),
  deleteForever: jest.fn(async (id: string) => { mockDeletedForever.push(id); delete mockStored[id]; }),
  trashDocument: jest.fn(async (id: string) => {
    if (!mockStored[id]) return false;
    mockTrashed.push(id);
    mockStored[id] = { ...mockStored[id], trashedAt: 5 };
    return true;
  }),
}));
const mockEdits: any[] = [];
jest.mock('../lib/bake', () => ({
  runPageEdit: (id: string, edit: any, fn: () => unknown) => { mockEdits.push([id, edit]); return Promise.resolve().then(fn); },
  withDocLock: (_id: string, fn: () => unknown) => Promise.resolve().then(fn),
}));
const mockIndex = jest.fn(async (_id: string, _pages: string[]) => {});
jest.mock('../lib/save-scan', () => ({ indexDocText: (id: string, pages: string[]) => mockIndex(id, pages) }));

import {
  checkMergeUndo,
  mergeUndoRefusal,
  mergeUndoRefusalMessage,
  mergeUndoRemap,
  mergeUndoToken,
  MergeUndoError,
  newMergeUndo,
  newMergeUndoAction,
  removeMergedPages,
  trimmedPageMeta,
  undoMergeInto,
  undoNewMerge,
  type MergeUndo,
} from '../lib/merge-undo';
import type { Document } from '../types/document';

const dir = (id: string) => `file:///as/scan-kit/${id}`;
const SUFFIXES = ['.jpg', '.orig.jpg', '.src.jpg', '.src.json'];

/** A stored document of `n` pages, every page with every shadow. */
function seed(id: string, n: number, extra: Partial<Document> = {}): Document {
  const pages = Array.from({ length: n }, (_, i) => `${dir(id)}/page-${i}.jpg`);
  for (let i = 0; i < n; i++) for (const s of SUFFIXES) mockFiles.set(`${dir(id)}/page-${i}${s}`, `${id}-${i}${s}-v1`);
  const d: Document = { id, name: id, pages, createdAt: 1, updatedAt: 1, ...extra };
  mockStored[id] = d;
  return d;
}

beforeEach(() => {
  mockFiles.clear();
  for (const k of Object.keys(mockStored)) delete mockStored[k];
  mockPruned.length = 0;
  mockEdits.length = 0;
  mockDeletedForever.length = 0;
  mockTrashed.length = 0;
  mockIndex.mockClear();
  mockLayout = 0;
});

describe('the fingerprint', () => {
  test('records where the pages went, the layout and each appended page file', () => {
    seed('t', 5);
    mockLayout = 3;
    expect(mergeUndoToken('t', 2, 3)).toEqual({
      docId: 't', start: 2, count: 3, layout: 3, identities: ['t-2.jpg-v1', 't-3.jpg-v1', 't-4.jpg-v1'],
    });
  });

  test('no Undo when an appended page can’t be fingerprinted, or nothing was appended', () => {
    seed('t', 3);
    mockFiles.delete(`${dir('t')}/page-2.jpg`);
    expect(mergeUndoToken('t', 1, 2)).toBeNull();
    expect(mergeUndoToken('t', 3, 0)).toBeNull();
  });
});

describe('when Undo may run', () => {
  const undo: MergeUndo = { docId: 't', start: 2, count: 2, layout: 4, identities: ['a', 'b'] };
  const doc = { pages: ['p0', 'p1', 'p2', 'p3'] };
  const same = { layout: 4, identities: ['a', 'b'] };

  test('unchanged since the merge: allowed', () => {
    expect(mergeUndoRefusal(undo, doc, same)).toBeNull();
  });

  test('document gone, in Recently deleted, or now a PDF: refused', () => {
    expect(mergeUndoRefusal(undo, null, same)).toBe('missing');
    expect(mergeUndoRefusal(undo, { ...doc, trashedAt: 9 }, same)).toBe('missing');
    expect(mergeUndoRefusal(undo, { ...doc, pdfUri: 'x.pdf' }, same)).toBe('missing');
  });

  test('a page added or deleted since (count differs): refused', () => {
    expect(mergeUndoRefusal(undo, { pages: ['p0', 'p1', 'p2', 'p3', 'p4'] }, same)).toBe('pages-changed');
    expect(mergeUndoRefusal(undo, { pages: ['p0', 'p1', 'p2'] }, same)).toBe('pages-changed');
  });

  test('pages reordered or deleted-and-added since (layout moved): refused', () => {
    expect(mergeUndoRefusal(undo, doc, { ...same, layout: 5 })).toBe('pages-changed');
  });

  test('an appended page edited since (its file changed or is unreadable): refused', () => {
    expect(mergeUndoRefusal(undo, doc, { ...same, identities: ['a', 'b2'] })).toBe('pages-edited');
    expect(mergeUndoRefusal(undo, doc, { ...same, identities: ['a', null] })).toBe('pages-edited');
  });

  test('every refusal has a calm, specific message', () => {
    for (const k of ['missing', 'pages-changed', 'pages-edited'] as const) {
      expect(mergeUndoRefusalMessage(k)).toMatch(/^[A-Z].+\.$/);
      expect(mergeUndoRefusalMessage(k)).not.toMatch(/error|failed/i);
    }
  });

  test('the remap drops exactly the appended pages', () => {
    const remap = mergeUndoRemap(undo);
    expect([0, 1, 2, 3].map(remap)).toEqual([0, 1, -1, -1]);
  });
});

describe('taking the pages out', () => {
  test('per-page lists are cut back to the target’s own pages and collapse when all default', () => {
    expect(trimmedPageMeta({ pages: ['a', 'b', 'c'], filters: ['original', 'original', 'bw'] }, 2))
      .toEqual({ pages: ['a', 'b'], filters: undefined, adjustments: undefined });
    expect(trimmedPageMeta({
      pages: ['a', 'b', 'c'],
      filters: ['enhanced', 'original', 'bw'],
      adjustments: [{ brightness: 0, contrast: 0, saturation: 0 }, { brightness: 0, contrast: 0, saturation: 0 }, { brightness: 20, contrast: 0, saturation: 0 }],
    }, 2)).toEqual({ pages: ['a', 'b'], filters: ['enhanced', 'original'], adjustments: undefined });
  });

  test('removes the appended pages with every shadow and their text, and nothing else', () => {
    const d = seed('t', 4, { filters: ['bw', 'bw', 'enhanced', 'enhanced'] });
    const undo = mergeUndoToken('t', 2, 2)!;
    const patch = removeMergedPages(d, undo);
    expect(patch.pages).toEqual([`${dir('t')}/page-0.jpg`, `${dir('t')}/page-1.jpg`]);
    expect(patch.filters).toEqual(['bw', 'bw']);
    for (const i of [2, 3]) for (const s of SUFFIXES) expect(mockFiles.has(`${dir('t')}/page-${i}${s}`)).toBe(false);
    for (const i of [0, 1]) for (const s of SUFFIXES) expect(mockFiles.has(`${dir('t')}/page-${i}${s}`)).toBe(true);
    expect(mockPruned).toEqual(['t']);
  });

  test('refusing changes nothing', () => {
    const d = seed('t', 3);
    const undo = mergeUndoToken('t', 1, 2)!;
    // A filter baked into a merged page after the merge: its file changed.
    mockFiles.set(`${dir('t')}/page-2.jpg`, 'baked');
    expect(() => removeMergedPages(d, undo)).toThrow(MergeUndoError);
    expect(mockFiles.size).toBe(3 * SUFFIXES.length);
    expect(mockPruned).toEqual([]);
  });

  test('edits to the target’s own pages don’t block it', () => {
    const d = seed('t', 3);
    const undo = mergeUndoToken('t', 1, 2)!;
    mockFiles.set(`${dir('t')}/page-0.jpg`, 'rotated');
    expect(checkMergeUndo(undo, d)).toBeNull();
  });
});

describe('undoMergeInto (Home, Files)', () => {
  test('runs under the page lock, writes the trimmed record and re-indexes the text', async () => {
    seed('t', 3, { filters: ['bw', 'enhanced', 'enhanced'], ocrText: 'old' });
    const undo = mergeUndoToken('t', 1, 2)!;
    const out = await undoMergeInto(undo);
    expect(mockEdits).toHaveLength(1);
    expect(mockEdits[0][0]).toBe('t');
    expect([0, 1, 2].map(mockEdits[0][1].remap)).toEqual([0, -1, -1]);
    expect(out.pages).toHaveLength(1);
    expect(mockStored.t.pages).toHaveLength(1);
    expect(mockStored.t.filters).toEqual(['bw']);
    expect(mockStored.t.ocrText).toBe('old');
    await Promise.resolve();
    expect(mockIndex).toHaveBeenCalledWith('t', out.pages);
  });

  test('refuses after an intervening edit, leaving the record and files alone', async () => {
    seed('t', 3);
    const undo = mergeUndoToken('t', 1, 2)!;
    mockLayout = 1; // a page was moved since
    await expect(undoMergeInto(undo)).rejects.toMatchObject({ kind: 'pages-changed' });
    expect(mockStored.t.pages).toHaveLength(3);
    expect(mockFiles.size).toBe(3 * SUFFIXES.length);
    expect(mockIndex).not.toHaveBeenCalled();
  });

  test('refuses when the document is gone', async () => {
    seed('t', 3);
    const undo = mergeUndoToken('t', 1, 2)!;
    delete mockStored.t;
    await expect(undoMergeInto(undo)).rejects.toMatchObject({ kind: 'missing' });
  });
});

describe('merges that made a new document', () => {
  test('untouched since: deleted outright (it is a copy; the originals stay)', async () => {
    const merged = seed('m', 3, { updatedAt: 100 });
    seed('a', 2);
    seed('b', 1);
    expect(await undoNewMerge(newMergeUndo(merged))).toBe('deleted');
    expect(mockDeletedForever).toEqual(['m']);
    expect(mockStored.a).toBeDefined();
    expect(mockStored.b).toBeDefined();
  });

  test('changed since (renamed, edited): moved to Recently deleted instead', async () => {
    const merged = seed('m', 3, { updatedAt: 100 });
    const undo = newMergeUndo(merged);
    mockStored.m = { ...mockStored.m, name: 'Renamed', updatedAt: 200 };
    expect(await undoNewMerge(undo)).toBe('trashed');
    expect(mockTrashed).toEqual(['m']);
    expect(mockDeletedForever).toEqual([]);
  });

  test('already gone or in Recently deleted: nothing to do', () => {
    expect(newMergeUndoAction({ docId: 'm', updatedAt: 1 }, null)).toBe('missing');
    expect(newMergeUndoAction({ docId: 'm', updatedAt: 1 }, { updatedAt: 1, trashedAt: 3 })).toBe('missing');
  });
});
