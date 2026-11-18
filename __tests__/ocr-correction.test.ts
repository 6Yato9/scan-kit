// __tests__/ocr-correction.test.ts
// Corrections typed in the Recognized text sheet (lib/ocr-cache writeOcrCorrection):
// kept with the page's pixels, used by search, never touching the PDF text layer.

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

import { extractDocText, recognizeLines } from '../lib/ocr';
import { clearOcrMemoryForTests, writeOcrCorrection } from '../lib/ocr-cache';

const PAGE = 'file:///docs/scan-kit/d1/page-0.jpg';
const LINES = [{ text: 'Invoce 42', left: 1, top: 2, width: 3, height: 4 }];
const entries = () => Object.keys(mockFs).filter(u => /\/ocr\/[^/]+\.json$/.test(u));

beforeEach(() => {
  for (const k of Object.keys(mockFs)) delete mockFs[k];
  clearOcrMemoryForTests();
  mockVision.mockReset();
  mockFs[PAGE] = { size: 1000, mtime: 111 };
  mockVision.mockResolvedValue({ text: 'Invoce 42', lines: LINES });
});

test('a correction replaces the text, keeps Vision lines, and survives a new session', async () => {
  await recognizeLines(PAGE);
  expect(writeOcrCorrection(PAGE, 'Invoice 42')).toBe(true);
  const stored = JSON.parse(mockFs[entries()[0]].text!);
  expect(stored.text).toBe('Invoice 42');
  expect(stored.edited).toBe(true);
  // The searchable PDF's positioned words are untouched.
  expect(stored.lines).toHaveLength(1);
  expect(stored.lines[0]).toMatchObject({ left: 1, top: 2, width: 3, height: 4 });

  clearOcrMemoryForTests(); // app relaunched
  expect((await recognizeLines(PAGE)).text).toBe('Invoice 42');
  // The search index is rebuilt from the cache, so it finds the corrected words.
  expect(await extractDocText([PAGE])).toBe('Invoice 42');
  expect(mockVision).toHaveBeenCalledTimes(1);
});

test('nothing to correct without a recognized entry for the current pixels', () => {
  expect(writeOcrCorrection(PAGE, 'Invoice 42')).toBe(false);
  expect(writeOcrCorrection('file:///docs/scan-kit/d1/page-9.jpg', 'x')).toBe(false);
  expect(entries()).toHaveLength(0);
});

test('new pixels (a filter, a mark-up) are read again instead of reusing the correction', async () => {
  await recognizeLines(PAGE);
  writeOcrCorrection(PAGE, 'Invoice 42');
  mockFs[PAGE] = { size: 1200, mtime: 222 }; // page replaced
  mockVision.mockResolvedValue({ text: 'Invoice 42 PAID', lines: LINES });
  expect((await recognizeLines(PAGE)).text).toBe('Invoice 42 PAID');
});

test('an unchanged text writes nothing', async () => {
  await recognizeLines(PAGE);
  const before = mockFs[entries()[0]].text;
  expect(writeOcrCorrection(PAGE, 'Invoce 42')).toBe(true);
  expect(mockFs[entries()[0]].text).toBe(before);
});
