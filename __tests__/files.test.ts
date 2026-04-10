const mockFileInstances: Record<string, any> = {};
const mockCopy = jest.fn();
const mockDelete = jest.fn();

jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn().mockResolvedValue({ uri: 'file:///tmp/compressed.jpg' }),
  SaveFormat: { JPEG: 'jpeg' },
}));

jest.mock('expo-file-system', () => {
  return {
    File: jest.fn().mockImplementation((dirOrUri: any, name?: string) => {
      const uri = name ? `${dirOrUri.uri || dirOrUri}/${name}` : String(dirOrUri);
      if (!mockFileInstances[uri]) {
        mockFileInstances[uri] = { uri, exists: true, copy: mockCopy, delete: mockDelete };
      }
      return mockFileInstances[uri];
    }),
    Directory: jest.fn().mockImplementation((...parts: string[]) => ({
      uri: parts.join('/'),
      create: jest.fn(),
      delete: jest.fn(),
      exists: true,
    })),
    Paths: { document: 'file:///documents' },
  };
});

import { deleteSinglePage, appendPages, reorderPages, copyDocumentFiles } from '../lib/files';
import { copyPageWithQuality, copyPdfToStorage } from '../lib/files';
import { manipulateAsync } from 'expo-image-manipulator';
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
