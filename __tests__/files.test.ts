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

import {
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
  restorePageWithShadow,
  pageLayoutGeneration,
} from '../lib/files';
import { cappedSize, MAX_PAGE_EDGE } from '../lib/image-size';
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
      (new RawFile(new RawDirectory('file:///documents', 'scan-kit', 'src'), `page-${i}.orig.jpg`) as any).exists = false;
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
    expect(isDisposableTemp('file:///documents/DOCUMENT_SCAN_0_20261118.jpg?v=1')).toBe(true);
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
    const old: any = new MockFile('file:///documents/DOCUMENT_SCAN_0_old.jpg');
    const fresh: any = new MockFile('file:///documents/DOCUMENT_SCAN_1_new.jpg');
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
