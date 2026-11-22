// __tests__/doc-record.test.ts
// Android keeps a very long ocrText out of the AsyncStorage record (a record
// over the 2 MB cursor window can't be read back); iOS records are unchanged.
// Reading accepts both forms (review M5b).
import { Document } from '../types/document';

// An in-memory file system: uri → text.
const mockFiles: Record<string, string> = {};
jest.mock('expo-file-system', () => {
  class MockFile {
    uri: string;
    constructor(...parts: any[]) {
      this.uri = parts.map(p => (typeof p === 'string' ? p : p.uri)).map((p, i) => (i ? p : p.replace(/\/+$/, ''))).join('/');
    }
    get exists() { return this.uri in mockFiles; }
    get size() { return Buffer.byteLength(mockFiles[this.uri] ?? '', 'utf8'); }
    create() { mockFiles[this.uri] = ''; }
    write(text: string) {
      if ((globalThis as any).mockFailWrites) throw new Error('disk full');
      mockFiles[this.uri] = text;
    }
    textSync() { return mockFiles[this.uri]; }
    delete() { delete mockFiles[this.uri]; }
    move(dest: MockFile) { mockFiles[dest.uri] = mockFiles[this.uri]; delete mockFiles[this.uri]; this.uri = dest.uri; }
  }
  class MockDirectory {
    uri: string;
    constructor(...parts: any[]) {
      this.uri = parts.map(p => (typeof p === 'string' ? p : p.uri)).map((p, i) => (i ? p : p.replace(/\/+$/, ''))).join('/') + '/';
    }
    get exists() { return Object.keys(mockFiles).some(u => u.startsWith(this.uri)); }
    list() {
      return Object.keys(mockFiles)
        .filter(u => u.startsWith(this.uri) && !u.slice(this.uri.length).includes('/'))
        .map(u => new MockFile(u));
    }
  }
  return { File: MockFile, Directory: MockDirectory, Paths: { document: { uri: 'file:///CURRENT/Documents/' } } };
});
jest.mock('../lib/storage-layout', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Directory } = require('expo-file-system');
  return {
    resolveDocDir: (id: string) => new Directory(`file:///CURRENT/Documents/scan-kit/${id}`),
    rebaseStoredUri: (u: string) => u,
  };
});
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('../lib/files', () => ({
  originalUri: (docId: string, i: number) => `file:///documents/scan-kit/${docId}/page-${i}.orig.jpg`,
  deleteDocumentFiles: () => {},
}));

import {
  INLINE_TEXT_MAX_BYTES,
  decodeDocRecord,
  encodeDocRecord,
  needsSideFile,
  textHash,
  truncateUtf8,
  utf8Length,
} from '../lib/doc-record';

const DIR = 'file:///CURRENT/Documents/scan-kit/d1/';
const base: Document = { id: 'd1', name: 'Book', pages: ['file:///p0.jpg'], createdAt: 1, updatedAt: 2 };
const long = 'Lorem ipsum dolor sit amet. '.repeat(30000); // ~840 KB
const arabic = 'نص عربي طويل '.repeat(30000); // 2 bytes a letter

beforeEach(() => {
  for (const k of Object.keys(mockFiles)) delete mockFiles[k];
  (globalThis as any).mockFailWrites = false;
});

describe('pure helpers', () => {
  test('utf8Length counts bytes as UTF-8 does', () => {
    for (const s of ['', 'abc', 'é', 'نص', '中文', '😀', 'a😀b', '\uD800x']) {
      expect(utf8Length(s)).toBe(Buffer.byteLength(s, 'utf8'));
    }
  });
  test('truncateUtf8 never exceeds the budget nor splits a pair', () => {
    expect(truncateUtf8('a😀b', 4)).toBe('a');
    expect(truncateUtf8('a😀b', 5)).toBe('a😀');
    expect(truncateUtf8('نص', 3)).toBe('ن');
    expect(truncateUtf8('abc', 10)).toBe('abc');
  });
  test('textHash changes with the text', () => {
    expect(textHash(long)).toBe(textHash(`${long}`));
    expect(textHash(long)).not.toBe(textHash(`${long}x`));
    expect(textHash('ab')).not.toBe(textHash('ba'));
  });
  test('only Android and only past the limit', () => {
    expect(needsSideFile(long, 'ios')).toBe(false);
    expect(needsSideFile(long, 'android')).toBe(true);
    expect(needsSideFile('short', 'android')).toBe(false);
    expect(needsSideFile(undefined, 'android')).toBe(false);
    // Arabic reaches the byte limit with fewer characters.
    const a = 'ن'.repeat(INLINE_TEXT_MAX_BYTES / 2 + 1);
    expect(a.length).toBeLessThan(INLINE_TEXT_MAX_BYTES);
    expect(needsSideFile(a, 'android')).toBe(true);
  });
});

describe('encode / decode', () => {
  test('iOS: exactly JSON.stringify, whatever the length', () => {
    const doc = { ...base, ocrText: long };
    const rec = encodeDocRecord(doc, 'ios');
    expect(rec.json).toBe(JSON.stringify(doc));
    expect(Object.keys(mockFiles)).toEqual([]);
  });

  test('Android, short text: inline as before', () => {
    const doc = { ...base, ocrText: 'hello' };
    expect(encodeDocRecord(doc, 'android').json).toBe(JSON.stringify(doc));
  });

  test('Android, long text: a side file, a small record, read back whole', () => {
    for (const text of [long, arabic]) {
      const doc = { ...base, ocrText: text };
      const rec = encodeDocRecord(doc, 'android');
      rec.committed();
      expect(utf8Length(rec.json)).toBeLessThan(4096);
      const stored = JSON.parse(rec.json);
      expect(stored.ocrText).toBeUndefined();
      expect(stored.ocrTextFile).toMatch(/^ocr-text-[0-9a-z]+\.txt$/);
      expect(mockFiles[`${DIR}${stored.ocrTextFile}`]).toBe(text);
      const back = decodeDocRecord(rec.json);
      expect(back).toEqual(doc);
      expect('ocrTextFile' in back).toBe(false);
      // Only the newest side file is kept.
      expect(Object.keys(mockFiles).filter(u => u.startsWith(DIR))).toEqual([`${DIR}${stored.ocrTextFile}`]);
    }
  });

  test('an unchanged text is not written again; a shorter one prunes the side file once stored', () => {
    const doc = { ...base, ocrText: long };
    const first = encodeDocRecord(doc, 'android');
    first.committed();
    const name = JSON.parse(first.json).ocrTextFile;
    mockFiles[`${DIR}${name}`] = long; // same content
    const spy = jest.spyOn(Object.getPrototypeOf(new (jest.requireMock('expo-file-system').File)('x')), 'write');
    const again = encodeDocRecord({ ...doc, updatedAt: 3 }, 'android');
    expect(JSON.parse(again.json).ocrTextFile).toBe(name);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    const short = encodeDocRecord({ ...doc, ocrText: 'short now' }, 'android');
    expect(mockFiles[`${DIR}${name}`]).toBe(long); // still there until the record is stored
    short.committed();
    expect(mockFiles[`${DIR}${name}`]).toBeUndefined();
  });

  test('a side file that cannot be written: the text is cut to fit the record, the save never fails', () => {
    (globalThis as any).mockFailWrites = true;
    const rec = encodeDocRecord({ ...base, ocrText: long }, 'android');
    const stored = JSON.parse(rec.json);
    expect(stored.ocrTextFile).toBeUndefined();
    expect(utf8Length(stored.ocrText)).toBeLessThanOrEqual(INLINE_TEXT_MAX_BYTES);
    expect(long.startsWith(stored.ocrText)).toBe(true);
  });

  test('reading: old inline records as they are; a missing side file leaves no text; corrupt JSON throws', () => {
    const old = { ...base, ocrText: 'inline from an older build' };
    expect(decodeDocRecord(JSON.stringify(old))).toEqual(old);
    const orphan = decodeDocRecord(JSON.stringify({ ...base, ocrTextFile: 'ocr-text-abc.txt' }));
    expect(orphan).toEqual(base);
    // A name that isn't one of ours is never opened.
    mockFiles[`${DIR}../../secret.txt`] = 'x';
    expect(decodeDocRecord(JSON.stringify({ ...base, ocrTextFile: '../../secret.txt' })).ocrText).toBeUndefined();
    // Without the text (file-ref readers).
    encodeDocRecord({ ...base, ocrText: long }, 'android').committed();
    const name = Object.keys(mockFiles).find(u => u.startsWith(DIR))!.slice(DIR.length);
    expect(decodeDocRecord(JSON.stringify({ ...base, ocrTextFile: name }), false)).toEqual(base);
    expect(() => decodeDocRecord('{oops')).toThrow();
  });
});

describe('lib/storage on Android', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Platform } = require('react-native');
  const originalOS = Platform.OS;
  let storage: typeof import('../lib/storage');
  let AsyncStorage: typeof import('@react-native-async-storage/async-storage').default;
  beforeEach(() => {
    Platform.OS = 'android';
    jest.resetModules();
    // The fresh registry has its own react-native, which lib/doc-record reads.
    require('react-native').Platform.OS = 'android';
    AsyncStorage = require('@react-native-async-storage/async-storage');
    storage = require('../lib/storage');
  });
  afterEach(() => {
    Platform.OS = originalOS;
    require('react-native').Platform.OS = originalOS;
  });

  test('a long OCR text round-trips through save, patch, trash and restore', async () => {
    await storage.saveDocument({ ...base, ocrText: long });
    const raw = await AsyncStorage.getItem('@scan_kit_doc:d1');
    expect(raw!.length).toBeLessThan(4096);
    expect((await storage.getDocument('d1'))!.ocrText).toBe(long);
    await storage.patchDocument('d1', { name: 'Renamed' });
    expect((await storage.getDocuments())[0]).toMatchObject({ name: 'Renamed', ocrText: long });
    await storage.trashDocuments(['d1']);
    await storage.restoreDocuments(['d1']);
    expect((await storage.getDocument('d1'))!.ocrText).toBe(long);
    // Removing the text removes it for good (no resurrection from the side file).
    await storage.patchDocument('d1', { ocrText: undefined });
    expect((await storage.getDocument('d1'))!.ocrText).toBeUndefined();
    expect(Object.keys(mockFiles).filter(u => u.startsWith(DIR))).toEqual([]);
  });

  test('a record the batch read chokes on is skipped, not dropped from the index', async () => {
    await storage.saveDocument({ ...base, id: 'a' });
    await storage.saveDocument({ ...base, id: 'b' });
    const rawB = await AsyncStorage.getItem('@scan_kit_doc:b');
    const rawIndex = await AsyncStorage.getItem('@scan_kit_doc_index');
    const tooBig = new Error('Row too big to fit into CursorWindow');
    const setItem = AsyncStorage.setItem as jest.Mock;
    setItem.mockClear();
    (AsyncStorage.multiGet as jest.Mock).mockRejectedValueOnce(tooBig);
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
      if (key === '@scan_kit_doc_index') return rawIndex;
      if (key === '@scan_kit_doc:b') return rawB;
      if (key === '@scan_kit_doc:a') throw tooBig;
      return null;
    });
    expect((await storage.getDocuments()).map(d => d.id)).toEqual(['b']);
    // The index was not rewritten without it.
    expect(setItem.mock.calls.filter(([key]) => key === '@scan_kit_doc_index')).toEqual([]);
  });
});
