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
    get size() { return mockFs.get(this.uri)?.length ?? 0; }
    get md5() { return mockFs.has(this.uri) ? `md5:${mockFs.get(this.uri)}` : null; }
    delete() { mockFs.delete(this.uri); }
    copy(dest: any) { mockFs.set(dest.uri, mockFs.get(this.uri)!); }
    create() { mockFs.set(this.uri, ''); }
    write(c: string) { mockFs.set(this.uri, c); }
    textSync() { if (!mockFs.has(this.uri)) throw new Error('ENOENT'); return mockFs.get(this.uri)!; }
    move(dest: any) {
      if (mockFs.has(dest.uri)) throw new Error('EEXIST');
      mockFs.set(dest.uri, mockFs.get(this.uri)!);
      mockFs.delete(this.uri);
      this.uri = dest.uri;
    }
  }
  class MockDirectory {
    uri: string;
    constructor(...parts: any[]) { this.uri = parts.map(part).join('/'); }
    get exists() { return [...mockFs.keys()].some(k => k.startsWith(`${this.uri}/`)); }
    create() {}
    delete() { for (const k of [...mockFs.keys()]) if (k.startsWith(`${this.uri}/`)) mockFs.delete(k); }
    list() {
      const seen = new Map<string, any>();
      for (const k of mockFs.keys()) {
        if (!k.startsWith(`${this.uri}/`)) continue;
        const rest = k.slice(this.uri.length + 1);
        const head = rest.split('/')[0];
        if (seen.has(head)) continue;
        seen.set(head, rest.includes('/') ? new MockDirectory(`${this.uri}/${head}`) : new MockFile(`${this.uri}/${head}`));
      }
      return [...seen.values()];
    }
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
  deleteDocumentFiles: jest.fn((id: string) => {
    for (const k of [...mockFs.keys()]) if (k.startsWith(`${root}/${id}/`)) mockFs.delete(k);
  }),
  copyDocumentFiles: (from: string, to: string, pages: string[]) =>
    pages.map((_, i) => {
      mockFs.set(pageUri(to, i), mockFs.get(pageUri(from, i))!);
      if (mockFs.has(origUri(from, i))) mockFs.set(origUri(to, i), mockFs.get(origUri(from, i))!);
      return pageUri(to, i);
    }),
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'copy1' }));
jest.mock('../lib/image', () => ({ pageFileUri: (doc: string, i: number) => pageUri(doc, i) }));

let mockDoc: any;
// Other documents (a "Save as a copy" copy), and which of them are still pending.
const mockOthers = new Map<string, any>();
const mockPending = new Set<string>();
const mockUpdate = jest.fn(async (d: any) => { if (d.id === 'd1') mockDoc = d; else mockOthers.set(d.id, d); return true; });
const mockPatch = jest.fn(async (id: string, p: any) => {
  if (id === 'd1') mockDoc = { ...mockDoc, ...p };
  else if (mockOthers.has(id)) mockOthers.set(id, { ...mockOthers.get(id), ...p });
  else return false;
  return true;
});
jest.mock('../lib/storage', () => ({
  getDocument: jest.fn(async (id: string) => (id === 'd1' ? mockDoc : mockOthers.get(id) ?? null)),
  updateDocument: (d: any) => mockUpdate(d),
  patchDocument: (id: string, p: any) => mockPatch(id, p),
  deleteDocument: jest.fn(async (id: string) => { mockOthers.delete(id); mockPending.delete(id); }),
  savePendingDocument: jest.fn(async (d: any) => { mockPending.add(d.id); mockOthers.set(d.id, d); }),
  commitPendingDocument: jest.fn(async (id: string, p: any) => {
    if (!mockOthers.has(id)) return false;
    mockPending.delete(id);
    mockOthers.set(id, { ...mockOthers.get(id), ...p });
    return true;
  }),
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
let mockOcrAvailable = true;
const mockPrune = jest.fn();
jest.mock('../lib/ocr', () => ({ ocrAvailable: () => mockOcrAvailable }));
jest.mock('../lib/ocr-cache', () => ({ pruneDocumentOcr: (...a: unknown[]) => mockPrune(...a) }));
import {
  lookOf,
  recoverInterruptedStamps,
  pagesPhrase,
  partialMessage,
  stampCopy,
  stampPages,
  StampError,
  targetPages,
  undoStamp,
} from '../lib/page-stamp';

/** A fake renderer: "draws" the mark by tagging the bytes it was given. */
const render = jest.fn(async (page: string, orig: string | null) => ({
  page: `data:image/jpeg;base64,SIGNED(${mockFs.get(page)})`,
  orig: orig ? `data:image/jpeg;base64,SIGNED(${mockFs.get(orig)})` : null,
}));

const baseRender = render.getMockImplementation()!;

beforeEach(() => {
  jest.clearAllMocks();
  mockFs.clear();
  mockLayout = 0;
  mockEdits.length = 0;
  mockOthers.clear();
  mockPending.clear();
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

const stashKeys = () => [...mockFs.keys()].filter(k => k.includes('stamp-undo'));

describe('closing the screen mid-run (r9 code #1)', () => {
  test('a cancelled run puts back the pages it did and says so with kind cancelled', async () => {
    const signal = { aborted: false };
    render.mockImplementationOnce(render.getMockImplementation()!);
    // The screen closes while page 2 is being drawn: the stamper fails it.
    render.mockImplementationOnce(async () => { signal.aborted = true; throw new Error('closed'); });
    await expect(stampPages('d1', [0, 1, 2], render, { signal })).rejects.toMatchObject({ kind: 'cancelled' });
    expect(mockFs.get(pageUri('d1', 0))).toBe('page0-enhanced');
    expect(mockFs.get(pageUri('d1', 1))).toBe('page1-enhanced');
    expect(stashKeys()).toEqual([]);
  });

  test('closed while the last page was written: the whole change goes back', async () => {
    const signal = { aborted: false };
    render.mockImplementationOnce(render.getMockImplementation()!);
    render.mockImplementationOnce(async (page: string, orig: string | null) => {
      const out = await render.getMockImplementation()!(page, orig);
      signal.aborted = true; // closed after drawing, before / while writing
      return out;
    });
    await expect(stampPages('d1', [0, 1], render, { signal })).rejects.toMatchObject({ kind: 'cancelled' });
    expect(mockFs.get(pageUri('d1', 0))).toBe('page0-enhanced');
    expect(mockFs.get(pageUri('d1', 1))).toBe('page1-enhanced');
    expect(mockFs.get(origUri('d1', 1))).toBe('page1-raw');
  });

  test('already closed: nothing is drawn or stashed', async () => {
    await expect(stampPages('d1', [0], render, { signal: { aborted: true } })).rejects.toMatchObject({ kind: 'cancelled' });
    expect(render).not.toHaveBeenCalled();
    expect(stashKeys()).toEqual([]);
  });

  test('a second run started while the first rolls back waits for it, and keeps its stash intact', async () => {
    let failFirst!: (e: Error) => void;
    render.mockImplementationOnce(render.getMockImplementation()!);
    render.mockImplementationOnce(() => new Promise((_, reject) => { failFirst = reject; }));
    const first = stampPages('d1', [0, 1, 2], render);
    await new Promise(r => setTimeout(r, 0));
    expect(mockFs.get(pageUri('d1', 0))).toBe('b64:SIGNED(page0-enhanced)');
    // A watermark started now must not see (or stash) the half-signed page 0.
    const second = stampPages('d1', [0], render);
    await new Promise(r => setTimeout(r, 0));
    expect(render).toHaveBeenCalledTimes(2);
    failFirst(new Error('closed'));
    await expect(first).rejects.toThrow('closed');
    const { undo } = await second;
    // The first rolled back cleanly (its stash was there), the second drew on the clean page.
    expect(mockFs.get(pageUri('d1', 0))).toBe('b64:SIGNED(page0-enhanced)');
    expect(mockFs.get(pageUri('d1', 1))).toBe('page1-enhanced');
    // And the second's Undo goes back to the clean page, not the half-signed one.
    await undoStamp(undo!);
    expect(mockFs.get(pageUri('d1', 0))).toBe('page0-enhanced');
  });

  test('a new run never deletes an earlier run’s Undo', async () => {
    const a = await stampPages('d1', [0], render);
    const b = await stampPages('d1', [1], render);
    expect(a.undo!.dir).not.toBe(b.undo!.dir);
    await undoStamp(a.undo!);
    expect(mockFs.get(pageUri('d1', 0))).toBe('page0-enhanced');
    expect(mockFs.get(pageUri('d1', 1))).toBe('b64:SIGNED(page1-enhanced)');
  });
});

describe('a rollback that fails is reported truthfully (r9 code #2)', () => {
  test('kind partial names the changed pages and keeps their stash', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    render.mockImplementationOnce(render.getMockImplementation()!);
    render.mockImplementationOnce(async (page: string, orig: string | null) => {
      mockLayout = 1; // pages reordered meanwhile: neither the write nor the rollback may go on
      return render.getMockImplementation()!(page, orig);
    });
    const err = await stampPages('d1', [0, 1, 2], render).catch(e => e);
    expect(err).toBeInstanceOf(StampError);
    expect(err.kind).toBe('partial');
    expect(err.message).toBe('Page 1 was changed before the error and couldn’t be put back. The other pages weren’t changed.');
    expect(err.message).not.toMatch(/unchanged/);
    expect(err.partial.changed).toEqual([0]);
    expect(err.partial.undo.pages.map((p: any) => p.index)).toEqual([0]);
    expect(mockFs.has(err.partial.undo.pages[0].stash)).toBe(true);
    // Once the pages are back where they were, putting them back works.
    mockLayout = 0;
    await undoStamp(err.partial.undo);
    expect(mockFs.get(pageUri('d1', 0))).toBe('page0-enhanced');
  });

  test('messages', () => {
    expect(pagesPhrase([1])).toBe('page 2');
    expect(pagesPhrase([2, 0])).toBe('pages 1 and 3');
    expect(pagesPhrase([0, 1, 3])).toBe('pages 1, 2 and 4');
    expect(partialMessage([0, 1], 2)).toBe('Pages 1 and 2 were changed before the error and couldn’t be put back.');
  });
});

describe('Save as a copy (r9 code #4)', () => {
  test('the copy is pending (hidden) until every page carries the mark', async () => {
    const storage = jest.requireMock('../lib/storage');
    const pendingWhileDrawing: boolean[] = [];
    render.mockImplementation(async (page: string, orig: string | null) => {
      pendingWhileDrawing.push(mockPending.has('copy1'));
      return {
        page: `data:image/jpeg;base64,SIGNED(${mockFs.get(page)})`,
        orig: orig ? `data:image/jpeg;base64,SIGNED(${mockFs.get(orig)})` : null,
      };
    });
    const copy = await stampCopy(mockDoc, 'Lease (signed)', [0, 1], render);
    expect(storage.savePendingDocument).toHaveBeenCalledTimes(1);
    expect(pendingWhileDrawing).toEqual([true, true]);
    expect(mockPending.has('copy1')).toBe(false);
    expect(copy.name).toBe('Lease (signed)');
    expect(mockFs.get(pageUri('copy1', 1))).toBe('b64:SIGNED(page1-enhanced)');
    expect(mockFs.get(origUri('copy1', 1))).toBe('b64:SIGNED(page1-raw)');
    // The original is untouched.
    expect(mockFs.get(pageUri('d1', 1))).toBe('page1-enhanced');
    render.mockImplementation(baseRender);
  });

  test('a failure removes the copy (record and files)', async () => {
    render.mockImplementationOnce(render.getMockImplementation()!);
    render.mockImplementationOnce(async () => { throw new Error('webview died'); });
    await expect(stampCopy(mockDoc, 'Lease (signed)', [0, 1], render)).rejects.toThrow('webview died');
    expect(mockOthers.has('copy1')).toBe(false);
    expect([...mockFs.keys()].some(k => k.includes('/copy1/'))).toBe(false);
  });
});

describe('a run the app died in the middle of (crash journal)', () => {
  /** Runs a three-page stamp that never gets past page 3: the app is killed there. */
  async function crashOnThirdPage() {
    let calls = 0;
    const hang = jest.fn(async (page: string, orig: string | null) => {
      if (++calls === 3) return new Promise<never>(() => {}); // killed while drawing page 3
      return baseRender(page, orig);
    });
    // Its own module instance: the hung run must not hold up later tests' runs.
    jest.resetModules();
    const dying = require('../lib/page-stamp') as typeof import('../lib/page-stamp');
    void dying.stampPages('d1', [0, 1, 2], hang);
    for (let i = 0; i < 50 && calls < 3; i++) await new Promise(r => setTimeout(r, 0));
    expect(mockFs.get(pageUri('d1', 0))).toBe('b64:SIGNED(page0-enhanced)');
    expect(mockFs.get(pageUri('d1', 1))).toBe('b64:SIGNED(page1-enhanced)');
    // The next launch: a new process, the same disk and records.
    jest.resetModules();
    return require('../lib/page-stamp') as typeof import('../lib/page-stamp');
  }

  test('the next launch puts back every page the run had marked, with its shadow, filter and adjustments', async () => {
    const next = await crashOnThirdPage();
    mockDoc = { ...mockDoc, filters: ['grayscale', 'grayscale', 'bw'] }; // as if recorded mid-run
    expect(await next.recoverInterruptedStamps()).toBe(2);
    expect(mockFs.get(pageUri('d1', 0))).toBe('page0-enhanced');
    expect(mockFs.get(pageUri('d1', 1))).toBe('page1-enhanced');
    expect(mockFs.get(origUri('d1', 1))).toBe('page1-raw');
    expect(mockFs.get(pageUri('d1', 2))).toBe('page2-enhanced'); // never touched
    expect(mockDoc.filters).toEqual(['original', 'enhanced', 'bw']);
    expect(mockDoc.adjustments[1]).toEqual({ brightness: 20, contrast: 0, saturation: 0 });
    // The stash and its journal are gone; a second launch does nothing.
    expect(stashKeys()).toEqual([]);
    expect(await next.recoverInterruptedStamps()).toBe(0);
  });

  test('a page changed since (it no longer holds what the run wrote) is left alone', async () => {
    const next = await crashOnThirdPage();
    mockFs.set(pageUri('d1', 1), 'edited-later');
    expect(await next.recoverInterruptedStamps()).toBe(1);
    expect(mockFs.get(pageUri('d1', 0))).toBe('page0-enhanced');
    expect(mockFs.get(pageUri('d1', 1))).toBe('edited-later');
  });

  test('a finished run leaves no journal: its stash is just dropped on the next launch', async () => {
    await stampPages('d1', [0, 1], render);
    jest.resetModules();
    const next = require('../lib/page-stamp') as typeof import('../lib/page-stamp');
    expect(await next.recoverInterruptedStamps()).toBe(0);
    expect(mockFs.get(pageUri('d1', 0))).toBe('b64:SIGNED(page0-enhanced)');
    expect(stashKeys()).toEqual([]);
  });

  test('this session’s own stashes (an Undo still on offer) are never touched', async () => {
    const { undo } = await stampPages('d1', [0], render);
    expect(await recoverInterruptedStamps()).toBe(0);
    expect(stashKeys().length).toBeGreaterThan(0);
    await undoStamp(undo!);
    expect(mockFs.get(pageUri('d1', 0))).toBe('page0-enhanced');
  });
});

describe('Redact (option redact)', () => {
  const srcUri = (doc: string, i: number, ext: 'jpg' | 'json') => `${root}/${doc}/page-${i}.src.${ext}`;
  beforeEach(() => {
    mockOcrAvailable = true;
    mockFs.set(srcUri('d1', 1, 'jpg'), 'photo1-uncropped');
    mockFs.set(srcUri('d1', 1, 'json'), '{"v":1}');
    mockDoc = { ...mockDoc, ocrText: 'Account holder John Smith' };
  });

  test('burns into page and shadow, drops the source photo, keeps it only in the Undo stash', async () => {
    const { undo } = await stampPages('d1', [1], render, { redact: true });
    expect(mockFs.get(pageUri('d1', 1))).toBe('b64:SIGNED(page1-enhanced)');
    expect(mockFs.get(origUri('d1', 1))).toBe('b64:SIGNED(page1-raw)');
    // Crop › Full page can't show the page uncovered: the photo is gone.
    expect(mockFs.has(srcUri('d1', 1, 'jpg'))).toBe(false);
    expect(mockFs.has(srcUri('d1', 1, 'json'))).toBe(false);
    // …but Undo can bring it back while it is offered.
    const stashed = [...mockFs.keys()].filter(k => k.startsWith(`${undo!.dir}/`));
    expect(stashed.some(k => k.endsWith('/page-0.src.jpg'))).toBe(true);
    expect(stashed.some(k => k.endsWith('/page-0.src.json'))).toBe(true);
  });

  test('the search text is cleared, the old text pruned, and the index rebuilt before it resolves', async () => {
    const order: string[] = [];
    mockPrune.mockImplementation(() => order.push('prune'));
    mockPatch.mockImplementationOnce(async (id: string, p: any) => {
      order.push(`patch:${JSON.stringify(p)}`);
      mockDoc = { ...mockDoc, ...p };
      return true;
    });
    // The page write's own patch (updatedAt) comes first; record from the redact patch on.
    mockPatch.mockImplementation(async (id: string, p: any) => {
      if ('ocrText' in p) order.push(`clear:${p.ocrText === undefined}`);
      mockDoc = { ...mockDoc, ...p };
      return true;
    });
    let indexed = false;
    mockIndex.mockImplementationOnce(async () => {
      order.push('index');
      await new Promise(r => setTimeout(r, 5));
      indexed = true;
    });
    await stampPages('d1', [1], render, { redact: true });
    expect(indexed).toBe(true); // awaited, not fired and forgotten
    expect(order.filter(o => !o.startsWith('patch:'))).toEqual(['prune', 'clear:true', 'index']);
    expect(mockPrune).toHaveBeenCalledWith('d1');
    expect(mockDoc.ocrText).toBeUndefined();
    mockPatch.mockImplementation(async (id: string, p: any) => {
      if (id === 'd1') mockDoc = { ...mockDoc, ...p };
      else if (mockOthers.has(id)) mockOthers.set(id, { ...mockOthers.get(id), ...p });
      else return false;
      return true;
    });
  });

  test('without text recognition the old text is still removed (never left behind)', async () => {
    mockOcrAvailable = false;
    await stampPages('d1', [1], render, { redact: true });
    expect(mockDoc.ocrText).toBeUndefined();
    expect(mockIndex).not.toHaveBeenCalled();
  });

  test('a normal stamp leaves the source photo and the text alone', async () => {
    await stampPages('d1', [1], render);
    expect(mockFs.get(srcUri('d1', 1, 'jpg'))).toBe('photo1-uncropped');
    expect(mockDoc.ocrText).toBe('Account holder John Smith');
    expect(mockPrune).not.toHaveBeenCalled();
  });

  test('each page gets its own boxes: the renderer is told the page index', async () => {
    await stampPages('d1', [0, 2], render, { redact: true });
    expect(render.mock.calls.map(c => (c as unknown[])[2])).toEqual([0, 2]);
  });

  test('a redacted copy starts without the original text and drops its own source photos', async () => {
    mockFs.set(srcUri('copy1', 1, 'jpg'), 'photo1-uncropped'); // copyDocumentFiles carries them
    const copy = await stampCopy(mockDoc, 'Lease (redacted)', [1], render, undefined, undefined, { redact: true });
    expect(copy.ocrText).toBeUndefined();
    expect(mockFs.has(srcUri('copy1', 1, 'jpg'))).toBe(false);
    expect(mockIndex).toHaveBeenCalledWith('copy1', expect.any(Array));
    // The original keeps everything.
    expect(mockDoc.ocrText).toBe('Account holder John Smith');
    expect(mockFs.get(srcUri('d1', 1, 'jpg'))).toBe('photo1-uncropped');
  });
});
