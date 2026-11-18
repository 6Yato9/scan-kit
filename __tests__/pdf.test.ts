// __tests__/pdf.test.ts
import * as FileSystem from 'expo-file-system/legacy';
import * as Print from 'expo-print';
import * as ImageManipulator from 'expo-image-manipulator';
import { Image } from 'react-native';
import {
  buildPdfHtml,
  escapeHtml,
  fitContain,
  generatePdf,
  PAPER_SIZES_PT,
  PdfCancelledError,
  PdfError,
} from '../lib/pdf';
import { recognizeLines } from '../lib/ocr';

// lib/pdf.ts reads page files via the legacy filesystem API (the v19 main-export
// functions throw at runtime), so the mock targets the legacy subpath.
jest.mock('expo-file-system/legacy', () => ({
  readAsStringAsync: jest.fn().mockResolvedValue('FAKEBASE64'),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  EncodingType: { Base64: 'base64' },
}));

jest.mock('expo-print', () => ({
  printToFileAsync: jest.fn().mockResolvedValue({ uri: 'file:///output.pdf' }),
}));

jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn().mockResolvedValue({
    uri: 'file:///cache/manip.jpg',
    width: 1800,
    height: 2400,
    base64: 'SMALLB64',
  }),
  SaveFormat: { JPEG: 'jpeg' },
}));

jest.mock('../lib/ocr', () => ({
  recognizeLines: jest.fn().mockResolvedValue({
    text: 'Total <due> & paid',
    lines: [{ text: 'Total <due> & paid', left: 100, top: 200, width: 400, height: 40 }],
  }),
}));

const mockReadAs = FileSystem.readAsStringAsync as jest.Mock;
const mockPrint = Print.printToFileAsync as jest.Mock;
const mockManip = ImageManipulator.manipulateAsync as jest.Mock;
const mockOcr = recognizeLines as jest.Mock;

let imageSize = { width: 1200, height: 1600 };

beforeEach(() => {
  jest.clearAllMocks();
  imageSize = { width: 1200, height: 1600 };
  jest.spyOn(Image, 'getSize').mockImplementation((_uri, ok) => ok(imageSize.width, imageSize.height));
});

const htmlOf = () => mockPrint.mock.calls[0][0].html as string;

test('high quality keeps small pages byte-for-byte and embeds them as data URIs', async () => {
  await generatePdf(['file:///page0.jpg', 'file:///page1.jpg']);
  expect(mockManip).not.toHaveBeenCalled();
  expect(mockReadAs).toHaveBeenCalledTimes(2);
  expect(mockReadAs).toHaveBeenCalledWith('file:///page0.jpg', { encoding: 'base64' });
  expect(htmlOf()).toContain('data:image/jpeg;base64,FAKEBASE64');
  expect(htmlOf()).not.toContain('file:///page0.jpg');
});

test('strips ?v= cache-bust suffixes before touching native APIs', async () => {
  await generatePdf(['file:///page0.jpg?v=123']);
  expect(mockReadAs).toHaveBeenCalledWith('file:///page0.jpg', { encoding: 'base64' });
});

test('downscales pages larger than the quality cap before embedding', async () => {
  imageSize = { width: 3024, height: 4032 };
  await generatePdf(['file:///big.jpg'], { quality: 'high' });
  expect(mockManip).toHaveBeenCalledWith(
    'file:///big.jpg',
    [{ resize: { height: 2400 } }],
    expect.objectContaining({ base64: true, format: 'jpeg' }),
  );
  expect(mockReadAs).not.toHaveBeenCalled();
  expect(htmlOf()).toContain('data:image/jpeg;base64,SMALLB64');
  // The temp file written by the manipulator is cleaned up.
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///cache/manip.jpg', { idempotent: true });
});

test('standard and small quality always re-encode', async () => {
  await generatePdf(['file:///p.jpg'], { quality: 'standard' });
  expect(mockManip).toHaveBeenCalledWith('file:///p.jpg', [], expect.objectContaining({ compress: 0.72 }));
  mockManip.mockClear();
  await generatePdf(['file:///p.jpg'], { quality: 'small' });
  expect(mockManip).toHaveBeenCalledWith('file:///p.jpg', [{ resize: { height: 1300 } }], expect.objectContaining({ compress: 0.55 }));
});

test('big documents get a tighter size cap', async () => {
  imageSize = { width: 2200, height: 3000 };
  const pages = Array.from({ length: 45 }, (_, i) => `file:///p${i}.jpg`);
  await generatePdf(pages, { quality: 'high' });
  expect(mockManip.mock.calls[0][1]).toEqual([{ resize: { height: 1500 } }]);
});

test('passes the paper size to the renderer (A4 default, Letter on request)', async () => {
  await generatePdf(['file:///p.jpg']);
  expect(mockPrint.mock.calls[0][0]).toMatchObject({ width: 595, height: 842 });
  mockPrint.mockClear();
  await generatePdf(['file:///p.jpg'], 'Letter');
  expect(mockPrint.mock.calls[0][0]).toMatchObject({ width: 612, height: 792 });
  expect(htmlOf()).toContain('@page{size:612pt 792pt;margin:0}');
});

test('every page is one fixed-height sheet, and only later sheets break before', () => {
  const html = buildPdfHtml(['<div class="s">a</div>', '<div class="s">b</div>'], 'A4');
  // Sheet height is the A4 aspect ratio in vw, a hair under one page.
  const ratio = (842 / 595) * 100;
  const m = html.match(/\.s\{[^}]*padding-top:([\d.]+)%/);
  expect(m).not.toBeNull();
  const h = parseFloat(m![1]);
  expect(h).toBeLessThan(ratio);
  expect(h).toBeGreaterThan(ratio - 0.5);
  expect(html).toContain('.s+.s{page-break-before:always');
  expect(html).not.toContain('page-break-after');
});

test('fitContain centres tall and wide images inside the paper', () => {
  const a4 = PAPER_SIZES_PT.A4;
  const tall = fitContain({ width: 1000, height: 2000 }, a4);
  expect(tall.height).toBe(1);
  expect(tall.width).toBeLessThan(1);
  expect(tall.left).toBeCloseTo((1 - tall.width) / 2);
  const wide = fitContain({ width: 2000, height: 1000 }, a4);
  expect(wide.width).toBe(1);
  expect(wide.top).toBeCloseTo((1 - wide.height) / 2);
  const exact = fitContain({ width: 595, height: 842 }, a4);
  expect(exact).toEqual({ left: 0, top: 0, width: 1, height: 1 });
});

test('returns the URI from printToFileAsync', async () => {
  const uri = await generatePdf(['file:///page0.jpg']);
  expect(uri).toBe('file:///output.pdf');
});

// Regression guard: filters are baked into the page pixels (see lib/bake.ts)
// before generatePdf ever reads them, so the exported HTML must never inject a
// CSS `filter:` — that would double-apply the filter.
test('never injects a CSS filter into the exported HTML', async () => {
  await generatePdf(['file:///page0.jpg']);
  expect(htmlOf()).not.toContain('filter:');
});

test('searchable PDF adds an escaped, transparent text layer', async () => {
  await generatePdf(['file:///page0.jpg'], { searchable: true });
  expect(mockOcr).toHaveBeenCalledWith('file:///page0.jpg');
  const html = htmlOf();
  expect(html).toContain('Total &lt;due&gt; &amp; paid');
  expect(html).not.toContain('<due>');
  expect(html).toContain('.t{position:absolute;color:transparent');
});

test('overlayHtml is called per page with the image box size in points', async () => {
  imageSize = { width: 595, height: 842 };
  const overlay = jest.fn((i: number) => `<b>overlay-${i}</b>`);
  await generatePdf(['file:///a.jpg', 'file:///b.jpg'], { overlayHtml: overlay });
  expect(overlay).toHaveBeenCalledTimes(2);
  expect(overlay).toHaveBeenCalledWith(0, { width: 595, height: 842 });
  const html = htmlOf();
  expect(html).toContain('<div class="o"><b>overlay-0</b></div>');
  expect(html).toContain('<div class="o"><b>overlay-1</b></div>');
  expect(html).toContain('--pt:');
});

test('escapeHtml escapes all HTML-significant characters', () => {
  expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
    '&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;',
  );
});

test('a page that cannot be read gives a numbered, user-safe error', async () => {
  mockReadAs.mockRejectedValueOnce(new Error('ENOENT /var/mobile/secret/path'));
  await expect(generatePdf(['file:///a.jpg'])).rejects.toMatchObject({
    kind: 'read',
    message: 'Couldn’t read page 1.',
  });
});

test('empty documents are rejected', async () => {
  await expect(generatePdf([])).rejects.toBeInstanceOf(PdfError);
});

test('an aborted signal cancels before rendering', async () => {
  const c = new AbortController();
  c.abort();
  await expect(generatePdf(['file:///a.jpg'], { signal: c.signal })).rejects.toBeInstanceOf(PdfCancelledError);
  expect(mockPrint).not.toHaveBeenCalled();
});

test('a renderer that never settles times out instead of hanging', async () => {
  mockPrint.mockReturnValueOnce(new Promise(() => {}));
  await expect(generatePdf(['file:///a.jpg'], { timeoutMs: 20 })).rejects.toMatchObject({ kind: 'timeout' });
});

test('cancelling while the renderer runs rejects right away', async () => {
  mockPrint.mockReturnValueOnce(new Promise(() => {}));
  const c = new AbortController();
  const p = generatePdf(['file:///a.jpg'], { signal: c.signal, timeoutMs: 60_000 });
  setTimeout(() => c.abort(), 5);
  await expect(p).rejects.toBeInstanceOf(PdfCancelledError);
});

test('only searchable exports carry the text-fitting script', async () => {
  await generatePdf(['file:///a.jpg'], { searchable: true });
  expect(htmlOf()).toContain('<script>');
  mockPrint.mockClear();
  await generatePdf(['file:///a.jpg']);
  expect(htmlOf()).not.toContain('<script>');
});

test('backgrounds are printed (needed for overlays and the test page)', () => {
  expect(buildPdfHtml([], 'A4')).toContain('print-color-adjust:exact');
});

test('test page renders one sheet at the requested paper size', async () => {
  const { generateTestPagePdf } = jest.requireActual('../lib/pdf') as typeof import('../lib/pdf');
  await generateTestPagePdf('Letter');
  const call = mockPrint.mock.calls[0][0];
  expect(call).toMatchObject({ width: 612, height: 792 });
  expect(call.html).toContain('US Letter');
  expect(call.html.match(/class="s"/g)).toHaveLength(1);
});
