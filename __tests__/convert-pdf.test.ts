// __tests__/convert-pdf.test.ts
// "Convert to pages" for imported PDFs: native rendering is mocked; the file
// system is an in-memory set of URIs.
const mockFiles = new Set<string>();
const mockMoves: [string, string][] = [];
jest.mock('expo-file-system', () => {
  const part = (p: any) => (p && typeof p === 'object' ? p.uri : p);
  const strip = (u: string) => u.replace(/\/+$/, '');
  class MockFile {
    uri: string;
    constructor(...parts: any[]) { this.uri = parts.map(part).map(strip).join('/'); }
    get exists() { return mockFiles.has(this.uri); }
    delete() { mockFiles.delete(this.uri); }
    copy(dest: MockFile) { if (!mockFiles.has(this.uri)) throw new Error('no src'); mockFiles.add(dest.uri); }
    move(dest: MockFile) {
      if (!mockFiles.has(this.uri)) throw new Error('no src');
      mockFiles.delete(this.uri);
      mockFiles.add(dest.uri);
      mockMoves.push([this.uri, dest.uri]);
      this.uri = dest.uri;
    }
  }
  class MockDirectory {
    uri: string;
    constructor(...parts: any[]) { this.uri = parts.map(part).map(strip).join('/'); }
    get exists() { return [...mockFiles].some(f => f === this.uri || f.startsWith(`${this.uri}/`)); }
    create() { mockFiles.add(this.uri); }
    delete() { for (const f of [...mockFiles]) if (f === this.uri || f.startsWith(`${this.uri}/`)) mockFiles.delete(f); }
  }
  return {
    File: MockFile,
    Directory: MockDirectory,
    Paths: { document: { uri: 'file:///docs' }, cache: { uri: 'file:///caches' } },
  };
});

const mockRender = jest.fn(async (_pdf: string, dir: string, _max: number) => {
  const out = [0, 1, 2].map(i => `${dir.replace(/\/+$/, '')}/pdfpage-00${i}.jpg`);
  out.forEach(u => mockFiles.add(u));
  return out;
});
jest.mock('../modules/vision-ocr/src', () => ({
  VisionOcr: { renderPdfPages: (...a: [string, string, number]) => mockRender(...a) },
}));

const mockCopyPage = jest.fn(async (_src: string, docId: string, i: number, _q: number) => {
  const uri = `file:///docs/scan-kit/${docId}/page-${i}.jpg`;
  mockFiles.add(uri);
  return uri;
});
jest.mock('../lib/files', () => ({
  copyPageWithQuality: (...a: [string, string, number, number]) => mockCopyPage(...a),
}));
jest.mock('../lib/ocr-cache', () => ({ pruneDocumentOcr: jest.fn() }));

let mockDoc: any;
const mockUpdate = jest.fn(async (_id: string, fn: (cur: any) => any) => {
  if (!mockDoc) return false;
  const patch = fn(mockDoc);
  if (!patch) return false;
  mockDoc = { ...mockDoc, ...patch };
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete mockDoc[k];
  return true;
});
jest.mock('../lib/storage', () => ({
  getDocument: jest.fn(async () => (mockDoc ? { ...mockDoc } : null)),
  getScanSettings: jest.fn(async () => ({ quality: 'medium', autoCrop: true, defaultFilter: 'enhanced' })),
  updateDocumentWith: (id: string, fn: (cur: any) => any) => mockUpdate(id, fn),
}));
const mockEdits: any[] = [];
jest.mock('../lib/bake', () => ({
  runPageEdit: (_id: string, edit: unknown, fn: () => unknown) => { mockEdits.push(edit); return Promise.resolve().then(fn); },
}));
const mockFinish = jest.fn();
jest.mock('../lib/add-pages', () => ({ finishAddedPages: (...a: any[]) => mockFinish(...a) }));
const mockIndex = jest.fn(async (..._a: any[]) => {});
jest.mock('../lib/save-scan', () => ({ indexDocText: (...a: any[]) => mockIndex(...a) }));

import { VisionOcr } from '../modules/vision-ocr/src';
import { canConvertPdf, convertPdfToPages, PdfConvertError, undoPdfConversion } from '../lib/convert-pdf';

const PDF = 'file:///docs/scan-kit/d1/document.pdf';
const page = (i: number) => `file:///docs/scan-kit/d1/page-${i}.jpg`;
const native = VisionOcr as unknown as { renderPdfPages?: unknown };
const realRender = native.renderPdfPages;
const cacheLeftovers = () => [...mockFiles].filter(f => f.startsWith('file:///caches/pdf-convert/d1-'));

beforeEach(() => {
  jest.clearAllMocks();
  mockFiles.clear();
  mockMoves.length = 0;
  mockEdits.length = 0;
  native.renderPdfPages = realRender;
  mockDoc = { id: 'd1', name: 'Lease', pages: [], pdfUri: `${PDF}?v=2`, folder: 'Home', createdAt: 1, updatedAt: 1 };
  mockFiles.add(PDF);
});

test('canConvertPdf follows the native function', () => {
  expect(canConvertPdf()).toBe(true);
  native.renderPdfPages = undefined;
  expect(canConvertPdf()).toBe(false);
});

test('renders the clean PDF uri, stores every page, and switches the record over in one write', async () => {
  const progress: any[] = [];
  const { doc, pageCount, undo } = await convertPdfToPages('d1', { onProgress: p => progress.push(p) });
  expect(mockRender).toHaveBeenCalledWith(PDF, expect.stringMatching(/^file:\/\/\/caches\/pdf-convert\/d1-\d+$/), 4000);
  expect(pageCount).toBe(3);
  expect(doc.pages).toEqual([page(0), page(1), page(2)]);
  expect(doc.pdfUri).toBeUndefined();
  expect(mockDoc.pdfUri).toBeUndefined();
  expect(mockDoc.folder).toBe('Home'); // untouched fields survive
  expect(mockUpdate).toHaveBeenCalledTimes(1);
  // Stored as rendered (no second JPEG pass), size cap still applies inside copyPageWithQuality.
  expect(mockCopyPage.mock.calls.map(c => c[3])).toEqual([1, 1, 1]);
  expect(progress).toEqual([
    { stage: 'rendering' },
    { stage: 'saving', done: 1, total: 3 },
    { stage: 'saving', done: 2, total: 3 },
    { stage: 'saving', done: 3, total: 3 },
  ]);
  // Default filter bake + text index for every page.
  expect(mockFinish).toHaveBeenCalledWith(doc, [0, 1, 2], 'enhanced');
  // The PDF left the document folder for an Undo stash; render temps are gone.
  expect(mockFiles.has(PDF)).toBe(false);
  expect(undo).not.toBeNull();
  expect(mockFiles.has(undo!.stashUri)).toBe(true);
  expect(cacheLeftovers()).toEqual([]);
});

test('a stale shadow from an interrupted attempt is removed before the page lands', async () => {
  mockFiles.add('file:///docs/scan-kit/d1/page-1.orig.jpg');
  await convertPdfToPages('d1');
  expect(mockFiles.has('file:///docs/scan-kit/d1/page-1.orig.jpg')).toBe(false);
});

test('a locked PDF is reported as such and changes nothing', async () => {
  mockRender.mockRejectedValueOnce(new Error('This PDF is password protected'));
  const err = await convertPdfToPages('d1').catch(e => e);
  expect(err).toBeInstanceOf(PdfConvertError);
  expect(err.kind).toBe('locked');
  expect(mockDoc.pdfUri).toBe(`${PDF}?v=2`);
  expect(mockFiles.has(PDF)).toBe(true);
  expect(mockUpdate).not.toHaveBeenCalled();
  expect(cacheLeftovers()).toEqual([]);
});

test('a failure part-way removes the pages written so far and keeps the PDF', async () => {
  mockCopyPage
    .mockImplementationOnce(async (_s, docId, i) => { const u = `file:///docs/scan-kit/${docId}/page-${i}.jpg`; mockFiles.add(u); return u; })
    .mockRejectedValueOnce(new Error('disk full'));
  const err = await convertPdfToPages('d1').catch(e => e);
  expect(err).toBeInstanceOf(PdfConvertError);
  expect(err.kind).toBe('failed');
  expect(mockFiles.has(page(0))).toBe(false);
  expect(mockFiles.has(PDF)).toBe(true);
  expect(mockDoc.pdfUri).toBe(`${PDF}?v=2`);
  expect(mockDoc.pages).toEqual([]);
  expect(mockFinish).not.toHaveBeenCalled();
  expect(cacheLeftovers()).toEqual([]);
});

test('a document deleted meanwhile fails as missing without writing', async () => {
  mockRender.mockImplementationOnce(async (_p, dir) => { mockDoc = null; const u = `${dir}/pdfpage-000.jpg`; mockFiles.add(u); return [u]; });
  const err = await convertPdfToPages('d1').catch(e => e);
  expect(err.kind).toBe('missing');
  expect(mockCopyPage).not.toHaveBeenCalled();
});

test('a document already converted (second tap) is not converted twice', async () => {
  await convertPdfToPages('d1');
  const err = await convertPdfToPages('d1').catch(e => e);
  expect(err).toBeInstanceOf(PdfConvertError);
  expect(mockCopyPage).toHaveBeenCalledTimes(3);
});

test('without the native renderer it refuses as unavailable', async () => {
  native.renderPdfPages = undefined;
  const err = await convertPdfToPages('d1').catch(e => e);
  expect(err.kind).toBe('unavailable');
  expect(mockDoc.pdfUri).toBe(`${PDF}?v=2`);
});

test('Undo puts the PDF back, drops the pages, withdraws bakes and supersedes the text index', async () => {
  const { undo } = await convertPdfToPages('d1');
  mockEdits.length = 0;
  const restored = await undoPdfConversion(undo!);
  expect(restored.pdfUri).toBe(PDF);
  expect(restored.pages).toEqual([]);
  expect(mockDoc.pdfUri).toBe(PDF);
  expect(mockDoc.folder).toBe('Home');
  expect(mockFiles.has(PDF)).toBe(true);
  [0, 1, 2].forEach(i => expect(mockFiles.has(page(i))).toBe(false));
  expect(mockFiles.has(undo!.stashUri)).toBe(false); // single use
  expect((mockEdits[0] as any).remap(0)).toBe(-1);
  expect(mockIndex).toHaveBeenCalledWith('d1', []);
  await expect(undoPdfConversion(undo!)).rejects.toBeInstanceOf(PdfConvertError);
});
