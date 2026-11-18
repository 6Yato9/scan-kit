// __tests__/ocr-cache.test.ts
// Searchable PDF export reuses the text index's OCR instead of running Vision
// on every page again (r5 code review M3), and export cancel doesn't wait for
// Vision to finish.

type Fake = { size: number; mtime: number; text?: string };
const mockFs: Record<string, Fake> = {};

jest.mock('expo-file-system', () => {
  const join = (parts: any[]) => parts.map(p => (p && typeof p === 'object' ? p.uri : p)).join('/');
  const under = (dir: string) => Object.keys(mockFs).filter(u => u.startsWith(`${dir}/`));
  class MockFile {
    uri: string;
    constructor(...parts: any[]) { this.uri = join(parts); }
    get exists() { return !!mockFs[this.uri]; }
    get size() { return mockFs[this.uri]?.size ?? 0; }
    get modificationTime() { return mockFs[this.uri]?.mtime ?? null; }
    textSync() {
      const f = mockFs[this.uri];
      if (!f || f.text === undefined) throw new Error('ENOENT');
      return f.text;
    }
    create() { mockFs[this.uri] = mockFs[this.uri] ?? { size: 0, mtime: Date.now() }; }
    write(text: string) { mockFs[this.uri] = { size: text.length, mtime: Date.now(), text }; }
    delete() { delete mockFs[this.uri]; }
    move(dest: MockFile) { mockFs[dest.uri] = mockFs[this.uri]; delete mockFs[this.uri]; }
  }
  class MockDirectory {
    uri: string;
    constructor(...parts: any[]) { this.uri = join(parts).replace(/\/+$/, ''); }
    // A folder exists while it holds a file (or a test marked it with "<dir>/.keep").
    get exists() { return under(this.uri).length > 0; }
    create() { mockFs[`${this.uri}/.keep`] = { size: 0, mtime: 0 }; }
    delete() { for (const u of under(this.uri)) delete mockFs[u]; }
    // Direct children only.
    list() {
      return under(this.uri)
        .filter(u => !u.slice(this.uri.length + 1).includes('/') && !u.endsWith('/.keep'))
        .map(u => new MockFile(u));
    }
  }
  return { File: MockFile, Directory: MockDirectory, Paths: { cache: 'file:///cache', document: 'file:///docs' } };
});

const mockVision = jest.fn();
jest.mock('../modules/vision-ocr/src', () => ({
  VisionOcr: { recognize: (uri: string) => mockVision(uri) },
}));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import { extractDocText, OcrAbortedError, recognizeLines } from '../lib/ocr';
import {
  clearLegacyOcrCache,
  clearOcrMemoryForTests,
  fileIdentity,
  forgetDocumentOcr,
  pruneDocumentOcr,
} from '../lib/ocr-cache';

const PAGE = 'file:///docs/scan-kit/d1/page-0.jpg';
const result = (text: string) => ({ text, lines: [{ text, left: 1, top: 2, width: 3, height: 4 }] });
const DOC = 'file:///docs/scan-kit/d1';
// Every OCR entry anywhere on "disk" (doc folders and the legacy Caches folder).
const cacheEntries = () => Object.keys(mockFs).filter(u => /\/ocr(-lines)?\/[^/]+\.json$/.test(u));

beforeEach(() => {
  for (const k of Object.keys(mockFs)) delete mockFs[k];
  clearOcrMemoryForTests();
  mockVision.mockReset();
});

test('the text index caches each page; a later export reads it without running Vision', async () => {
  mockFs[PAGE] = { size: 1000, mtime: 111 };
  mockVision.mockResolvedValue(result('Invoice 42'));
  expect(await extractDocText([PAGE])).toBe('Invoice 42');
  expect(mockVision).toHaveBeenCalledTimes(1);
  expect(cacheEntries()).toHaveLength(1);

  // Fresh session (memory gone): the entry on disk still answers.
  clearOcrMemoryForTests();
  const again = await recognizeLines(`${PAGE}?v=9`);
  expect(again).toEqual(result('Invoice 42'));
  expect(mockVision).toHaveBeenCalledTimes(1);
});

test('new pixels (a bake, rotate, retake) change the identity, so OCR runs again', async () => {
  mockFs[PAGE] = { size: 1000, mtime: 111 };
  mockVision.mockResolvedValueOnce(result('before'));
  await recognizeLines(PAGE);
  mockFs[PAGE] = { size: 1200, mtime: 222 };
  mockVision.mockResolvedValueOnce(result('after'));
  expect((await recognizeLines(PAGE)).text).toBe('after');
  expect(mockVision).toHaveBeenCalledTimes(2);
});

test('a renamed page (reorder) keeps its identity and still hits', async () => {
  mockFs[PAGE] = { size: 1000, mtime: 111 };
  mockVision.mockResolvedValue(result('moved'));
  await recognizeLines(PAGE);
  const moved = 'file:///docs/scan-kit/d1/page-3.jpg';
  mockFs[moved] = mockFs[PAGE];
  delete mockFs[PAGE];
  expect((await recognizeLines(moved)).text).toBe('moved');
  expect(mockVision).toHaveBeenCalledTimes(1);
});

test('a page replaced while Vision was reading it is not cached under the old identity', async () => {
  mockFs[PAGE] = { size: 1000, mtime: 111 };
  mockVision.mockImplementationOnce(async () => {
    mockFs[PAGE] = { size: 999, mtime: 333 }; // a bake landed mid-OCR
    return result('stale');
  });
  await recognizeLines(PAGE);
  expect(cacheEntries()).toHaveLength(0);
});

test('the index and an export reading the same page share one Vision pass', async () => {
  mockFs[PAGE] = { size: 1000, mtime: 111 };
  let finish!: (v: unknown) => void;
  mockVision.mockReturnValue(new Promise(r => { finish = r; }));
  const a = extractDocText([PAGE]);
  const b = recognizeLines(PAGE);
  finish(result('shared'));
  expect(await a).toBe('shared');
  expect((await b).text).toBe('shared');
  expect(mockVision).toHaveBeenCalledTimes(1);
});

test('cancel rejects at once instead of waiting for Vision; the result still lands in the cache', async () => {
  mockFs[PAGE] = { size: 1000, mtime: 111 };
  let finish!: (v: unknown) => void;
  mockVision.mockReturnValue(new Promise(r => { finish = r; }));
  const controller = new AbortController();
  const pending = recognizeLines(PAGE, controller.signal);
  controller.abort();
  await expect(pending).rejects.toBeInstanceOf(OcrAbortedError);
  finish(result('late'));
  await new Promise(r => setImmediate(r));
  expect((await recognizeLines(PAGE)).text).toBe('late');
  expect(mockVision).toHaveBeenCalledTimes(1);
});

test('an already-aborted signal never starts OCR', async () => {
  mockFs[PAGE] = { size: 1000, mtime: 111 };
  const controller = new AbortController();
  controller.abort();
  await expect(recognizeLines(PAGE, controller.signal)).rejects.toBeInstanceOf(OcrAbortedError);
  expect(mockVision).not.toHaveBeenCalled();
});

test('a missing or unreadable file is never cached (identity null)', async () => {
  expect(fileIdentity('file:///nope.jpg')).toBeNull();
  mockVision.mockResolvedValue(result('x'));
  await recognizeLines('file:///nope.jpg');
  await recognizeLines('file:///nope.jpg');
  expect(mockVision).toHaveBeenCalledTimes(2);
  expect(cacheEntries()).toHaveLength(0);
});

test('a corrupt cache entry is ignored and OCR runs', async () => {
  mockFs[PAGE] = { size: 1000, mtime: 111 };
  mockFs[`${DOC}/ocr/1000-111.json`] = { size: 3, mtime: 1, text: '{no' };
  mockVision.mockResolvedValue(result('fresh'));
  expect((await recognizeLines(PAGE)).text).toBe('fresh');
  expect(mockVision).toHaveBeenCalledTimes(1);
});

// ── r6 code review #3: recognised text must not outlive its document ────────

test('entries live in the document\'s own folder, so deleting the folder deletes the text', async () => {
  mockFs[PAGE] = { size: 1000, mtime: 111 };
  mockVision.mockResolvedValue(result('Salary 90,000'));
  await extractDocText([PAGE]);
  expect(cacheEntries()).toEqual([`${DOC}/ocr/1000-111.json`]);

  // Delete forever / empty trash / 30-day purge: lib/files deleteDocumentFiles
  // forgets the memory copy and deletes the folder.
  forgetDocumentOcr('d1');
  for (const u of Object.keys(mockFs)) if (u.startsWith(`${DOC}/`)) delete mockFs[u];
  expect(cacheEntries()).toEqual([]);
  // Nothing in memory answers for it either: a new file with the same
  // identity is read by Vision again.
  mockFs[PAGE] = { size: 1000, mtime: 111 };
  await recognizeLines(PAGE);
  expect(mockVision).toHaveBeenCalledTimes(2);
});

test('a result that lands after its document was deleted is not kept anywhere', async () => {
  mockFs[PAGE] = { size: 1000, mtime: 111 };
  let finish!: (v: unknown) => void;
  mockVision.mockReturnValueOnce(new Promise(r => { finish = r; }));
  const pending = recognizeLines(PAGE);
  // Deleted forever while Vision was still reading the page.
  for (const u of Object.keys(mockFs)) if (u.startsWith(`${DOC}/`)) delete mockFs[u];
  finish(result('late'));
  await pending;
  expect(cacheEntries()).toEqual([]);
  // Not in memory either: the same pixels restored are read again.
  mockFs[PAGE] = { size: 1000, mtime: 111 };
  mockVision.mockResolvedValueOnce(result('again'));
  expect((await recognizeLines(PAGE)).text).toBe('again');
});

test('deleting a page prunes its text; the remaining pages keep theirs', async () => {
  const p0 = `${DOC}/page-0.jpg`;
  const p1 = `${DOC}/page-1.jpg`;
  mockFs[p0] = { size: 1000, mtime: 111 };
  mockFs[p1] = { size: 2000, mtime: 222 };
  mockVision.mockResolvedValueOnce(result('secret page')).mockResolvedValueOnce(result('keep me'));
  await extractDocText([p0, p1]);
  expect(cacheEntries()).toHaveLength(2);

  // lib/files deleteSinglePage(d1, 0): page-1 moves down to page-0 (a rename
  // keeps its identity), then prunes.
  mockFs[p0] = mockFs[p1];
  delete mockFs[p1];
  pruneDocumentOcr('d1');
  expect(cacheEntries()).toEqual([`${DOC}/ocr/2000-222.json`]);
  expect((await recognizeLines(p0)).text).toBe('keep me');
  expect(mockVision).toHaveBeenCalledTimes(2);
});

test('text of pixels a page no longer has is pruned once entries outnumber pages', async () => {
  mockFs[PAGE] = { size: 1000, mtime: 111 };
  mockVision.mockResolvedValueOnce(result('before markup')).mockResolvedValueOnce(result('after markup'));
  await recognizeLines(PAGE);
  mockFs[PAGE] = { size: 1500, mtime: 999 }; // marked up: new pixels
  await recognizeLines(PAGE);
  expect(cacheEntries()).toEqual([`${DOC}/ocr/1500-999.json`]);
});

test('an image outside a document folder is cached in memory only', async () => {
  const temp = 'file:///cache/ImagePicker/photo.jpg';
  mockFs[temp] = { size: 500, mtime: 5 };
  mockVision.mockResolvedValue(result('receipt'));
  await recognizeLines(temp);
  await recognizeLines(temp);
  expect(mockVision).toHaveBeenCalledTimes(1);
  expect(cacheEntries()).toEqual([]);
});

test('the pre-r6 shared cache folder is deleted at startup', () => {
  mockFs['file:///cache/ocr-lines/1000-111.json'] = { size: 10, mtime: 1, text: '{"text":"old","lines":[]}' };
  mockFs['file:///cache/ocr-lines/2000-222.json'] = { size: 10, mtime: 1, text: '{"text":"old","lines":[]}' };
  clearLegacyOcrCache();
  expect(cacheEntries()).toEqual([]);
});
