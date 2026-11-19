// lib/pdf-thumb.ts: first-page thumbnails keyed so that an Undo (which puts
// back a copy of the PDF with its old modification time and size) never
// names a thumbnail that was already deleted (r12 code review #3), and
// renders dropped whenever the PDF changes (r12 code review #2).
const mockFs = new Map<string, { data: string; mtime: number }>();

jest.mock('expo-file-system', () => {
  const part = (p: any) => (p && typeof p === 'object' ? p.uri : String(p));
  const join = (parts: any[]) => parts.map(part).map((s: string) => s.replace(/\/+$/, '')).join('/');
  class MockFile {
    uri: string;
    constructor(...parts: any[]) { this.uri = join(parts); }
    get exists() { return mockFs.has(this.uri); }
    get size() { return mockFs.get(this.uri)?.data.length ?? 0; }
    get modificationTime() { return mockFs.get(this.uri)?.mtime ?? 0; }
    get name() { return this.uri.split('/').pop()!; }
    delete() { mockFs.delete(this.uri); }
    move(dest: MockFile) {
      mockFs.set(dest.uri, mockFs.get(this.uri)!);
      mockFs.delete(this.uri);
      this.uri = dest.uri;
    }
  }
  class MockDirectory {
    uri: string;
    constructor(...parts: any[]) { this.uri = join(parts); }
    get exists() { return [...mockFs.keys()].some(k => k.startsWith(`${this.uri}/`)); }
    get name() { return this.uri.split('/').pop()!; }
    create() {}
    delete() { for (const k of [...mockFs.keys()]) if (k.startsWith(`${this.uri}/`)) mockFs.delete(k); }
    list() {
      const seen = new Map<string, any>();
      for (const k of mockFs.keys()) {
        if (!k.startsWith(`${this.uri}/`)) continue;
        const rest = k.slice(this.uri.length + 1);
        const head = rest.split('/')[0];
        if (!seen.has(head)) seen.set(head, rest.includes('/') ? new MockDirectory(this.uri, head) : new MockFile(this.uri, head));
      }
      return [...seen.values()];
    }
  }
  return { File: MockFile, Directory: MockDirectory, Paths: { cache: { uri: 'file:///caches' } } };
});

const mockRender = jest.fn(async (pdf: string, outDir: string, _edge: number) => {
  const out = `${outDir}/pdfpage-0.jpg`;
  mockFs.set(out, { data: `render(${mockFs.get(pdf)!.data})`, mtime: 1 });
  return [out];
});
jest.mock('../modules/vision-ocr/src', () => ({ VisionOcr: { renderPdfPages: (...a: [string, string, number]) => mockRender(...a) } }));
jest.mock('../lib/files', () => ({
  PDF_THUMB_DIR: 'pdf-thumbs',
  removePdfThumbFiles: (docId: string) => {
    for (const k of [...mockFs.keys()]) {
      const name = k.replace('file:///caches/pdf-thumbs/', '').split('/')[0];
      if (k.startsWith('file:///caches/pdf-thumbs/') && (name.startsWith(`${docId}-`) || name.startsWith(`pages-${docId}-`))) mockFs.delete(k);
    }
  },
}));

import { invalidatePdfThumbs, pdfThumbnail } from '../lib/pdf-thumb';

const PDF = 'file:///support/d1/document.pdf';
const thumbFiles = () => [...mockFs.keys()].filter(k => k.startsWith('file:///caches/pdf-thumbs/'));

beforeEach(() => {
  mockFs.clear();
  mockRender.mockClear();
});

test('after an edit and its Undo the thumbnail is the PDF that is there, never a deleted file', async () => {
  mockFs.set(PDF, { data: 'v1', mtime: 100 });
  const first = await pdfThumbnail('d1', PDF);
  expect(mockFs.get(first!)!.data).toBe('render(v1)');

  // Edit: a new file (new size/mtime) is swapped in.
  mockFs.set(PDF, { data: 'v2-edited', mtime: 200 });
  invalidatePdfThumbs('d1');
  expect(thumbFiles()).toEqual([]); // the old render is gone with the old pages
  const edited = await pdfThumbnail('d1', PDF);
  expect(mockFs.get(edited!)!.data).toBe('render(v2-edited)');

  // Undo: the stashed copy comes back with the ORIGINAL mtime and size.
  mockFs.set(PDF, { data: 'v1', mtime: 100 });
  invalidatePdfThumbs('d1');
  const undone = await pdfThumbnail('d1', PDF);
  expect(undone).not.toBe(first); // a new key, not the pre-edit one
  expect(mockFs.has(undone!)).toBe(true); // not blank
  expect(mockFs.get(undone!)!.data).toBe('render(v1)');
});

test('a remembered thumbnail whose file has gone is rendered again', async () => {
  mockFs.set(PDF, { data: 'v1', mtime: 100 });
  const uri = await pdfThumbnail('d1', PDF);
  mockFs.delete(uri!);
  const again = await pdfThumbnail('d1', PDF);
  expect(mockRender).toHaveBeenCalledTimes(2);
  expect(mockFs.has(again!)).toBe(true);
});

test('invalidating one document leaves the others alone', async () => {
  mockFs.set(PDF, { data: 'v1', mtime: 100 });
  mockFs.set('file:///support/d2/document.pdf', { data: 'w', mtime: 100 });
  await pdfThumbnail('d1', PDF);
  const other = await pdfThumbnail('d2', 'file:///support/d2/document.pdf');
  invalidatePdfThumbs('d1');
  expect(thumbFiles()).toEqual([other]);
});
