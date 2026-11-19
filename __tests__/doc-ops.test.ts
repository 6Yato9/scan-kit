// __tests__/doc-ops.test.ts
// Merge must carry each page's .orig shadow; duplicate/merge must keep metadata aligned.
const mockFiles: Record<string, string> = {};
jest.mock('expo-file-system', () => {
  class MockFile {
    uri: string;
    constructor(dirOrUri: any, name?: string) {
      this.uri = name ? `${dirOrUri.uri ?? dirOrUri}/${name}` : String(dirOrUri);
    }
    get exists() { return this.uri in mockFiles; }
    copy(dest: MockFile) { mockFiles[dest.uri] = mockFiles[this.uri]; }
    delete() { delete mockFiles[this.uri]; }
  }
  class MockDirectory {
    uri: string;
    constructor(...parts: any[]) { this.uri = parts.map(p => (typeof p === 'string' ? p : p.uri)).join('/'); }
    create() {}
  }
  return { File: MockFile, Directory: MockDirectory, Paths: { document: 'file:///docs' } };
});
jest.mock('expo-crypto', () => ({ randomUUID: () => 'new-id' }));
const mockSaved: any[] = [];
const mockPatches: [string, any][] = [];
// What storage holds NOW (may differ from the copies the caller passes in).
const mockStored: Record<string, any> = {};
jest.mock('../lib/storage', () => ({
  saveDocument: jest.fn(async (d: any) => { mockSaved.push(d); }),
  getDocument: jest.fn(async (id: string) => mockStored[id] ?? null),
  patchDocument: jest.fn(async (id: string, p: any) => { mockPatches.push([id, p]); return id !== 'gone'; }),
}));
const mockReorderPages = jest.fn((id: string, order: number[]) => order.map((_, i) => `file:///docs/scan-kit/${id}/page-${i}.jpg`));
jest.mock('../lib/files', () => ({
  copyDocumentFiles: jest.fn(() => []),
  copyPdfToStorage: jest.fn(() => 'file:///docs/scan-kit/new-id/document.pdf'),
  reorderPages: (id: string, order: number[]) => mockReorderPages(id, order),
  copyPageWithShadow: (src: string, destId: string, i: number) => {
    const to = `file:///docs/scan-kit/${destId}/page-${i}.jpg`;
    if (!(src in mockFiles)) throw new Error('no such page file');
    mockFiles[to] = mockFiles[src];
    return to;
  },
  deleteDocumentFiles: (id: string) => {
    for (const k of Object.keys(mockFiles)) if (k.includes(`/${id}/`)) delete mockFiles[k];
  },
}));
const mockEdits: any[] = [];
jest.mock('../lib/bake', () => ({
  ...jest.requireActual('../lib/bake'),
  runPageEdit: (id: string, edit: any, fn: () => unknown) => { mockEdits.push([id, edit]); return Promise.resolve().then(fn); },
}));

const mockIndexDocText = jest.fn(async (_id: string, _pages: string[]) => {});
jest.mock('../lib/save-scan', () => ({
  indexDocText: (id: string, pages: string[]) => mockIndexDocText(id, pages),
}));

const mockToken = jest.fn((docId: string, start: number, count: number) => ({ docId, start, count, layout: 0, identities: [] as string[] }));
jest.mock('../lib/merge-undo', () => ({
  mergeUndoToken: (docId: string, start: number, count: number) => mockToken(docId, start, count),
}));

import { combinePageMeta, copyPagesWithOriginals, extractPages, mergeInto, mergeIntoNew, mergeIntoWithUndo, reorderDocumentPages } from '../lib/doc-ops';
import { withDocLock } from '../lib/bake';
import { Document } from '../types/document';

const dir = (id: string) => `file:///docs/scan-kit/${id}`;
function doc(id: string, n: number, extra: Partial<Document> = {}): Document {
  const pages = Array.from({ length: n }, (_, i) => `${dir(id)}/page-${i}.jpg`);
  pages.forEach((p, i) => { mockFiles[p] = `${id}-${i}`; });
  return { id, name: id, pages, createdAt: 1, updatedAt: 1, ...extra };
}

beforeEach(() => {
  for (const k of Object.keys(mockFiles)) delete mockFiles[k];
  for (const k of Object.keys(mockStored)) delete mockStored[k];
  mockSaved.length = 0;
  mockPatches.length = 0;
  mockEdits.length = 0;
  mockReorderPages.mockClear();
});
const stored = (d: Document) => { mockStored[d.id] = d; return d; };

test('copyPagesWithOriginals copies pages and their .orig shadows to the right indices', () => {
  const src = doc('src', 2);
  mockFiles[`${dir('src')}/page-1.orig.jpg`] = 'src-1-orig';
  const uris = copyPagesWithOriginals(src, 'dst', 3);
  expect(uris).toEqual([`${dir('dst')}/page-3.jpg`, `${dir('dst')}/page-4.jpg`]);
  expect(mockFiles[`${dir('dst')}/page-3.jpg`]).toBe('src-0');
  expect(mockFiles[`${dir('dst')}/page-4.jpg`]).toBe('src-1');
  expect(mockFiles[`${dir('dst')}/page-4.orig.jpg`]).toBe('src-1-orig');
  expect(`${dir('dst')}/page-3.orig.jpg` in mockFiles).toBe(false);
});

test('copyPagesWithOriginals carries source photos and geometry (R12), and clears stale ones at the destination', () => {
  const src = doc('src', 2);
  mockFiles[`${dir('src')}/page-0.src.jpg`] = 'src-0-photo';
  mockFiles[`${dir('src')}/page-0.src.json`] = 'src-0-geo';
  mockFiles[`${dir('dst')}/page-4.src.jpg`] = 'stale-photo';
  mockFiles[`${dir('dst')}/page-4.src.json`] = 'stale-geo';
  copyPagesWithOriginals(src, 'dst', 3);
  expect(mockFiles[`${dir('dst')}/page-3.src.jpg`]).toBe('src-0-photo');
  expect(mockFiles[`${dir('dst')}/page-3.src.json`]).toBe('src-0-geo');
  expect(`${dir('dst')}/page-4.src.jpg` in mockFiles).toBe(false);
  expect(`${dir('dst')}/page-4.src.json` in mockFiles).toBe(false);
});

test('combinePageMeta keeps filters aligned and collapses all-default metadata', () => {
  const a = doc('a', 2, { filters: ['bw', 'original'] });
  const b = doc('b', 1);
  expect(combinePageMeta([a, b])).toEqual({ filters: ['bw', 'original', 'original'], adjustments: undefined });
  expect(combinePageMeta([doc('c', 1), doc('d', 1)])).toEqual({ filters: undefined, adjustments: undefined });
});

test('mergeInto patches only page fields onto the target', async () => {
  const target = stored(doc('t', 1, { filters: ['enhanced'] }));
  const source = stored(doc('s', 1));
  const out = await mergeInto(target, source);
  expect(out?.pages).toHaveLength(2);
  const [id, patch] = mockPatches[0];
  expect(id).toBe('t');
  expect(Object.keys(patch).sort()).toEqual(['adjustments', 'filters', 'pages', 'updatedAt']);
  expect(patch.filters).toEqual(['enhanced', 'original']);
});

test('mergeInto returns null when the target was deleted meanwhile', async () => {
  expect(await mergeInto(doc('gone', 1), doc('s', 1))).toBeNull();
});

test('mergeInto appends after the CURRENT page count, never over a page added meanwhile (critique #6)', async () => {
  const stale = doc('t2', 1);
  stored(doc('t2', 2, { filters: ['original', 'bw'] })); // a page was added and baked since
  stored(doc('s2', 1));
  const out = await mergeInto(stale, doc('s2', 1));
  expect(out?.pages).toHaveLength(3);
  expect(mockFiles[`${dir('t2')}/page-1.jpg`]).toBe('t2-1'); // untouched
  expect(mockFiles[`${dir('t2')}/page-2.jpg`]).toBe('s2-0');
  expect(mockPatches[0][1].filters).toEqual(['original', 'bw', 'original']);
  expect(mockEdits[0][0]).toBe('t2'); // under the target's page lock
});

test('mergeInto removes its copies when the target vanished before the write', async () => {
  stored(doc('gone', 1));
  stored(doc('s3', 1));
  expect(await mergeInto(doc('gone', 1), doc('s3', 1))).toBeNull();
  expect(`${dir('gone')}/page-1.jpg` in mockFiles).toBe(false);
});

test('reorderDocumentPages carries the CURRENT filters with their pages', async () => {
  stored(doc('r', 3, { filters: ['bw', 'original', 'enhanced'] }));
  const out = await reorderDocumentPages('r', [2, 0, 1]);
  expect(mockReorderPages).toHaveBeenCalledWith('r', [2, 0, 1]);
  expect(out.filters).toEqual(['enhanced', 'bw', 'original']);
  expect(mockPatches[0][1].filters).toEqual(['enhanced', 'bw', 'original']);
  expect(typeof mockEdits[0][1].remap).toBe('function');
});

test('reorderDocumentPages refuses an order built for a different page count', async () => {
  stored(doc('r2', 3));
  await expect(reorderDocumentPages('r2', [1, 0])).rejects.toThrow('page count changed');
  await expect(reorderDocumentPages('r2', [0, 0, 1])).rejects.toThrow('page count changed');
  expect(mockReorderPages).not.toHaveBeenCalled();
});

test('mergeIntoWithUndo fingerprints the appended pages under the lock and never writes the source (r13)', async () => {
  const target = stored(doc('t4', 2, { filters: ['bw', 'bw'] }));
  const source = stored(doc('s4', 3));
  mockToken.mockClear();
  const out = await mergeIntoWithUndo(target, source);
  expect(out?.added).toBe(3);
  expect(out?.undo).toMatchObject({ docId: 't4', start: 2, count: 3 });
  expect(mockToken).toHaveBeenCalledWith('t4', 2, 3);
  // The source is only read: no patch, no save, its files as they were.
  expect(mockPatches.map(([id]) => id)).toEqual(['t4']);
  expect(mockSaved).toHaveLength(0);
  expect([0, 1, 2].map(i => mockFiles[`${dir('s4')}/page-${i}.jpg`])).toEqual(['s4-0', 's4-1', 's4-2']);
  // The target's text index is refreshed so search finds the merged words.
  await Promise.resolve();
  expect(mockIndexDocText).toHaveBeenCalledWith('t4', out!.doc.pages);
});

test('mergeIntoWithUndo offers no Undo when the fingerprint can’t be taken, and still merges', async () => {
  const target = stored(doc('t5', 1));
  stored(doc('s5', 1));
  mockToken.mockImplementationOnce(() => { throw new Error('unreadable'); });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const out = await mergeIntoWithUndo(target, doc('s5', 1));
  warn.mockRestore();
  expect(out?.doc.pages).toHaveLength(2);
  expect(out?.undo).toBeNull();
});

test('mergeIntoNew creates one document with every page in order', async () => {
  const merged = await mergeIntoNew([doc('a', 1), doc('b', 2)], 'Merged');
  expect(merged.id).toBe('new-id');
  expect(merged.pages).toHaveLength(3);
  expect(mockFiles[`${dir('new-id')}/page-2.jpg`]).toBe('b-1');
  expect(mockSaved).toHaveLength(1);
});

describe('extractPages (critique L3)', () => {
  test('copies the chosen pages with the labels STORED now, not the caller\'s stale copy', async () => {
    const stale = doc('src', 3, { filters: ['original', 'original', 'original'] });
    // A bake finished after the tool loaded the document: page 2 is now B&W.
    mockStored.src = { ...stale, filters: ['original', 'original', 'bw'] };
    const created = await extractPages(stale, [2, 0]);
    expect(created.pages).toEqual(['file:///docs/scan-kit/new-id/page-0.jpg', 'file:///docs/scan-kit/new-id/page-1.jpg']);
    expect(mockFiles['file:///docs/scan-kit/new-id/page-1.jpg']).toBe('src-2');
    expect(created.filters).toEqual(['original', 'bw']);
    expect(created.name).toBe('src (pages 1, 3)');
    expect(mockSaved).toEqual([created]);
  });

  test('waits for a bake holding the document lock before copying', async () => {
    const src = doc('src', 2);
    mockStored.src = { ...src };
    const order: string[] = [];
    let release!: () => void;
    const bake = withDocLock('src', () => new Promise<void>(r => { release = r; })).then(() => {
      order.push('bake written');
      mockStored.src = { ...src, filters: ['enhanced', 'original'] };
    });
    const extracting = extractPages(src, [0]).then(d => { order.push('extracted'); return d; });
    await Promise.resolve();
    release();
    // The bake's write runs in its own lock turn; mimic it landing before the
    // extract re-reads by awaiting the bake first.
    await bake;
    const created = await extracting;
    expect(order).toEqual(['bake written', 'extracted']);
    expect(created.filters).toEqual(['enhanced']);
  });

  test('indexes the new document so content search finds it (r5 L4)', async () => {
    mockIndexDocText.mockClear();
    const src = doc('src', 3);
    mockStored.src = { ...src };
    const created = await extractPages(src, [1, 2]);
    expect(mockIndexDocText).toHaveBeenCalledWith('new-id', created.pages);
  });

  test('an indexing failure does not fail the extract', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockIndexDocText.mockRejectedValueOnce(new Error('vision'));
    const src = doc('src', 2);
    mockStored.src = { ...src };
    await expect(extractPages(src, [0])).resolves.toMatchObject({ id: 'new-id' });
    await new Promise(r => setImmediate(r));
    warn.mockRestore();
  });

  test('refuses, leaving nothing behind, when the page count changed meanwhile', async () => {
    mockIndexDocText.mockClear();
    const stale = doc('src', 3);
    mockStored.src = { ...stale, pages: stale.pages.slice(0, 2) };
    await expect(extractPages(stale, [2])).rejects.toThrow('changed');
    expect(mockSaved).toEqual([]);
    expect(mockIndexDocText).not.toHaveBeenCalled();
    expect(Object.keys(mockFiles).some(k => k.includes('/new-id/'))).toBe(false);
  });

  test('a failed copy removes the partial new document', async () => {
    const src = doc('src', 2);
    mockStored.src = { ...src };
    delete mockFiles[src.pages[1]];
    await expect(extractPages(src, [0, 1])).rejects.toThrow();
    expect(Object.keys(mockFiles).some(k => k.includes('/new-id/'))).toBe(false);
    expect(mockSaved).toEqual([]);
  });
});
