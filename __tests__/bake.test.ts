// __tests__/bake.test.ts
const mockWriteAsStringAsync = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-file-system/legacy', () => ({
  writeAsStringAsync: (...args: any[]) => mockWriteAsStringAsync(...args),
}));

// Lightweight stand-ins for Directory/File/Paths, mirroring the pattern in
// __tests__/files.test.ts, so bake.ts's destination URI (built the same way
// lib/files.ts builds one) is deterministic and inspectable via mockWriteAsStringAsync's
// call args rather than hand-building the expected path string here too.
jest.mock('expo-file-system', () => {
  class MockFile {
    uri: string;
    constructor(dirOrUri: any, name?: string) {
      const base = dirOrUri && typeof dirOrUri === 'object' ? dirOrUri.uri : dirOrUri;
      this.uri = name ? `${base}/${name}` : String(base);
    }
  }
  class MockDirectory {
    uri: string;
    constructor(...parts: any[]) {
      this.uri = parts.map(p => (p && typeof p === 'object' ? p.uri : p)).join('/');
    }
  }
  return {
    File: MockFile,
    Directory: MockDirectory,
    Paths: { document: 'file:///documents' },
  };
});

const mockEnsureOriginal = jest.fn();
jest.mock('../lib/files', () => ({
  ensureOriginal: (...args: any[]) => mockEnsureOriginal(...args),
}));

const mockEnqueueBake = jest.fn();
jest.mock('../lib/bake-queue', () => ({
  enqueueBake: (...args: any[]) => mockEnqueueBake(...args),
}));

const mockSetPageBaked = jest.fn().mockResolvedValue(undefined);
jest.mock('../lib/storage', () => ({
  setPageBaked: (...args: any[]) => mockSetPageBaked(...args),
}));

import { bakePage } from '../lib/bake';

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteAsStringAsync.mockResolvedValue(undefined);
  mockSetPageBaked.mockResolvedValue(undefined);
  mockEnsureOriginal.mockReturnValue('file:///documents/scan-kit/doc1/page-0.orig.jpg');
});

test('bakes from .orig, writes the decoded bytes to the right page, and records the filter', async () => {
  mockEnqueueBake.mockResolvedValue('data:image/jpeg;base64,AAAA');

  await bakePage('doc1', 0, 'grayscale', undefined);

  expect(mockEnsureOriginal).toHaveBeenCalledWith('doc1', 0);
  expect(mockEnqueueBake).toHaveBeenCalledWith({
    docId: 'doc1',
    pageIndex: 0,
    src: 'file:///documents/scan-kit/doc1/page-0.orig.jpg',
    ops: [{ grayscale: 1 }],
  });
  expect(mockWriteAsStringAsync).toHaveBeenCalledWith(
    'file:///documents/scan-kit/doc1/page-0.jpg',
    'AAAA',
    { encoding: 'base64' }
  );
  expect(mockSetPageBaked).toHaveBeenCalledWith('doc1', 0, 'grayscale', undefined);

  // Write must happen before the filter is recorded.
  const writeOrder = mockWriteAsStringAsync.mock.invocationCallOrder[0];
  const recordOrder = mockSetPageBaked.mock.invocationCallOrder[0];
  expect(writeOrder).toBeLessThan(recordOrder);
});

test('passes adjustments through to combinedFilterCss and setPageBaked', async () => {
  mockEnqueueBake.mockResolvedValue('data:image/jpeg;base64,CCCC');
  const adjustment = { brightness: 10, contrast: 0, saturation: 0 };

  await bakePage('doc1', 0, 'enhanced', adjustment);

  expect(mockEnqueueBake).toHaveBeenCalledWith(
    expect.objectContaining({ ops: [{ contrast: 1.3 }, { saturate: 1.3 }, { brightness: 1.1 }] })
  );
  expect(mockSetPageBaked).toHaveBeenCalledWith('doc1', 0, 'enhanced', adjustment);
});

test('on a rejected bake, neither the write nor setPageBaked happens', async () => {
  mockEnqueueBake.mockRejectedValue(new Error('BAKE_ERROR:image failed to load'));

  await expect(bakePage('doc1', 0, 'grayscale', undefined)).rejects.toThrow(
    'BAKE_ERROR:image failed to load'
  );

  expect(mockWriteAsStringAsync).not.toHaveBeenCalled();
  expect(mockSetPageBaked).not.toHaveBeenCalled();
});

test('a failed write propagates and setPageBaked is never called', async () => {
  mockEnqueueBake.mockResolvedValue('data:image/jpeg;base64,DDDD');
  mockWriteAsStringAsync.mockRejectedValue(new Error('disk full'));

  await expect(bakePage('doc1', 0, 'grayscale', undefined)).rejects.toThrow('disk full');

  expect(mockSetPageBaked).not.toHaveBeenCalled();
});

test('filter "original" still bakes from .orig with no ops, restoring the unfiltered image', async () => {
  mockEnsureOriginal.mockReturnValue('file:///documents/scan-kit/doc1/page-1.orig.jpg');
  mockEnqueueBake.mockResolvedValue('data:image/jpeg;base64,EEEE');

  await bakePage('doc1', 1, 'original', undefined);

  expect(mockEnsureOriginal).toHaveBeenCalledWith('doc1', 1);
  expect(mockEnqueueBake).toHaveBeenCalledWith(
    expect.objectContaining({
      src: 'file:///documents/scan-kit/doc1/page-1.orig.jpg',
      ops: [],
    })
  );
  expect(mockWriteAsStringAsync).toHaveBeenCalledWith(
    'file:///documents/scan-kit/doc1/page-1.jpg',
    'EEEE',
    { encoding: 'base64' }
  );
  expect(mockSetPageBaked).toHaveBeenCalledWith('doc1', 1, 'original', undefined);
});
