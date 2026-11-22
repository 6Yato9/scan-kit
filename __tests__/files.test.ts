const mockFileInstances: Record<string, any> = {};
const mockDirInstances: Record<string, any> = {};
// Content-tracking copy/delete/move. These stay jest.fn spies (existing tests
// assert on call counts), but they also move bytes, so a test can prove that the
// RIGHT file landed at the right index — which is the whole point of the .orig
// shadow: if it drifts from its page, the next filter bake re-derives from the
// wrong image.
const fileContents: Record<string, string> = {};
// Last-modified times (ms) by uri; unset = long ago (settled).
const mockMtimes: Record<string, number> = {};
const mockCopy = jest.fn(function (this: any, dest: any) {
  fileContents[dest.uri] = fileContents[this.uri];
  dest.exists = true;
});
const mockDelete = jest.fn(function (this: any) {
  delete fileContents[this.uri];
  this.exists = false;
});
const mockMove = jest.fn(function (this: any, dest: any) {
  if (!this.exists) throw new Error(`move: ${this.uri} missing`);
  // FileManager.moveItem refuses an existing destination. (Instances default to
  // exists = true, so only a destination holding seeded bytes counts here.)
  if (dest.exists && dest.uri in fileContents) throw new Error(`move: ${dest.uri} exists`);
  fileContents[dest.uri] = fileContents[this.uri];
  delete fileContents[this.uri];
  dest.exists = true;
  this.exists = false;
});

jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn().mockResolvedValue({ uri: 'file:///tmp/compressed.jpg' }),
  SaveFormat: { JPEG: 'jpeg' },
}));

const mockGetImageSize = jest.fn().mockResolvedValue({ width: 1000, height: 1400 });
jest.mock('../lib/image-size', () => ({
  ...jest.requireActual('../lib/image-size'),
  getImageSize: (...args: any[]) => mockGetImageSize(...args),
}));

// Real classes defined INSIDE the factory (not jest.fn().mockImplementation
// returning object literals) so that `instanceof File` / `instanceof
// Directory` checks in garbageCollectOrphans work against these mocks.
// Defining them here (rather than referencing outer class declarations) also
// sidesteps jest's mock-hoisting: this factory runs at require-time, before
// any later top-level declarations in this file would otherwise be
// initialized. Instances are cached by uri so a test can grab the same
// instance the production code will use (e.g. to pre-set `.exists` or stub
// `.list()`) by importing { File, Directory } from 'expo-file-system' itself.
jest.mock('expo-file-system', () => {
  const part = (p: any) => (p && typeof p === 'object' ? p.uri : p);
  class MockFile {
    uri!: string;
    exists = true;
    copy = mockCopy;
    delete = mockDelete;
    move = mockMove;
    create = jest.fn(function (this: any) { this.exists = true; fileContents[this.uri] = ''; });
    info = jest.fn(function (this: any) { return { exists: this.exists, modificationTime: mockMtimes[this.uri] ?? 1 }; });
    write = jest.fn(function (this: any, content: string) { fileContents[this.uri] = content; this.exists = true; });
    textSync = jest.fn(function (this: any) { return fileContents[this.uri] ?? ''; });
    constructor(dirOrUri: any, name?: string) {
      const uri = name ? `${part(dirOrUri)}/${name}` : String(part(dirOrUri));
      if (mockFileInstances[uri]) return mockFileInstances[uri];
      this.uri = uri;
      mockFileInstances[uri] = this;
    }
  }

  class MockDirectory {
    uri!: string;
    create = jest.fn();
    delete = jest.fn();
    list = jest.fn(() => []);
    info = jest.fn(function (this: any) { return { exists: this.exists, modificationTime: mockMtimes[this.uri] ?? 1 }; });
    exists = true;
    constructor(...parts: any[]) {
      const uri = parts.map(part).join('/');
      if (mockDirInstances[uri]) return mockDirInstances[uri];
      this.uri = uri;
      mockDirInstances[uri] = this;
    }
  }

  return {
    File: MockFile,
    Directory: MockDirectory,
    Paths: {
      document: { uri: 'file:///documents' },
      cache: { uri: 'file:///Library/Caches/' },
    },
  };
});

// The OCR cache is tested on its own (ocr-cache.test.ts); here only that the
// file operations that remove pages or documents tell it to.
jest.mock('../lib/ocr-cache', () => ({ forgetDocumentOcr: jest.fn(), pruneDocumentOcr: jest.fn() }));

import {
  deleteDocumentFiles,
  deleteSinglePage,
  appendPages,
  reorderPages,
  copyDocumentFiles,
  copyPageWithQuality,
  copyPdfToStorage,
  originalUri,
  ensureOriginal,
  garbageCollectOrphans,
  copyPageWithShadow,
  replaceOriginal,
  originalSideUri,
  promoteOriginalSide,
  shadowOf,
  replacePage,
  isDisposableTemp,
  deleteDisposableTemps,
  sweepTempLeftovers,
  stagedAt,
  sweepConvertLeftovers,
  restorePageWithShadow,
  pageLayoutGeneration,
} from '../lib/files';
import { cappedSize, MAX_PAGE_EDGE } from '../lib/image-size';
import { forgetDocumentOcr as mockForgetOcr, pruneDocumentOcr as mockPruneOcr } from '../lib/ocr-cache';
import { manipulateAsync } from 'expo-image-manipulator';

// The mock caches File/Directory instances by uri and `delete` now clears
// `exists`, so state would otherwise leak between tests. Reset the caches and
// the content store before each one.
beforeEach(() => {
  for (const k of Object.keys(mockFileInstances)) delete mockFileInstances[k];
  for (const k of Object.keys(mockDirInstances)) delete mockDirInstances[k];
  for (const k of Object.keys(fileContents)) delete fileContents[k];
  for (const k of Object.keys(mockMtimes)) delete mockMtimes[k];
  mockGetImageSize.mockResolvedValue({ width: 1000, height: 1400 });
});
// Same mocked classes lib/files.ts uses (see the expo-file-system mock above),
// so tests can construct the exact File/Directory instances the production
// code will look up by uri. Cast to `any`: the real expo-file-system .d.ts
// constructor signatures don't match this lightweight mock's.
import { File as RawFile, Directory as RawDirectory } from 'expo-file-system';
const MockFile = RawFile as any;
const MockDirectory = RawDirectory as any;
const mockManipulate = manipulateAsync as jest.Mock;

describe('appendPages', () => {
  beforeEach(() => jest.clearAllMocks());

  it('copies each temp URI to storage and returns URIs', () => {
    const uris = appendPages(['file:///tmp/a.jpg', 'file:///tmp/b.jpg'], 'doc1', 2);
    expect(mockCopy).toHaveBeenCalledTimes(2);
    expect(uris).toHaveLength(2);
  });
});

describe('deleteSinglePage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes target file and copies subsequent files down', () => {
    deleteSinglePage('doc1', 1, 3);
    // page-1 deleted, page-2 renamed to page-1 (no copies, no temp files)
    expect(mockDelete).toHaveBeenCalled();
    expect(mockMove).toHaveBeenCalled();
    expect(mockCopy).not.toHaveBeenCalled();
  });
});

describe('reorderPages', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns correct number of URIs for new order', () => {
    const result = reorderPages('doc1', [2, 0, 1]);
    expect(result).toHaveLength(3);
  });
});

describe('copyDocumentFiles', () => {
  beforeEach(() => jest.clearAllMocks());

  it('copies each page file and returns destination URIs', () => {
    const pages = ['file:///docs/scan-kit/src/page-0.jpg', 'file:///docs/scan-kit/src/page-1.jpg'];
    // A document that was never filtered has no .orig shadows to carry across.
    for (const i of [0, 1]) {
      for (const suffix of ['.orig.jpg', '.src.jpg', '.src.json']) {
        (new RawFile(new RawDirectory('file:///documents', 'scan-kit', 'src'), `page-${i}${suffix}`) as any).exists = false;
      }
    }
    const uris = copyDocumentFiles('src', 'dest', pages);
    expect(mockCopy).toHaveBeenCalledTimes(2);
    expect(uris).toHaveLength(2);
  });
});

describe('copyPageWithQuality', () => {
  beforeEach(() => jest.clearAllMocks());

  it('copies without manipulation when quality is 1', async () => {
    await copyPageWithQuality('file:///tmp/a.jpg', 'doc1', 0, 1);
    expect(mockManipulate).not.toHaveBeenCalled();
    expect(mockCopy).toHaveBeenCalledTimes(1);
  });

  it('uses manipulateAsync when quality < 1', async () => {
    await copyPageWithQuality('file:///tmp/a.jpg', 'doc1', 0, 0.75);
    expect(mockManipulate).toHaveBeenCalledWith(
      'file:///tmp/a.jpg',
      [],
      { compress: 0.75, format: 'jpeg' }
    );
    // The manipulator's output is renamed into place, not copied and deleted.
    expect(mockMove).toHaveBeenCalledTimes(1);
    expect(mockCopy).not.toHaveBeenCalled();
  });
});

describe('copyPdfToStorage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('copies the PDF file and returns the stored URI', () => {
    const uri = copyPdfToStorage('file:///tmp/doc.pdf', 'doc1');
    expect(mockCopy).toHaveBeenCalledTimes(1);
    expect(uri).toContain('document.pdf');
  });
});

describe('originalUri', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the .orig.jpg URI for a page without touching the filesystem', () => {
    const uri = originalUri('orig-doc-uri', 2);
    expect(uri).toBe('file:///documents/scan-kit/orig-doc-uri/page-2.orig.jpg');
    expect(mockCopy).not.toHaveBeenCalled();
  });
});

describe('ensureOriginal', () => {
  beforeEach(() => jest.clearAllMocks());

  it('copies page-N.jpg to page-N.orig.jpg when the .orig does not yet exist', () => {
    const dir = new MockDirectory('file:///documents', 'scan-kit', 'ensure-doc-1');
    const orig = new MockFile(dir, 'page-0.orig.jpg');
    orig.exists = false;

    const uri = ensureOriginal('ensure-doc-1', 0);

    expect(mockCopy).toHaveBeenCalledTimes(1);
    expect(uri).toBe(orig.uri);
  });

  it('is idempotent: does not re-copy when the .orig already exists', () => {
    const dir = new MockDirectory('file:///documents', 'scan-kit', 'ensure-doc-2');
    const orig = new MockFile(dir, 'page-0.orig.jpg');
    orig.exists = true;

    const uri = ensureOriginal('ensure-doc-2', 0);

    expect(mockCopy).not.toHaveBeenCalled();
    expect(uri).toBe(orig.uri);
  });
});

describe('garbageCollectOrphans and .orig.jpg', () => {
  beforeEach(() => jest.clearAllMocks());

  it('never deletes a page-N.orig.jpg inside a valid doc directory', async () => {
    const root = new MockDirectory('file:///documents', 'scan-kit');
    const docDir = new MockDirectory('file:///documents', 'scan-kit', 'valid-doc');
    root.list = jest.fn(() => [docDir]);
    root.exists = true;

    const page = new MockFile(docDir, 'page-0.jpg');
    const origFile = new MockFile(docDir, 'page-0.orig.jpg');
    const staleTemp = new MockFile(docDir, 'page-0.tmp.jpg');
    docDir.list = jest.fn(() => [page, origFile, staleTemp]);

    const deletedCount = await garbageCollectOrphans(['valid-doc']);

    // `delete` is a shared mock fn across all File instances, so distinguish
    // which instance it was called on via jest's recorded `this` per call.
    expect(mockDelete.mock.instances).not.toContain(origFile);
    expect(mockDelete.mock.instances).toContain(staleTemp);
    expect(deletedCount).toBe(1);
  });
});

describe('garbageCollectOrphans with an empty id list', () => {
  beforeEach(() => jest.clearAllMocks());

  it('refuses to sweep (an empty list means the index was unreadable)', async () => {
    const root = new MockDirectory('file:///documents', 'scan-kit');
    const docDir = new MockDirectory('file:///documents', 'scan-kit', 'some-doc');
    root.list = jest.fn(() => [docDir]);
    root.exists = true;

    const deletedCount = await garbageCollectOrphans([]);

    expect(docDir.delete).not.toHaveBeenCalled();
    expect(deletedCount).toBe(0);
  });
});

function pageFileFor(docId: string, i: number, orig = false) {
  return new RawFile(new RawDirectory('file:///documents', 'scan-kit', docId), `page-${i}${orig ? '.orig' : ''}.jpg`) as any;
}
function seedPage(docId: string, i: number, content: string) {
  const f: any = pageFileFor(docId, i);
  f.exists = true;
  fileContents[f.uri] = content;
}
function seedOrig(docId: string, i: number, content: string) {
  const f: any = pageFileFor(docId, i, true);
  f.exists = true;
  fileContents[f.uri] = content;
}
const readPage = (docId: string, i: number) => fileContents[pageFileFor(docId, i).uri];
const readOrig = (docId: string, i: number) => fileContents[pageFileFor(docId, i, true).uri];
const existsOrig = (docId: string, i: number) => (pageFileFor(docId, i, true) as any).exists;

describe('.orig shadows stay aligned with their pages', () => {
  // page-N.orig.jpg is the unfiltered source every filter bake re-derives from.
  // It must track its page through every file operation: if it drifts, the next
  // bake silently swaps in the wrong image or discards a rotate/crop.

  test('deleteSinglePage shifts .orig files alongside their pages', () => {
    seedPage('doc-1', 0, 'A'); seedOrig('doc-1', 0, 'A-orig');
    seedPage('doc-1', 1, 'B'); seedOrig('doc-1', 1, 'B-orig');
    seedPage('doc-1', 2, 'C'); seedOrig('doc-1', 2, 'C-orig');

    deleteSinglePage('doc-1', 0, 3);

    expect(readPage('doc-1', 0)).toBe('B');
    expect(readOrig('doc-1', 0)).toBe('B-orig');
    expect(readPage('doc-1', 1)).toBe('C');
    expect(readOrig('doc-1', 1)).toBe('C-orig');
    expect(existsOrig('doc-1', 2)).toBe(false);
  });

  test('reorderPages reorders .orig files alongside their pages', () => {
    seedPage('doc-2', 0, 'A'); seedOrig('doc-2', 0, 'A-orig');
    seedPage('doc-2', 1, 'B'); seedOrig('doc-2', 1, 'B-orig');

    reorderPages('doc-2', [1, 0]);

    expect(readPage('doc-2', 0)).toBe('B');
    expect(readOrig('doc-2', 0)).toBe('B-orig');
    expect(readPage('doc-2', 1)).toBe('A');
    expect(readOrig('doc-2', 1)).toBe('A-orig');
  });

  test('a page without an .orig is still handled', () => {
    seedPage('doc-3', 0, 'A');
    seedPage('doc-3', 1, 'B'); seedOrig('doc-3', 1, 'B-orig');

    deleteSinglePage('doc-3', 0, 2);

    expect(readPage('doc-3', 0)).toBe('B');
    expect(readOrig('doc-3', 0)).toBe('B-orig');
  });

  test('copyDocumentFiles carries .orig into the duplicate', () => {
    seedPage('src-1', 0, 'A'); seedOrig('src-1', 0, 'A-orig');

    copyDocumentFiles('src-1', 'dst-1', ['p0']);

    expect(readPage('dst-1', 0)).toBe('A');
    // Without this the duplicate has no pristine source, so its first filter
    // change would bake on top of already-filtered pixels.
    expect(readOrig('dst-1', 0)).toBe('A-orig');
  });
});

describe('copying pages between documents keeps .orig shadows', () => {
  const stored = (docId: string, i: number) => pageFileFor(docId, i).uri as string;

  test('shadowOf only recognises stored page files', () => {
    expect(shadowOf('file:///documents/scan-kit/d/page-3.jpg?v=12')).toBe('file:///documents/scan-kit/d/page-3.orig.jpg');
    expect(shadowOf('file:///tmp/scanner/IMG_0001.jpg')).toBeNull();
    expect(shadowOf('file:///documents/scan-kit/d/page-3.orig.jpg')).toBeNull();
  });

  test('appendPages (merge) carries each source .orig to the new index', () => {
    seedPage('m-src', 0, 'A'); seedOrig('m-src', 0, 'A-orig');
    seedPage('m-src', 1, 'B'); seedOrig('m-src', 1, 'B-orig');

    appendPages([stored('m-src', 0), `${stored('m-src', 1)}?v=99`], 'm-dst', 3);

    expect(readPage('m-dst', 3)).toBe('A');
    expect(readOrig('m-dst', 3)).toBe('A-orig');
    expect(readPage('m-dst', 4)).toBe('B');
    expect(readOrig('m-dst', 4)).toBe('B-orig');
  });

  test('copyPageWithShadow clears a stale destination .orig when the source has none', () => {
    seedPage('x-src', 2, 'C');
    (pageFileFor('x-src', 2, true) as any).exists = false;
    seedOrig('x-dst', 0, 'STALE');

    copyPageWithShadow(stored('x-src', 2), 'x-dst', 0);

    expect(readPage('x-dst', 0)).toBe('C');
    expect(existsOrig('x-dst', 0)).toBe(false);
  });

  test('replaceOriginal swaps the shadow and is a no-op without one', () => {
    seedOrig('r-doc', 0, 'OLD');
    const tmp: any = new RawFile('file:///tmp/compressed-orig.jpg');
    fileContents[tmp.uri] = 'NEW';

    expect(replaceOriginal(tmp.uri, 'r-doc', 0)).toBe(true);
    expect(readOrig('r-doc', 0)).toBe('NEW');

    (pageFileFor('r-doc', 1, true) as any).exists = false;
    expect(replaceOriginal(tmp.uri, 'r-doc', 1)).toBe(false);
    expect(existsOrig('r-doc', 1)).toBe(false);
  });

  test('a shadow written to originalSideUri replaces the .orig only when promoted (mark up)', () => {
    seedOrig('m-doc', 0, 'OLD');
    const side: any = new RawFile(originalSideUri('m-doc', 0));
    expect(side.uri).toMatch(/\/m-doc\/page-0\.orig\.new\.jpg$/);
    side.exists = true;
    fileContents[side.uri] = 'INKED';
    // Written but not promoted (the app died here): the shadow is untouched.
    expect(readOrig('m-doc', 0)).toBe('OLD');
    promoteOriginalSide('m-doc', 0);
    expect(readOrig('m-doc', 0)).toBe('INKED');
  });
});

// ── Crash safety (critique #8), temp files (#10), sweep races (#9) ──────────

const DOCS = 'file:///documents/scan-kit';
const docDirOf = (id: string) => new MockDirectory('file:///documents', 'scan-kit', id);
function seedFile(docId: string, name: string, content: string, mtime?: number) {
  const f: any = new MockFile(docDirOf(docId), name);
  f.exists = true;
  fileContents[f.uri] = content;
  if (mtime !== undefined) mockMtimes[f.uri] = mtime;
  return f;
}
const read = (docId: string, name: string) => fileContents[`${DOCS}/${docId}/${name}`];
/** Makes docDir.list() return exactly the files that currently hold bytes. */
function listFromContents(docId: string) {
  const dir = docDirOf(docId);
  dir.list = jest.fn(() => Object.keys(fileContents)
    .filter(u => u.startsWith(`${DOCS}/${docId}/`))
    .map(u => new MockFile(u)));
  return dir;
}
function rootWith(...dirs: any[]) {
  const root = new MockDirectory('file:///documents', 'scan-kit');
  root.exists = true;
  root.list = jest.fn(() => dirs);
  return root;
}

describe('replacePage is a rename, and an interrupted one is recovered', () => {
  beforeEach(() => jest.clearAllMocks());

  test('replacePage puts the new bytes in place and leaves no side file', () => {
    seedFile('rp', 'page-0.jpg', 'OLD');
    const tmp: any = new MockFile('file:///tmp/rotated.jpg');
    fileContents[tmp.uri] = 'NEW';
    replacePage('file:///tmp/rotated.jpg?v=2', 'rp', 0);
    expect(read('rp', 'page-0.jpg')).toBe('NEW');
    expect(read('rp', 'page-0.new.jpg')).toBeUndefined();
    expect(mockMove).toHaveBeenCalledTimes(1);
  });

  test('the sweep promotes a .new file whose page was already deleted (the only copy)', async () => {
    seedFile('rp2', 'page-0.jpg', 'A');
    seedFile('rp2', 'page-1.new.jpg', 'B-rotated'); // page-1.jpg gone: crash mid-swap
    seedFile('rp2', 'page-2.orig.new.jpg', 'C-orig-new');
    const dir = listFromContents('rp2');
    rootWith(dir);
    await garbageCollectOrphans(['rp2']);
    expect(read('rp2', 'page-1.jpg')).toBe('B-rotated');
    expect(read('rp2', 'page-1.new.jpg')).toBeUndefined();
    expect(read('rp2', 'page-2.orig.jpg')).toBe('C-orig-new');
  });

  test('the sweep deletes a .new file whose page still exists (a duplicate)', async () => {
    seedFile('rp3', 'page-0.jpg', 'A');
    seedFile('rp3', 'page-0.new.jpg', 'A-new');
    rootWith(listFromContents('rp3'));
    await garbageCollectOrphans(['rp3']);
    expect(read('rp3', 'page-0.jpg')).toBe('A');
    expect(read('rp3', 'page-0.new.jpg')).toBeUndefined();
  });

  test('the sweep restores a legacy .shifting file to the slot it was headed for', async () => {
    seedFile('sh', 'page-0.jpg', 'A');
    seedFile('sh', 'page-2.shifting.jpg', 'C'); // was moving to page-1, which is gone
    rootWith(listFromContents('sh'));
    await garbageCollectOrphans(['sh']);
    expect(read('sh', 'page-1.jpg')).toBe('C');
  });

  test('a side file touched moments ago is left alone (an edit may still be running)', async () => {
    const now = 10_000_000_000;
    seedFile('fresh', 'page-0.new.jpg', 'X', now - 5_000);
    rootWith(listFromContents('fresh'));
    await garbageCollectOrphans(['fresh'], now);
    expect(read('fresh', 'page-0.new.jpg')).toBe('X');
    expect(read('fresh', 'page-0.jpg')).toBeUndefined();
  });
});

describe('reorderPages is two-phase and recoverable', () => {
  beforeEach(() => jest.clearAllMocks());

  test('leaves no temp files or commit marker behind', () => {
    seedFile('ro', 'page-0.jpg', 'A');
    seedFile('ro', 'page-1.jpg', 'B');
    seedFile('ro', 'page-2.jpg', 'C');
    reorderPages('ro', [2, 0, 1]);
    expect([read('ro', 'page-0.jpg'), read('ro', 'page-1.jpg'), read('ro', 'page-2.jpg')]).toEqual(['C', 'A', 'B']);
    expect(Object.keys(fileContents).filter(u => /tmp|commit/.test(u))).toEqual([]);
  });

  test('a crash before the commit is undone: temps deleted, original order kept', async () => {
    seedFile('ro1', 'page-0.jpg', 'A');
    seedFile('ro1', 'page-1.jpg', 'B');
    seedFile('ro1', 'page-tmp-0.jpg', 'B'); // phase 1 copy for new order [1, 0]
    rootWith(listFromContents('ro1'));
    await garbageCollectOrphans(['ro1']);
    expect([read('ro1', 'page-0.jpg'), read('ro1', 'page-1.jpg')]).toEqual(['A', 'B']);
    expect(read('ro1', 'page-tmp-0.jpg')).toBeUndefined();
  });

  test('a crash after the commit is finished: remaining temps promoted, nothing lost', async () => {
    // New order [1, 0]: page-0 already promoted (now B), page-1 still old A,
    // and A's copy waits in page-tmp-1.
    seedFile('ro2', 'page-0.jpg', 'B');
    seedFile('ro2', 'page-1.jpg', 'A-stale');
    seedFile('ro2', 'page-tmp-1.jpg', 'A');
    seedFile('ro2', 'reorder.commit', '');
    rootWith(listFromContents('ro2'));
    await garbageCollectOrphans(['ro2']);
    expect([read('ro2', 'page-0.jpg'), read('ro2', 'page-1.jpg')]).toEqual(['B', 'A']);
    expect(read('ro2', 'reorder.commit')).toBeUndefined();
  });
});

describe('ensureOriginal is atomic', () => {
  test('the shadow appears in one rename, and a half-copied one is cleaned up', async () => {
    seedFile('eo', 'page-0.jpg', 'RAW');
    (new MockFile(docDirOf('eo'), 'page-0.orig.jpg') as any).exists = false;
    ensureOriginal('eo', 0);
    expect(read('eo', 'page-0.orig.jpg')).toBe('RAW');
    expect(read('eo', 'page-0.orig.part.jpg')).toBeUndefined();

    seedFile('eo2', 'page-0.jpg', 'RAW');
    seedFile('eo2', 'page-0.orig.part.jpg', 'RA'); // app died mid-copy
    rootWith(listFromContents('eo2'));
    await garbageCollectOrphans(['eo2']);
    expect(read('eo2', 'page-0.orig.part.jpg')).toBeUndefined();
    expect(read('eo2', 'page-0.orig.jpg')).toBeUndefined(); // never promoted
  });
});

describe('the orphan sweep', () => {
  beforeEach(() => jest.clearAllMocks());

  test('removes a folder with no record once it has settled', async () => {
    const orphan = docDirOf('gone');
    rootWith(docDirOf('kept'), orphan);
    await garbageCollectOrphans(['kept']);
    expect(orphan.delete).toHaveBeenCalled();
  });

  test('keeps a folder being written right now — a save that has no record yet (critique #9)', async () => {
    const now = 10_000_000_000;
    const saving = docDirOf('saving');
    mockMtimes[saving.uri] = now - 1_000;
    rootWith(docDirOf('kept'), saving);
    await garbageCollectOrphans(['kept'], now);
    expect(saving.delete).not.toHaveBeenCalled();
  });

  test('keeps a folder whose age cannot be read', async () => {
    const unknown = docDirOf('unknown');
    unknown.info = jest.fn(() => { throw new Error('no attrs'); });
    rootWith(docDirOf('kept'), unknown);
    await garbageCollectOrphans(['kept']);
    expect(unknown.delete).not.toHaveBeenCalled();
  });
});

describe('copyPageWithQuality caps the page size (critique #1)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a 24 MP photo is shrunk to the long-edge cap', async () => {
    mockGetImageSize.mockResolvedValueOnce({ width: 5712, height: 4284 });
    await copyPageWithQuality('file:///tmp/big.jpg', 'cap', 0, 1);
    expect(mockManipulate).toHaveBeenCalledWith('file:///tmp/big.jpg', [{ resize: { width: MAX_PAGE_EDGE } }], { compress: 1, format: 'jpeg' });
  });

  test('a tall photo is capped on its height', async () => {
    mockGetImageSize.mockResolvedValueOnce({ width: 3000, height: 9000 });
    await copyPageWithQuality('file:///tmp/tall.jpg', 'cap', 0, 0.9);
    expect(mockManipulate).toHaveBeenCalledWith('file:///tmp/tall.jpg', [{ resize: { height: MAX_PAGE_EDGE } }], expect.any(Object));
  });

  test('replaces a page left behind by an earlier failed attempt (critique #5)', async () => {
    seedFile('cap2', 'page-3.jpg', 'STALE');
    const out: any = new MockFile('file:///tmp/compressed.jpg');
    fileContents[out.uri] = 'FRESH';
    out.exists = true;
    await copyPageWithQuality('file:///tmp/new.jpg', 'cap2', 3, 0.75);
    expect(read('cap2', 'page-3.jpg')).toBe('FRESH');
  });

  test('cappedSize keeps the aspect ratio and leaves small images alone', () => {
    expect(cappedSize(5712, 4284)).toEqual({ width: 4000, height: 3000 });
    expect(cappedSize(4000, 2000)).toBeNull();
  });
});

describe('temp files (critique #10)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('isDisposableTemp recognises picker, manipulator, auto-crop and scanner output only', () => {
    expect(isDisposableTemp('file:///Library/Caches/ImagePicker/A.jpg')).toBe(true);
    expect(isDisposableTemp('file:///tmp/doc-1234.jpg')).toBe(true);
    expect(isDisposableTemp('file:///documents/DOCUMENT_SCAN_0_20261118_103000.jpg?v=1')).toBe(true);
    // Documents is the user's: only the scanner's exact output name counts.
    expect(isDisposableTemp('file:///documents/DOCUMENT_SCAN_0_my-copy.jpg')).toBe(false);
    expect(isDisposableTemp('file:///documents/scan-kit/d/page-0.jpg')).toBe(false);
    expect(isDisposableTemp('file:///documents/Inbox/contract.pdf')).toBe(false);
    expect(isDisposableTemp(undefined)).toBe(false);
  });

  test('deleteDisposableTemps never deletes a stored page', () => {
    const stored = seedFile('keep', 'page-0.jpg', 'P');
    const temp: any = new MockFile('file:///Library/Caches/ImagePicker/x.jpg');
    fileContents[temp.uri] = 'T';
    deleteDisposableTemps([stored.uri, temp.uri]);
    expect(read('keep', 'page-0.jpg')).toBe('P');
    expect(fileContents[temp.uri]).toBeUndefined();
  });

  test('the startup sweep removes settled scanner output, keeps fresh files', () => {
    const now = 10_000_000_000;
    const old: any = new MockFile('file:///documents/DOCUMENT_SCAN_0_20261101_093000.jpg');
    const fresh: any = new MockFile('file:///documents/DOCUMENT_SCAN_1_20261118_103000.jpg');
    const mine: any = new MockFile('file:///documents/notes.txt');
    mockMtimes[fresh.uri] = now - 1000;
    const docsDir = new MockDirectory({ uri: 'file:///documents' });
    docsDir.list = jest.fn(() => [old, fresh, mine]);
    expect(sweepTempLeftovers(now)).toBe(1);
    expect(old.exists).toBe(false);
    expect(fresh.exists).toBe(true);
    expect(mine.exists).toBe(true);
  });

  test('the startup sweep removes a settled page-undo stash, keeps the one an Undo may still use', () => {
    const now = 10_000_000_000;
    const oldStash = new MockDirectory({ uri: 'file:///Library/Caches/' }, 'page-undo', '1');
    const liveStash = new MockDirectory({ uri: 'file:///Library/Caches/' }, 'page-undo', '2');
    mockMtimes[liveStash.uri] = now - 1000;
    const root = new MockDirectory({ uri: 'file:///Library/Caches/' }, 'page-undo');
    root.list = jest.fn(() => [oldStash, liveStash]);
    expect(sweepTempLeftovers(now)).toBe(1);
    expect(oldStash.delete).toHaveBeenCalled();
    expect(liveStash.delete).not.toHaveBeenCalled();
  });
});

describe('PDF page renders in Caches/pdf-thumbs (r12 code review #2)', () => {
  const CACHE = { uri: 'file:///Library/Caches/' };
  const thumbs = () => {
    const root = new MockDirectory(CACHE, 'pdf-thumbs');
    const items = {
      first: new MockFile(`${root.uri}/doc-a-171-900-g0.jpg`),
      pages: new MockDirectory(root, 'pages-doc-a-171-900-g0'),
      tmp: new MockDirectory(root, 'tmp-doc-a-171-900-g0-x'),
      other: new MockFile(`${root.uri}/doc-b-5-6-g0.jpg`),
      gone: new MockFile(`${root.uri}/doc-c-5-6-g0.jpg`),
    };
    root.list = jest.fn(() => Object.values(items).filter((i: any) => i.exists !== false));
    return items;
  };

  test('deleting a document removes its first-page and per-page renders, and its crop Undo copies', () => {
    const t = thumbs();
    const stashRoot = new MockDirectory(CACHE, 'page-source');
    const stash = new MockDirectory(stashRoot, 'undo-doc-a-1-1');
    const otherStash = new MockDirectory(stashRoot, 'undo-doc-b-1-1');
    stashRoot.list = jest.fn(() => [stash, otherStash]);
    deleteDocumentFiles('doc-a');
    expect(t.first.exists).toBe(false);
    expect(t.pages.delete).toHaveBeenCalled();
    expect(t.tmp.delete).toHaveBeenCalled();
    expect(t.other.exists).toBe(true);
    expect(stash.delete).toHaveBeenCalled();
    expect(otherStash.delete).not.toHaveBeenCalled();
  });

  test('the startup sweep keeps only the renders of documents that are still PDFs', async () => {
    const t = thumbs();
    await sweepConvertLeftovers(
      [
        { id: 'doc-a', pages: [`${DOCS}/doc-a/page-0.jpg`], updatedAt: 1 }, // converted to pages
        { id: 'doc-b', pages: [], pdfUri: `${DOCS}/doc-b/document.pdf`, updatedAt: 1 },
        // doc-c: deleted
      ],
      jest.fn(async (_id: string, act: any) => act(null)) as any,
    );
    expect(t.first.exists).toBe(false);
    expect(t.pages.delete).toHaveBeenCalled();
    expect(t.gone.exists).toBe(false);
    expect(t.other.exists).toBe(true);
  });
});

describe('restorePageWithShadow (retake Undo) never deletes before it has a copy', () => {
  beforeEach(() => jest.clearAllMocks());
  const stash = (page: string, orig?: string) => {
    const p: any = new MockFile('file:///Library/Caches/page-undo/7/page-0.jpg');
    p.exists = true;
    fileContents[p.uri] = page;
    const o: any = new MockFile('file:///Library/Caches/page-undo/7/page-0.orig.jpg');
    o.exists = orig !== undefined;
    if (orig !== undefined) fileContents[o.uri] = orig;
    return p.uri as string;
  };
  const leftovers = (docId: string) =>
    Object.keys(fileContents).filter(u => u.startsWith(`${DOCS}/${docId}/`) && /\.new\.jpg$/.test(u));

  test('puts the saved page and its shadow back, leaving no side files', () => {
    seedFile('u1', 'page-1.jpg', 'RETAKEN');
    seedFile('u1', 'page-1.orig.jpg', 'RETAKEN-orig');
    const uri = stash('OLD', 'OLD-orig');
    restorePageWithShadow(`${uri}?v=3`, 'u1', 1);
    expect(read('u1', 'page-1.jpg')).toBe('OLD');
    expect(read('u1', 'page-1.orig.jpg')).toBe('OLD-orig');
    expect(leftovers('u1')).toEqual([]);
  });

  test('stages the shadow in Caches/page-undo, which the startup sweep clears (r5 L6)', () => {
    seedFile('u5', 'page-0.jpg', 'RETAKEN');
    const uri = stash('OLD', 'OLD-orig');
    mockCopy.mockClear();
    restorePageWithShadow(uri, 'u5', 0);
    const staged = mockCopy.mock.calls.map(c => (c[0] as any).uri).find((u: string) => /restore-[\d-]+\.orig\.jpg$/.test(u));
    expect(staged).toMatch(/^file:\/\/\/Library\/Caches\/+page-undo\/restore-[\d-]+\.orig\.jpg$/);
    // Moved into place afterwards: nothing is left in the staging folder.
    expect(fileContents[staged!]).toBeUndefined();
    expect(read('u5', 'page-0.orig.jpg')).toBe('OLD-orig');
  });

  test('a saved page without a shadow drops the current shadow', () => {
    seedFile('u2', 'page-0.jpg', 'RETAKEN');
    seedFile('u2', 'page-0.orig.jpg', 'RETAKEN-orig');
    restorePageWithShadow(stash('OLD'), 'u2', 0);
    expect(read('u2', 'page-0.jpg')).toBe('OLD');
    expect(read('u2', 'page-0.orig.jpg')).toBeUndefined();
  });

  test('a purged saved copy throws and touches nothing (critique M2)', () => {
    seedFile('u3', 'page-0.jpg', 'RETAKEN');
    seedFile('u3', 'page-0.orig.jpg', 'RETAKEN-orig');
    const uri = stash('OLD', 'OLD-orig');
    (new MockFile(uri) as any).exists = false;
    delete fileContents[uri];
    expect(() => restorePageWithShadow(uri, 'u3', 0)).toThrow('gone');
    expect(read('u3', 'page-0.jpg')).toBe('RETAKEN');
    expect(read('u3', 'page-0.orig.jpg')).toBe('RETAKEN-orig');
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test('a failed copy (disk full) leaves the page and its shadow as they were', () => {
    seedFile('u4', 'page-0.jpg', 'RETAKEN');
    seedFile('u4', 'page-0.orig.jpg', 'RETAKEN-orig');
    const uri = stash('OLD', 'OLD-orig');
    mockCopy
      .mockImplementationOnce(function (this: any, dest: any) { fileContents[dest.uri] = fileContents[this.uri]; dest.exists = true; })
      .mockImplementationOnce(() => { throw new Error('ENOSPC'); });
    expect(() => restorePageWithShadow(uri, 'u4', 0)).toThrow('ENOSPC');
    expect(read('u4', 'page-0.jpg')).toBe('RETAKEN');
    expect(read('u4', 'page-0.orig.jpg')).toBe('RETAKEN-orig');
  });
});

describe('pageLayoutGeneration (guards index-based Undo, critique M1)', () => {
  test('changes when pages are reordered or deleted, not for a no-op reorder', () => {
    seedPage('lg', 0, 'A');
    seedPage('lg', 1, 'B');
    seedPage('lg', 2, 'C');
    const g0 = pageLayoutGeneration('lg');
    reorderPages('lg', [0, 1, 2]);
    expect(pageLayoutGeneration('lg')).toBe(g0);
    reorderPages('lg', [1, 0, 2]);
    const g1 = pageLayoutGeneration('lg');
    expect(g1).not.toBe(g0);
    deleteSinglePage('lg', 2, 3);
    expect(pageLayoutGeneration('lg')).not.toBe(g1);
    expect(pageLayoutGeneration('other-doc')).toBe(0);
  });
});

// r6 code review #3: recognised text must go with the page / document.
describe('OCR text follows deletions', () => {
  beforeEach(() => jest.clearAllMocks());

  test('deleting a document forgets its cached text (its folder held the entries)', () => {
    deleteDocumentFiles('gone');
    expect(mockForgetOcr).toHaveBeenCalledWith('gone');
  });

  test('deleting a page prunes the cached text of pages the document no longer has', () => {
    deleteSinglePage('doc9', 0, 2);
    expect(mockPruneOcr).toHaveBeenCalledWith('doc9');
  });
});

describe('sweepConvertLeftovers (r7 #5: crash orphans from Convert to pages)', () => {
  const now = 10_000_000_000;
  const old = now - 60 * 60 * 1000;
  beforeEach(() => jest.clearAllMocks());
  const pdfUri = (id: string) => `${DOCS}/${id}/document.pdf`;
  const pageUri = (id: string, i: number) => `${DOCS}/${id}/page-${i}.jpg?v=3`;
  type Refs = { id: string; pages: string[]; pdfUri?: string; updatedAt: number };
  /** The docs lock, standing in for lib/storage.ts withDocumentFileRefs: `fresh` holds the current records. */
  const lockWith = (fresh: Record<string, Refs | null>) =>
    jest.fn(async (id: string, act: (r: Refs | null) => any) => act(fresh[id] ?? null)) as any;
  /** Sweep with records that haven't changed since the snapshot. */
  const sweep = (records: Refs[]) =>
    sweepConvertLeftovers(records, lockWith(Object.fromEntries(records.map(r => [r.id, r]))), now);

  test('removes document.pdf left in a document that is now pages', async () => {
    seedFile('conv', 'page-0.jpg', 'P0');
    seedFile('conv', 'page-0.orig.jpg', 'O0');
    seedFile('conv', 'document.pdf', 'PDF');
    listFromContents('conv');
    expect(await sweep([{ id: 'conv', pages: [pageUri('conv', 0)], updatedAt: old }])).toBe(1);
    expect(read('conv', 'document.pdf')).toBeUndefined();
    expect(read('conv', 'page-0.jpg')).toBe('P0');
    expect(read('conv', 'page-0.orig.jpg')).toBe('O0');
  });

  test('removes page files (and shadows) left in a document that is still a PDF', async () => {
    seedFile('half', 'document.pdf', 'PDF');
    seedFile('half', 'page-0.jpg', 'P0');
    seedFile('half', 'page-0.orig.jpg', 'O0');
    seedFile('half', 'page-1.jpg', 'P1');
    seedFile('half', 'ocr-lines.json', '{}');
    listFromContents('half');
    expect(await sweep([{ id: 'half', pages: [], pdfUri: pdfUri('half'), updatedAt: old }])).toBe(3);
    expect(read('half', 'document.pdf')).toBe('PDF');
    expect(read('half', 'page-0.jpg')).toBeUndefined();
    expect(read('half', 'page-1.jpg')).toBeUndefined();
    expect(read('half', 'ocr-lines.json')).toBe('{}'); // not a pattern this sweep knows
    expect(mockPruneOcr).toHaveBeenCalledWith('half');
  });

  test('never deletes a file the record references', async () => {
    // A record that (oddly) has both: everything it names is kept.
    seedFile('both', 'document.pdf', 'PDF');
    seedFile('both', 'page-0.jpg', 'P0');
    listFromContents('both');
    expect(await sweep([{ id: 'both', pages: [pageUri('both', 0)], pdfUri: pdfUri('both'), updatedAt: old }])).toBe(0);
    expect(read('both', 'document.pdf')).toBe('PDF');
    expect(read('both', 'page-0.jpg')).toBe('P0');
  });

  test('leaves recently modified files alone (an Undo copying the PDF back right now)', async () => {
    seedFile('fresh', 'page-0.jpg', 'P0');
    seedFile('fresh', 'document.pdf', 'PDF', now - 1000);
    listFromContents('fresh');
    expect(await sweep([{ id: 'fresh', pages: [pageUri('fresh', 0)], updatedAt: old }])).toBe(0);
    expect(read('fresh', 'document.pdf')).toBe('PDF');
  });

  test('skips a document whose record changed recently (an edit may be in flight)', async () => {
    seedFile('busy', 'page-0.jpg', 'P0');
    seedFile('busy', 'document.pdf', 'PDF');
    listFromContents('busy');
    expect(await sweep([{ id: 'busy', pages: [pageUri('busy', 0)], updatedAt: now - 5_000 }])).toBe(0);
    expect(read('busy', 'document.pdf')).toBe('PDF');
  });

  test('a PDF record pointing at another file name keeps the folder’s document.pdf', async () => {
    seedFile('legacy', 'document.pdf', 'PDF');
    seedFile('legacy', 'scan.pdf', 'OTHER');
    listFromContents('legacy');
    expect(await sweep([{ id: 'legacy', pages: [], pdfUri: `${DOCS}/legacy/scan.pdf`, updatedAt: old }])).toBe(0);
    expect(read('legacy', 'document.pdf')).toBe('PDF');
  });

  test('ordinary page documents are untouched, including page files past the end', async () => {
    seedFile('img', 'page-0.jpg', 'P0');
    seedFile('img', 'page-5.jpg', 'P5');
    listFromContents('img');
    expect(await sweep([{ id: 'img', pages: [pageUri('img', 0)], updatedAt: old }])).toBe(0);
    expect(read('img', 'page-5.jpg')).toBe('P5');
  });

  test('r8 #5: judges files by the record re-read under the lock, not the stale snapshot', async () => {
    // Snapshot: a page document converted long ago, so its document.pdf looks
    // stray. Meanwhile an Undo copied the PDF back (with the stash's old mtime)
    // and switched the record back to the PDF.
    seedFile('undo', 'page-0.jpg', 'P0');
    seedFile('undo', 'document.pdf', 'PDF');
    listFromContents('undo');
    const snapshot: Refs = { id: 'undo', pages: [pageUri('undo', 0)], updatedAt: old };
    const fresh: Refs = { id: 'undo', pages: [], pdfUri: pdfUri('undo'), updatedAt: now - 2_000 };
    const withFresh = lockWith({ undo: fresh });
    expect(await sweepConvertLeftovers([snapshot], withFresh, now)).toBe(0);
    expect(withFresh).toHaveBeenCalledWith('undo', expect.any(Function));
    expect(read('undo', 'document.pdf')).toBe('PDF');
    expect(read('undo', 'page-0.jpg')).toBe('P0');
  });

  test('r8 #5: a record switched meanwhile is judged by its new shape', async () => {
    // Snapshot says PDF document (page files would be strays); the fresh
    // record is a settled page document: its pages are referenced and kept.
    seedFile('sw', 'page-0.jpg', 'P0');
    seedFile('sw', 'document.pdf', 'PDF');
    listFromContents('sw');
    const snapshot: Refs = { id: 'sw', pages: [], pdfUri: pdfUri('sw'), updatedAt: old };
    const fresh: Refs = { id: 'sw', pages: [pageUri('sw', 0)], updatedAt: old };
    expect(await sweepConvertLeftovers([snapshot], lockWith({ sw: fresh }), now)).toBe(1);
    expect(read('sw', 'page-0.jpg')).toBe('P0');
    expect(read('sw', 'document.pdf')).toBeUndefined();
  });

  test('r8 #5: a document deleted meanwhile is left alone', async () => {
    seedFile('gone', 'page-0.jpg', 'P0');
    seedFile('gone', 'document.pdf', 'PDF');
    listFromContents('gone');
    const snapshot: Refs = { id: 'gone', pages: [pageUri('gone', 0)], updatedAt: old };
    expect(await sweepConvertLeftovers([snapshot], lockWith({}), now)).toBe(0);
    expect(read('gone', 'document.pdf')).toBe('PDF');
  });

  test('r8 #5: deletes only inside the lock callback, and never consults the lock for a busy snapshot', async () => {
    seedFile('lk', 'page-0.jpg', 'P0');
    seedFile('lk', 'document.pdf', 'PDF');
    listFromContents('lk');
    const rec: Refs = { id: 'lk', pages: [pageUri('lk', 0)], updatedAt: old };
    let insideLock = false;
    const deletedInside: boolean[] = [];
    mockDelete.mockImplementation(function (this: any) {
      deletedInside.push(insideLock);
      delete fileContents[this.uri];
      this.exists = false;
    });
    const withFresh = jest.fn(async (_id: string, act: (r: Refs | null) => any) => {
      insideLock = true;
      try { return act(rec); } finally { insideLock = false; }
    }) as any;
    const busy: Refs = { id: 'busy2', pages: [], updatedAt: now - 1000 };
    expect(await sweepConvertLeftovers([rec, busy], withFresh, now)).toBe(1);
    expect(deletedInside).toEqual([true]);
    expect(withFresh).toHaveBeenCalledTimes(1);
    mockDelete.mockImplementation(function (this: any) {
      delete fileContents[this.uri];
      this.exists = false;
    });
  });
});

describe('Open-in staging is swept (r7 #3)', () => {
  beforeEach(() => jest.clearAllMocks());
  const now = 10_000_000_000;
  const CACHES = 'file:///Library/Caches/';
  const seenUri = `${CACHES}/inbox-seen.json`;

  test('settled files in Caches/incoming and legacy root staging files are removed', () => {
    const staged: any = new MockFile(`${CACHES}/incoming/incoming-1-contract.pdf`);
    const live: any = new MockFile(`${CACHES}/incoming/attempt-${now - 1000}-incoming-1-contract.pdf`);
    new MockDirectory({ uri: CACHES }, 'incoming').list = jest.fn(() => [staged, live]);
    const legacy: any = new MockFile(`${CACHES}incoming-1700000000-x.pdf`);
    const other: any = new MockFile(`${CACHES}com.apple.something`);
    new MockDirectory({ uri: CACHES }).list = jest.fn(() => [legacy, other]);
    expect(sweepTempLeftovers(now)).toBe(2);
    expect(staged.exists).toBe(false);
    expect(live.exists).toBe(true);
    expect(legacy.exists).toBe(false);
    expect(other.exists).toBe(true);
  });

  test('r8 #2: a staged copy is aged by the stamp in its name, not by the mtime File.copy kept', () => {
    // Cold "Open in" of a year-old PDF: the copies keep the original's mtime.
    const yearAgo = now - 365 * 24 * 60 * 60 * 1000;
    const staged: any = new MockFile(`${CACHES}/incoming/incoming-${now - 3000}-Lease.pdf`);
    const attempt: any = new MockFile(`${CACHES}/incoming/attempt-${now - 2000}-incoming-${now - 3000}-Lease.pdf`);
    const legacy: any = new MockFile(`${CACHES}attempt-${now - 2000}-Old.pdf`);
    for (const f of [staged, attempt, legacy]) mockMtimes[f.uri] = yearAgo;
    new MockDirectory({ uri: CACHES }, 'incoming').list = jest.fn(() => [staged, attempt]);
    new MockDirectory({ uri: CACHES }).list = jest.fn(() => [legacy]);
    expect(sweepTempLeftovers(now)).toBe(0);
    expect(staged.exists).toBe(true);
    expect(attempt.exists).toBe(true);
    expect(legacy.exists).toBe(true);
    // The same files, swept from a launch more than the grace period later, go.
    expect(sweepTempLeftovers(now + 11 * 60 * 1000)).toBe(3);
    expect(staged.exists).toBe(false);
    expect(attempt.exists).toBe(false);
  });

  test('Android PDF scratch folders (decrypted leftovers) are swept once settled', () => {
    const preview: any = new MockFile(`${CACHES}/pdf-fill-preview/nofields-1a2b.pdf`);
    const spill: any = new MockFile(`${CACHES}/pdfbox-tmp/PDFBox123.tmp`);
    const fresh: any = new MockFile(`${CACHES}/pdfbox-tmp/PDFBox456.tmp`);
    mockMtimes[preview.uri] = now - 60 * 60 * 1000;
    mockMtimes[spill.uri] = now - 60 * 60 * 1000;
    mockMtimes[fresh.uri] = now - 1000;
    new MockDirectory({ uri: CACHES }, 'pdf-fill-preview').list = jest.fn(() => [preview]);
    new MockDirectory({ uri: CACHES }, 'pdfbox-tmp').list = jest.fn(() => [spill, fresh]);
    expect(sweepTempLeftovers(now)).toBe(2);
    expect(preview.exists).toBe(false);
    expect(spill.exists).toBe(false);
    expect(fresh.exists).toBe(true);
  });

  test('a recent mtime still keeps a file without a stamp in Caches/incoming', () => {
    const odd: any = new MockFile(`${CACHES}/incoming/contract.pdf`);
    mockMtimes[odd.uri] = now - 1000;
    new MockDirectory({ uri: CACHES }, 'incoming').list = jest.fn(() => [odd]);
    expect(sweepTempLeftovers(now)).toBe(0);
    expect(odd.exists).toBe(true);
  });

  test('stagedAt reads the staging stamp from the name', () => {
    expect(stagedAt('incoming-1763459000000-Lease.pdf')).toBe(1763459000000);
    expect(stagedAt('attempt-1763459000500-incoming-1763459000000-Lease.pdf')).toBe(1763459000500);
    expect(stagedAt('Lease.pdf')).toBeNull();
    expect(stagedAt('incoming--Lease.pdf')).toBeNull();
  });

  test('r8 #2: an Inbox copy is deleted only on a later launch, a grace period after it was first seen', () => {
    const inbox: any = new MockFile('file:///documents/Inbox/contract.pdf');
    mockMtimes[inbox.uri] = 1; // iOS's copy keeps the original's (ancient) mtime
    new MockDirectory({ uri: 'file:///documents' }, 'Inbox').list = jest.fn(() => (inbox.exists ? [inbox] : []));
    // Cold launch for "Open in": first sighting, kept for the import to stage.
    expect(sweepTempLeftovers(now)).toBe(0);
    expect(inbox.exists).toBe(true);
    expect(JSON.parse(fileContents[seenUri])).toEqual({ 'contract.pdf': now });
    // A relaunch soon after: still within the grace period.
    expect(sweepTempLeftovers(now + 60_000)).toBe(0);
    expect(inbox.exists).toBe(true);
    // Still there on a launch well after: the import never ran — removed.
    expect(sweepTempLeftovers(now + 11 * 60 * 1000)).toBe(1);
    expect(inbox.exists).toBe(false);
    expect(fileContents[seenUri]).toBeUndefined(); // nothing left to track
  });

  test('an Inbox copy the import removed is forgotten, so a later one with the same name starts afresh', () => {
    const inbox: any = new MockFile('file:///documents/Inbox/scan.pdf');
    let present = true;
    new MockDirectory({ uri: 'file:///documents' }, 'Inbox').list = jest.fn(() => (present ? [inbox] : []));
    expect(sweepTempLeftovers(now)).toBe(0);
    present = false; // app/import.tsx staged it and removed the Inbox copy
    expect(sweepTempLeftovers(now + 60_000)).toBe(0);
    present = true; // the user opens another "scan.pdf" an hour later
    expect(sweepTempLeftovers(now + 60 * 60 * 1000)).toBe(0);
    expect(inbox.exists).toBe(true);
  });

  test('a corrupt Inbox record is ignored, never a reason to delete', () => {
    fileContents[seenUri] = '{not json';
    const inbox: any = new MockFile('file:///documents/Inbox/contract.pdf');
    new MockDirectory({ uri: 'file:///documents' }, 'Inbox').list = jest.fn(() => [inbox]);
    expect(sweepTempLeftovers(now)).toBe(0);
    expect(inbox.exists).toBe(true);
  });
});

// ── R12: source photos (page-N.src.jpg) and their geometry (page-N.src.json) ──
// They are page shadows like .orig: every operation must carry them with their
// page, and never leave one paired with another page.

describe('source photos travel with their pages (R12)', () => {
  beforeEach(() => jest.clearAllMocks());
  /** Marks files that hold no seeded bytes as absent (the mock defaults to "exists"). */
  const absent = (docId: string, ...names: string[]) => {
    for (const n of names) (new MockFile(docDirOf(docId), n) as any).exists = false;
  };
  const family = (docId: string, i: number) =>
    [read(docId, `page-${i}.jpg`), read(docId, `page-${i}.orig.jpg`), read(docId, `page-${i}.src.jpg`), read(docId, `page-${i}.src.json`)];

  test('deleteSinglePage shifts source photos and geometry with their pages', () => {
    seedFile('s1', 'page-0.jpg', 'A'); seedFile('s1', 'page-0.src.jpg', 'A-src'); seedFile('s1', 'page-0.src.json', 'A-geo');
    seedFile('s1', 'page-1.jpg', 'B'); absent('s1', 'page-1.orig.jpg', 'page-1.src.jpg', 'page-1.src.json');
    seedFile('s1', 'page-2.jpg', 'C'); seedFile('s1', 'page-2.orig.jpg', 'C-orig'); seedFile('s1', 'page-2.src.jpg', 'C-src'); seedFile('s1', 'page-2.src.json', 'C-geo');
    absent('s1', 'page-0.orig.jpg');
    deleteSinglePage('s1', 0, 3);
    expect(family('s1', 0)).toEqual(['B', undefined, undefined, undefined]);
    expect(family('s1', 1)).toEqual(['C', 'C-orig', 'C-src', 'C-geo']);
    expect(family('s1', 2)).toEqual([undefined, undefined, undefined, undefined]);
  });

  test('reorderPages moves source photos and geometry with their pages, and clears a slot whose page has none', () => {
    seedFile('s2', 'page-0.jpg', 'A'); seedFile('s2', 'page-0.src.jpg', 'A-src'); seedFile('s2', 'page-0.src.json', 'A-geo');
    seedFile('s2', 'page-1.jpg', 'B'); absent('s2', 'page-1.src.jpg', 'page-1.src.json');
    absent('s2', 'page-0.orig.jpg', 'page-1.orig.jpg');
    reorderPages('s2', [1, 0]);
    expect(family('s2', 0)).toEqual(['B', undefined, undefined, undefined]);
    expect(family('s2', 1)).toEqual(['A', undefined, 'A-src', 'A-geo']);
    expect(Object.keys(fileContents).filter(u => /tmp|commit/.test(u))).toEqual([]);
  });

  test('an interrupted reorder is finished for source files too (page-tmp-N.src.*)', async () => {
    seedFile('s3', 'reorder.commit', '');
    seedFile('s3', 'page-tmp-0.src.jpg', 'B-src');
    seedFile('s3', 'page-tmp-0.src.json', 'B-geo');
    seedFile('s3', 'page-0.jpg', 'B');
    rootWith(listFromContents('s3'));
    await garbageCollectOrphans(['s3']);
    expect(read('s3', 'page-0.src.jpg')).toBe('B-src');
    expect(read('s3', 'page-0.src.json')).toBe('B-geo');
    expect(read('s3', 'page-tmp-0.src.jpg')).toBeUndefined();
  });

  test('the sweep never deletes a referenced source; it deletes a half-copied one (.src.part.jpg)', async () => {
    seedFile('s4', 'page-0.jpg', 'A');
    seedFile('s4', 'page-0.src.jpg', 'A-src');
    seedFile('s4', 'page-0.src.json', 'A-geo');
    seedFile('s4', 'page-1.src.part.jpg', 'half');
    rootWith(listFromContents('s4'));
    await garbageCollectOrphans(['s4']);
    expect(read('s4', 'page-0.src.jpg')).toBe('A-src');
    expect(read('s4', 'page-0.src.json')).toBe('A-geo');
    expect(read('s4', 'page-1.src.part.jpg')).toBeUndefined();
    expect(read('s4', 'page-1.src.jpg')).toBeUndefined();
  });

  test('an interrupted geometry write is finished (page-N.src.new.json promoted) or its leftover removed', async () => {
    seedFile('s5', 'page-0.jpg', 'A'); seedFile('s5', 'page-0.src.jpg', 'A-src');
    seedFile('s5', 'page-0.src.new.json', 'A-geo-new'); // killed between the delete and the rename
    absent('s5', 'page-0.src.json');
    seedFile('s5', 'page-1.jpg', 'B'); seedFile('s5', 'page-1.src.jpg', 'B-src');
    seedFile('s5', 'page-1.src.json', 'B-geo'); seedFile('s5', 'page-1.src.new.json', 'B-half'); // killed before the delete
    rootWith(listFromContents('s5'));
    await garbageCollectOrphans(['s5']);
    expect(read('s5', 'page-0.src.json')).toBe('A-geo-new');
    expect(read('s5', 'page-1.src.json')).toBe('B-geo');
    expect(Object.keys(fileContents).filter(u => u.includes('/s5/') && u.endsWith('.src.new.json'))).toEqual([]);
  });

  test('copyPageWithShadow carries the source, and clears a stale one when the copied page has none', () => {
    seedFile('from', 'page-3.jpg', 'P'); seedFile('from', 'page-3.src.jpg', 'P-src'); seedFile('from', 'page-3.src.json', 'P-geo');
    absent('from', 'page-3.orig.jpg');
    copyPageWithShadow(`${DOCS}/from/page-3.jpg?v=9`, 'to', 0);
    expect(family('to', 0)).toEqual(['P', undefined, 'P-src', 'P-geo']);

    seedFile('from', 'page-4.jpg', 'Q'); absent('from', 'page-4.orig.jpg', 'page-4.src.jpg', 'page-4.src.json');
    copyPageWithShadow(`${DOCS}/from/page-4.jpg`, 'to', 0); // over the slot that has a source
    expect(family('to', 0)).toEqual(['Q', undefined, undefined, undefined]);
  });

  test('copyDocumentFiles (duplicate) carries source photos and geometry', () => {
    seedFile('dupsrc', 'page-0.jpg', 'A'); seedFile('dupsrc', 'page-0.orig.jpg', 'A-orig');
    seedFile('dupsrc', 'page-0.src.jpg', 'A-src'); seedFile('dupsrc', 'page-0.src.json', 'A-geo');
    copyDocumentFiles('dupsrc', 'dupdest', [`${DOCS}/dupsrc/page-0.jpg`]);
    expect(family('dupdest', 0)).toEqual(['A', 'A-orig', 'A-src', 'A-geo']);
  });

  test('restorePageWithShadow puts a stashed source back with its page', () => {
    const stash = 'file:///Library/Caches/page-undo/1';
    for (const [n, c] of [['page-0.jpg', 'OLD'], ['page-0.orig.jpg', 'OLD-orig'], ['page-0.src.jpg', 'OLD-src'], ['page-0.src.json', 'OLD-geo']]) {
      const f: any = new MockFile(`${stash}/${n}`); f.exists = true; fileContents[f.uri] = c;
    }
    seedFile('rs', 'page-0.jpg', 'NEW'); seedFile('rs', 'page-0.src.jpg', 'NEW-src'); seedFile('rs', 'page-0.src.json', 'NEW-geo');
    restorePageWithShadow(`${stash}/page-0.jpg`, 'rs', 0);
    expect(family('rs', 0)).toEqual(['OLD', 'OLD-orig', 'OLD-src', 'OLD-geo']);
  });

  test('restorePageWithShadow from a stash without a source leaves the page\'s own source alone', () => {
    const stash = 'file:///Library/Caches/stamp/1';
    for (const [n, c] of [['page-0.jpg', 'PRE'], ['page-0.orig.jpg', 'PRE-orig']]) {
      const f: any = new MockFile(`${stash}/${n}`); f.exists = true; fileContents[f.uri] = c;
    }
    for (const n of ['page-0.src.jpg', 'page-0.src.json']) (new MockFile(`${stash}/${n}`) as any).exists = false;
    seedFile('rs2', 'page-0.jpg', 'STAMPED'); seedFile('rs2', 'page-0.orig.jpg', 'STAMPED-orig');
    seedFile('rs2', 'page-0.src.jpg', 'SRC'); seedFile('rs2', 'page-0.src.json', 'GEO');
    restorePageWithShadow(`${stash}/page-0.jpg`, 'rs2', 0);
    expect(family('rs2', 0)).toEqual(['PRE', 'PRE-orig', 'SRC', 'GEO']);
  });

  test('a document without sources gets no source files from any of these operations', () => {
    seedFile('plain', 'page-0.jpg', 'A'); seedFile('plain', 'page-0.orig.jpg', 'A-orig');
    seedFile('plain', 'page-1.jpg', 'B');
    absent('plain', 'page-1.orig.jpg', 'page-0.src.jpg', 'page-0.src.json', 'page-1.src.jpg', 'page-1.src.json');
    reorderPages('plain', [1, 0]);
    copyDocumentFiles('plain', 'plain-copy', [`${DOCS}/plain/page-0.jpg`, `${DOCS}/plain/page-1.jpg`]);
    deleteSinglePage('plain', 0, 2);
    // (The mock leaves keys without bytes for files it was told about; only bytes count.)
    expect(Object.keys(fileContents).filter(u => /\.src\./.test(u) && fileContents[u] !== undefined)).toEqual([]);
    expect(family('plain', 0)).toEqual(['A', 'A-orig', undefined, undefined]);
    expect(family('plain-copy', 1)).toEqual(['A', 'A-orig', undefined, undefined]);
  });

  test('sweepConvertLeftovers removes stray source files of a document that is a PDF again', async () => {
    const now = 10_000_000_000;
    seedFile('cv', 'document.pdf', 'PDF');
    seedFile('cv', 'page-0.src.jpg', 'S');
    seedFile('cv', 'page-0.src.json', 'G');
    listFromContents('cv');
    const rec = { id: 'cv', pages: [], pdfUri: `${DOCS}/cv/document.pdf`, updatedAt: 1 };
    await sweepConvertLeftovers([rec], async (_id, act) => act(rec), now);
    expect(read('cv', 'page-0.src.jpg')).toBeUndefined();
    expect(read('cv', 'page-0.src.json')).toBeUndefined();
    expect(read('cv', 'document.pdf')).toBe('PDF');
  });
});
