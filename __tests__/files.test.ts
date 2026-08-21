const mockFileInstances: Record<string, any> = {};
const mockDirInstances: Record<string, any> = {};
// Content-tracking copy/delete. These stay jest.fn spies (existing tests assert
// on call counts), but they now also move bytes, so a test can prove that the
// RIGHT file landed at the right index — which is the whole point of the .orig
// shadow: if it drifts from its page, the next filter bake re-derives from the
// wrong image.
const fileContents: Record<string, string> = {};
const mockCopy = jest.fn(function (this: any, dest: any) {
  fileContents[dest.uri] = fileContents[this.uri];
  dest.exists = true;
});
const mockDelete = jest.fn(function (this: any) {
  delete fileContents[this.uri];
  this.exists = false;
});

jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn().mockResolvedValue({ uri: 'file:///tmp/compressed.jpg' }),
  SaveFormat: { JPEG: 'jpeg' },
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
  class MockFile {
    uri!: string;
    exists = true;
    copy = mockCopy;
    delete = mockDelete;
    constructor(dirOrUri: any, name?: string) {
      const uri = name ? `${dirOrUri.uri || dirOrUri}/${name}` : String(dirOrUri);
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
    exists = true;
    constructor(...parts: string[]) {
      const uri = parts.join('/');
      if (mockDirInstances[uri]) return mockDirInstances[uri];
      this.uri = uri;
      mockDirInstances[uri] = this;
    }
  }

  return {
    File: MockFile,
    Directory: MockDirectory,
    Paths: { document: 'file:///documents' },
  };
});

import { deleteSinglePage, appendPages, reorderPages, copyDocumentFiles } from '../lib/files';
import { copyPageWithQuality, copyPdfToStorage } from '../lib/files';
import { originalUri, ensureOriginal, garbageCollectOrphans } from '../lib/files';
import { manipulateAsync } from 'expo-image-manipulator';

// The mock caches File/Directory instances by uri and `delete` now clears
// `exists`, so state would otherwise leak between tests. Reset the caches and
// the content store before each one.
beforeEach(() => {
  for (const k of Object.keys(mockFileInstances)) delete mockFileInstances[k];
  for (const k of Object.keys(mockDirInstances)) delete mockDirInstances[k];
  for (const k of Object.keys(fileContents)) delete fileContents[k];
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
    // page-1 deleted, page-2 copied to page-1, page-2 deleted
    expect(mockDelete).toHaveBeenCalled();
    expect(mockCopy).toHaveBeenCalled();
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
    expect(mockCopy).toHaveBeenCalledTimes(1);
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

    const origFile = new MockFile(docDir, 'page-0.orig.jpg');
    const staleTemp = new MockFile(docDir, 'page-0.tmp.jpg');
    docDir.list = jest.fn(() => [origFile, staleTemp]);

    const deletedCount = await garbageCollectOrphans(['valid-doc']);

    // `delete` is a shared mock fn across all File instances, so distinguish
    // which instance it was called on via jest's recorded `this` per call.
    expect(mockDelete.mock.instances).not.toContain(origFile);
    expect(mockDelete.mock.instances).toContain(staleTemp);
    expect(deletedCount).toBe(1);
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
