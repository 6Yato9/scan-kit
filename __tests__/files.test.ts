const mockFileInstances: Record<string, any> = {};
const mockDirInstances: Record<string, any> = {};
const mockCopy = jest.fn();
const mockDelete = jest.fn();

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
