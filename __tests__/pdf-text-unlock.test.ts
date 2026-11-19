// Imported PDFs: their own text goes into the search index (lib/pdf-text.ts;
// unlocking a protected PDF for the session is tested in pdf-session.test.ts).
// Also the viewer-notice hand-off and the stamp
// geometry the in-place canvas uses (lib/stamp.ts).

const mockFs = new Map<string, string>();
jest.mock('expo-file-system', () => {
  const part = (p: any) => (p && typeof p === 'object' ? p.uri : p);
  class MockFile {
    uri: string;
    constructor(...parts: any[]) { this.uri = parts.map(part).join('/'); }
    get exists() { return mockFs.has(this.uri); }
    delete() { mockFs.delete(this.uri); }
    move(dest: any) {
      if (!mockFs.has(this.uri)) throw new Error('missing');
      mockFs.set(dest.uri, mockFs.get(this.uri)!);
      mockFs.delete(this.uri);
      this.uri = dest.uri;
    }
  }
  class MockDirectory {
    uri: string;
    constructor(...parts: any[]) { this.uri = parts.map(part).join('/'); }
    create() {}
  }
  return { File: MockFile, Directory: MockDirectory, Paths: { document: { uri: 'file:///docs' }, cache: { uri: 'file:///cache' } } };
});

const mockNative: any = {};
jest.mock('../modules/vision-ocr/src', () => ({ get VisionOcr() { return mockNative; } }));

let mockDoc: any;
jest.mock('../lib/storage', () => ({
  getDocument: jest.fn(async () => mockDoc),
  updateDocumentWith: jest.fn(async (_id: string, fn: (d: any) => any) => {
    if (!mockDoc) return false;
    const patch = fn(mockDoc);
    if (!patch) return false;
    mockDoc = { ...mockDoc, ...patch };
    return true;
  }),
}));
jest.mock('../lib/bake', () => ({ withDocLock: (_id: string, fn: () => unknown) => Promise.resolve().then(fn) }));
jest.mock('../lib/pdf', () => ({ escapeHtml: (s: string) => s.replace(/</g, '&lt;') }));

import { indexPdfText, joinPdfPageTexts, needsPdfText, PDF_TEXT_MAX_CHARS, resetPdfTextForTests } from '../lib/pdf-text';
import { postViewerNotice, resetViewerNoticesForTests, subscribeViewerNotices, takeViewerNotice } from '../lib/viewer-notice';
import { buildStampHtml, resolveStamp, scriptJson, stampIsDrawable } from '../lib/stamp';

const PDF = 'file:///docs/scan-kit/p1/document.pdf';

beforeEach(() => {
  jest.clearAllMocks();
  mockFs.clear();
  resetPdfTextForTests();
  for (const k of Object.keys(mockNative)) delete mockNative[k];
  mockFs.set(PDF, 'LOCKED');
  mockDoc = { id: 'p1', name: 'Agreement', pages: [], pdfUri: PDF, createdAt: 1, updatedAt: 1 };
});

describe('PDF text index', () => {
  test('joins pages with a blank line, tidies whitespace, caps the length', () => {
    expect(joinPdfPageTexts(['  Hello   world \r\n line two ', '', 'Page  3'])).toBe('Hello world\nline two\n\n\n\nPage 3');
    expect(joinPdfPageTexts(['', '  '])).toBe('');
    expect(joinPdfPageTexts(['x'.repeat(PDF_TEXT_MAX_CHARS + 50)])).toHaveLength(PDF_TEXT_MAX_CHARS);
  });

  test('stores the embedded text so search finds the PDF', async () => {
    mockNative.pdfPageTexts = jest.fn(async () => ['SERVICE AGREEMENT', 'Brightwater Plumbing']);
    await expect(indexPdfText('p1')).resolves.toBe('indexed');
    expect(mockDoc.ocrText).toBe('SERVICE AGREEMENT\n\nBrightwater Plumbing');
    expect(mockNative.pdfPageTexts).toHaveBeenCalledWith(PDF, null);
  });

  test('an image-only PDF stores nothing (Convert to pages OCRs it)', async () => {
    mockNative.pdfPageTexts = jest.fn(async () => ['', '']);
    await expect(indexPdfText('p1')).resolves.toBe('no-text');
    expect(mockDoc.ocrText).toBeUndefined();
    // Not read again on the next open this session.
    await expect(indexPdfText('p1')).resolves.toBe('skipped');
    expect(mockNative.pdfPageTexts).toHaveBeenCalledTimes(1);
  });

  test('a locked PDF is reported, not indexed', async () => {
    mockNative.pdfPageTexts = jest.fn(async () => { throw new Error('locked'); });
    await expect(indexPdfText('p1')).resolves.toBe('locked');
    expect(mockDoc.ocrText).toBeUndefined();
  });

  test('never writes onto a document converted to pages meanwhile', async () => {
    mockNative.pdfPageTexts = jest.fn(async () => {
      mockDoc = { ...mockDoc, pdfUri: undefined, pages: ['file:///p.jpg'] };
      return ['text'];
    });
    await expect(indexPdfText('p1')).resolves.toBe('skipped');
    expect(mockDoc.ocrText).toBeUndefined();
  });

  test('needsPdfText: PDFs without text, when the native reader exists', () => {
    expect(needsPdfText(mockDoc)).toBe(false);
    mockNative.pdfPageTexts = jest.fn();
    expect(needsPdfText(mockDoc)).toBe(true);
    expect(needsPdfText({ ...mockDoc, ocrText: 'x' })).toBe(false);
    expect(needsPdfText({ ...mockDoc, pdfUri: undefined, pages: ['a'] })).toBe(false);
  });
});

describe('viewer notices', () => {
  beforeEach(() => resetViewerNoticesForTests());
  test('taken once, only by the viewer of that document; newer replaces older', () => {
    const seen = jest.fn();
    const unsubscribe = subscribeViewerNotices(seen);
    postViewerNotice({ docId: 'a', message: 'Signed' });
    postViewerNotice({ docId: 'a', message: 'Signed page 2', page: 1 });
    expect(seen).toHaveBeenCalledTimes(2);
    expect(takeViewerNotice('b')).toBeNull();
    expect(takeViewerNotice('a')).toMatchObject({ message: 'Signed page 2', page: 1 });
    expect(takeViewerNotice('a')).toBeNull();
    unsubscribe();
    postViewerNotice({ docId: 'a', message: 'x' });
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

describe('in-place stamp geometry', () => {
  test('watermark resolves to the preview’s numbers', () => {
    const r = resolveStamp({ kind: 'watermark', text: ' DRAFT ', style: 'diagonal', color: 'red' });
    expect(r).toMatchObject({ kind: 'watermark', text: 'DRAFT', layout: 'rotated', angle: -35 });
    if (r.kind !== 'watermark') throw new Error();
    expect(r.ink).toBe('rgba(200,30,30,0.28)');
    expect(resolveStamp({ kind: 'watermark', text: 'A', style: 'footer', color: 'gray' })).toMatchObject({ layout: 'footer', angle: 0 });
  });

  test('timestamp and signature', () => {
    expect(resolveStamp({ kind: 'timestamp', text: '18 Nov 2026', corner: 'top-left' })).toMatchObject({
      corner: 'top-left', fontFrac: 0.016, insetFrac: 0.016, ink: '#222222',
    });
    expect(resolveStamp({ kind: 'signature', signature: { dataUri: 'data:image/png;base64,AA==', width: 2, height: 1 }, placement: { x: 0.1, y: 0.2, w: 0.3 } }))
      .toEqual({ kind: 'signature', x: 0.1, y: 0.2, w: 0.3, tint: null });
  });

  test('nothing to draw is caught before any page is touched', () => {
    expect(stampIsDrawable({ kind: 'watermark', text: '  ', style: 'center', color: 'gray' })).toBe(false);
    expect(stampIsDrawable({ kind: 'signature', signature: { dataUri: 'javascript:alert(1)', width: 1, height: 1 }, placement: { x: 0, y: 0, w: 0.3 } })).toBe(false);
    expect(stampIsDrawable({ kind: 'timestamp', text: '18 Nov', corner: 'bottom-right' })).toBe(true);
  });

  test('user text cannot end the canvas script early', () => {
    expect(scriptJson({ t: '</script><script>x()</script>' })).not.toContain('</script>');
    const html = buildStampHtml('file:///p.jpg', null, { kind: 'watermark', text: '</script>boom', style: 'center', color: 'gray' });
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain('"orig":null');
  });
});
