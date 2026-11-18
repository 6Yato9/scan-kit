// Mock the file layer: restoreStashedPage's own job is the bookkeeping around it.
const mockExisting = new Set<string>();
const mockDeleted: string[] = [];
jest.mock('expo-file-system', () => {
  class MockFile {
    uri: string;
    constructor(uri: string) { this.uri = uri; }
    get exists() { return mockExisting.has(this.uri); }
  }
  class MockDirectory {
    uri: string;
    constructor(uri: string) { this.uri = uri; }
    get exists() { return [...mockExisting].some(u => u.startsWith(`${this.uri}/`)); }
    delete() {
      mockDeleted.push(this.uri);
      for (const u of [...mockExisting]) if (u.startsWith(`${this.uri}/`)) mockExisting.delete(u);
    }
  }
  return { File: MockFile, Directory: MockDirectory, Paths: { cache: { uri: 'file:///cache' }, document: { uri: 'file:///docs' } } };
});
const mockCopyPageWithShadow = jest.fn();
const mockReorderPages = jest.fn((_id: string, order: number[]) => order.map(i => `file:///docs/d/page-${i}.jpg`));
jest.mock('../lib/files', () => ({
  copyPageWithShadow: (...a: unknown[]) => mockCopyPageWithShadow(...a),
  reorderPages: (id: string, order: number[]) => mockReorderPages(id, order),
}));

import { insertAt, reinsertOrder, restoreStashedPage } from '../lib/page-undo';

test('reinsertOrder moves the appended page back to its old position', () => {
  // 3 pages left after deleting index 1; the restored page is appended as 3.
  expect(reinsertOrder(3, 1)).toEqual([0, 3, 1, 2]);
  expect(reinsertOrder(3, 0)).toEqual([3, 0, 1, 2]);
  expect(reinsertOrder(3, 3)).toEqual([0, 1, 2, 3]);
  // Out of range clamps rather than dropping pages.
  expect(reinsertOrder(2, 9)).toEqual([0, 1, 2]);
  expect(reinsertOrder(2, -1)).toEqual([2, 0, 1]);
});

test('insertAt puts per-page metadata back in place', () => {
  expect(insertAt(['a', 'c'], 1, 'b')).toEqual(['a', 'b', 'c']);
  expect(insertAt([], 0, 'x')).toEqual(['x']);
  expect(insertAt(['a'], 5, 'z')).toEqual(['a', 'z']);
});

describe('restoreStashedPage', () => {
  const stash = 'file:///cache/page-undo/123/page-0.jpg';
  beforeEach(() => {
    mockExisting.clear();
    mockDeleted.length = 0;
    mockCopyPageWithShadow.mockClear();
    mockReorderPages.mockClear();
    mockExisting.add(stash);
    mockExisting.add('file:///cache/page-undo/123/page-0.orig.jpg');
  });

  test('puts the page back and consumes the stash', () => {
    const pages = restoreStashedPage('d', stash, 3, 1);
    expect(mockCopyPageWithShadow).toHaveBeenCalledWith(stash, 'd', 3);
    expect(mockReorderPages).toHaveBeenCalledWith('d', [0, 3, 1, 2]);
    expect(pages).toHaveLength(4);
    expect(mockDeleted).toEqual(['file:///cache/page-undo/123']);
    expect(mockExisting.size).toBe(0);
  });

  test('a second Undo cannot insert the page twice', () => {
    restoreStashedPage('d', stash, 3, 1);
    expect(() => restoreStashedPage('d', stash, 4, 1)).toThrow();
    expect(mockCopyPageWithShadow).toHaveBeenCalledTimes(1);
    expect(mockReorderPages).toHaveBeenCalledTimes(1);
  });

  test('a failed restore keeps the stash so Undo can be retried', () => {
    mockReorderPages.mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => restoreStashedPage('d', stash, 3, 1)).toThrow('disk full');
    expect(mockExisting.has(stash)).toBe(true);
  });
});
