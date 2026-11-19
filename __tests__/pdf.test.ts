// __tests__/pdf.test.ts
import * as FileSystem from 'expo-file-system/legacy';
import * as Print from 'expo-print';
import * as ImageManipulator from 'expo-image-manipulator';
import { Image } from 'react-native';
import {
  autoPaperSize,
  buildPdfHtml,
  escapeHtml,
  estimatePdfBytes,
  roundUpEstimate,
  fitContain,
  generatePdf,
  PAPER_SIZES_PT,
  PdfCancelledError,
  PdfError,
  planPaperRuns,
  MAX_RUN_PAGES,
  splitLongRuns,
} from '../lib/pdf';
import { recognizeLines } from '../lib/ocr';
import { VisionOcr } from '../modules/vision-ocr/src';

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

// The native module is optional: a mutable fake so tests can add or remove mergePdfs.
jest.mock('../modules/vision-ocr/src', () => ({ VisionOcr: {} }));
const native = VisionOcr as unknown as { mergePdfs?: jest.Mock };

const mockReadAs = FileSystem.readAsStringAsync as jest.Mock;
const mockPrint = Print.printToFileAsync as jest.Mock;
const mockManip = ImageManipulator.manipulateAsync as jest.Mock;
const mockOcr = recognizeLines as jest.Mock;

let imageSize = { width: 1200, height: 1600 };
/** Per-URI image sizes (falls back to imageSize). */
let sizesByUri: Record<string, { width: number; height: number }> = {};

beforeEach(() => {
  jest.clearAllMocks();
  imageSize = { width: 1200, height: 1600 };
  sizesByUri = {};
  delete native.mergePdfs;
  jest.spyOn(Image, 'getSize').mockImplementation((uri, ok) => {
    const s = sizesByUri[uri] ?? imageSize;
    ok(s.width, s.height);
  });
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
  expect(mockOcr).toHaveBeenCalledWith('file:///page0.jpg', undefined);
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

// r6 code review #4: the native render can't be stopped. When the export has
// given up on it (cancel, timeout) its late PDF — unprotected, even for a
// password-protected export — must be deleted, not left in Caches/Print.
test('a render that finishes after cancel is deleted as soon as it lands', async () => {
  let finish!: (v: { uri: string }) => void;
  mockPrint.mockReturnValueOnce(new Promise(r => { finish = r; }));
  const c = new AbortController();
  const p = generatePdf(['file:///a.jpg'], { signal: c.signal, timeoutMs: 60_000 });
  setTimeout(() => c.abort(), 5);
  await expect(p).rejects.toBeInstanceOf(PdfCancelledError);
  expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
  finish({ uri: 'file:///Caches/Print/late.pdf' });
  await new Promise(r => setImmediate(r));
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///Caches/Print/late.pdf', { idempotent: true });
});

test('a render that finishes after a timeout is deleted too', async () => {
  let finish!: (v: { uri: string }) => void;
  mockPrint.mockReturnValueOnce(new Promise(r => { finish = r; }));
  await expect(generatePdf(['file:///a.jpg'], { timeoutMs: 20 })).rejects.toMatchObject({ kind: 'timeout' });
  finish({ uri: 'file:///Caches/Print/slow.pdf' });
  await new Promise(r => setImmediate(r));
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///Caches/Print/slow.pdf', { idempotent: true });
});

test('a successful render is never deleted by the export itself', async () => {
  await expect(generatePdf(['file:///a.jpg'])).resolves.toBe('file:///output.pdf');
  await new Promise(r => setImmediate(r));
  expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
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

// ── Auto paper size ─────────────────────────────────────────────────────────

test('autoPaperSize shapes the page like a tall receipt, long edge 842 pt', () => {
  expect(autoPaperSize([{ width: 620, height: 1860 }])).toEqual({ width: 281, height: 842 });
});

test('autoPaperSize gives a landscape ID card a wide page', () => {
  const p = autoPaperSize([{ width: 1712, height: 1080 }]);
  expect(p.width).toBe(842);
  expect(p.height).toBe(Math.round(842 / (1712 / 1080)));
});

test('autoPaperSize snaps near-A4 and near-Letter scans to the real paper, either way round', () => {
  expect(autoPaperSize([{ width: 1240, height: 1754 }])).toEqual(PAPER_SIZES_PT.A4);
  expect(autoPaperSize([{ width: 1700, height: 2200 }])).toEqual(PAPER_SIZES_PT.Letter);
  expect(autoPaperSize([{ width: 1754, height: 1240 }])).toEqual({ width: 842, height: 595 });
});

test('autoPaperSize uses the median shape, ignores unreadable pages, falls back to A4', () => {
  const receipt = { width: 600, height: 1800 };
  expect(autoPaperSize([receipt, null, receipt, { width: 2000, height: 1000 }])).toEqual(autoPaperSize([receipt]));
  expect(autoPaperSize([])).toEqual(PAPER_SIZES_PT.A4);
  expect(autoPaperSize([null, { width: 0, height: 0 }])).toEqual(PAPER_SIZES_PT.A4);
});

test('autoPaperSize clamps extreme strips so text stays readable', () => {
  expect(autoPaperSize([{ width: 100, height: 5000 }])).toEqual({ width: Math.round(842 * 0.2), height: 842 });
});

test("generatePdf with 'Auto' renders on paper shaped like the pages", async () => {
  imageSize = { width: 620, height: 1860 };
  await generatePdf(['file:///receipt.jpg'], { pageSize: 'Auto' });
  expect(mockPrint.mock.calls[0][0]).toMatchObject({ width: 281, height: 842 });
  expect(htmlOf()).toContain('@page{size:281pt 842pt;margin:0}');
  // The receipt fills the sheet: no letterboxing either way (within rounding).
  const m = htmlOf().match(/class="b" style="left:([\d.]+)%;top:([\d.]+)%;width:([\d.]+)%;height:([\d.]+)%/);
  expect(m).not.toBeNull();
  expect(parseFloat(m![3])).toBeGreaterThan(99);
  expect(parseFloat(m![4])).toBeGreaterThan(99);
});

// ── Size estimate ───────────────────────────────────────────────────────────

test('estimatePdfBytes scales stored bytes by the downscale area and adds per-page overhead', () => {
  const page = { bytes: 160_000, width: 1500, height: 2000 };
  const standard = estimatePdfBytes([page], 'standard'); // 1800 / 2000 → 0.81 of the pixels
  // Leans high (never under-promise), but stays in the same ballpark.
  expect(standard).toBeGreaterThan(160_000 * 0.81 * 1.1);
  expect(standard).toBeLessThan(160_000 * 0.81 * 1.25);
  const small = estimatePdfBytes([page], 'small'); // 1300 / 2000
  expect(small).toBeLessThan(standard);
  expect(estimatePdfBytes([page], 'standard', true)).toBeGreaterThan(standard);
  expect(estimatePdfBytes([page, page], 'standard')).toBeGreaterThan(standard * 1.9);
});

test('roundUpEstimate rounds up to two significant figures, never down, in decimal units', () => {
  const KB = 1000;
  const MB = 1_000_000;
  expect(roundUpEstimate(126 * KB + 300)).toBe(130 * KB);
  expect(roundUpEstimate(139 * KB)).toBe(140 * KB);
  expect(roundUpEstimate(140 * KB)).toBe(140 * KB);
  expect(roundUpEstimate(9 * KB + 1)).toBe(10 * KB);
  expect(roundUpEstimate(1_000 * KB)).toBe(MB);
  expect(roundUpEstimate(1.21 * MB)).toBeCloseTo(1.3 * MB);
  expect(roundUpEstimate(1.2 * MB)).toBeCloseTo(1.2 * MB);
  expect(roundUpEstimate(12.2 * MB)).toBe(13 * MB);
  expect(roundUpEstimate(0)).toBe(0);
  for (const b of [1, 5_000, 99_999, 140_000, 1_234_567, 25_000_000]) {
    expect(roundUpEstimate(b)).toBeGreaterThanOrEqual(b);
  }
});

// ── Paper per page (runs + native merge) ───────────────────────────────────

const PORTRAIT = { width: 1240, height: 1754 }; // A4-shaped scan
const LANDSCAPE = { width: 1754, height: 1240 };
const RECEIPT = { width: 620, height: 1860 };
const A4_LAND = { width: 842, height: 595 };

test('planPaperRuns without merging: one run, median shape for Auto, portrait for A4', () => {
  const sizes = [PORTRAIT, LANDSCAPE, PORTRAIT];
  expect(planPaperRuns(sizes, 'Auto', false)).toEqual([{ start: 0, end: 3, paper: PAPER_SIZES_PT.A4 }]);
  expect(planPaperRuns(sizes, 'A4', false)).toEqual([{ start: 0, end: 3, paper: PAPER_SIZES_PT.A4 }]);
  expect(planPaperRuns([], 'Auto', true)).toEqual([]);
});

test('planPaperRuns gives each shape its own paper and groups consecutive pages', () => {
  expect(planPaperRuns([PORTRAIT, LANDSCAPE, PORTRAIT], 'Auto', true)).toEqual([
    { start: 0, end: 1, paper: PAPER_SIZES_PT.A4 },
    { start: 1, end: 2, paper: A4_LAND },
    { start: 2, end: 3, paper: PAPER_SIZES_PT.A4 },
  ]);
  expect(planPaperRuns([PORTRAIT, PORTRAIT, RECEIPT, RECEIPT, PORTRAIT], 'Auto', true)).toEqual([
    { start: 0, end: 2, paper: PAPER_SIZES_PT.A4 },
    { start: 2, end: 4, paper: { width: 281, height: 842 } },
    { start: 4, end: 5, paper: PAPER_SIZES_PT.A4 },
  ]);
});

test('planPaperRuns keeps near-identical scans in one run (no render per page)', () => {
  const runs = planPaperRuns([RECEIPT, { width: 625, height: 1860 }, { width: 615, height: 1850 }], 'Auto', true);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ start: 0, end: 3 });
});

test('planPaperRuns turns A4 / Letter landscape for landscape pages only', () => {
  expect(planPaperRuns([PORTRAIT, LANDSCAPE, RECEIPT], 'A4', true)).toEqual([
    { start: 0, end: 1, paper: PAPER_SIZES_PT.A4 },
    { start: 1, end: 2, paper: A4_LAND },
    { start: 2, end: 3, paper: PAPER_SIZES_PT.A4 },
  ]);
  expect(planPaperRuns([LANDSCAPE, LANDSCAPE], 'Letter', true)).toEqual([
    { start: 0, end: 2, paper: { width: 792, height: 612 } },
  ]);
});

test('planPaperRuns treats unreadable sizes as A4 portrait pages', () => {
  expect(planPaperRuns([null, PORTRAIT, { width: 0, height: 0 }], 'Auto', true)).toEqual([
    { start: 0, end: 3, paper: PAPER_SIZES_PT.A4 },
  ]);
});

describe('generatePdf with mixed page shapes', () => {
  const pages = ['file:///p0.jpg', 'file:///p1.jpg', 'file:///p2.jpg'];
  beforeEach(() => {
    sizesByUri = { 'file:///p0.jpg': PORTRAIT, 'file:///p1.jpg': LANDSCAPE, 'file:///p2.jpg': PORTRAIT };
    let n = 0;
    mockPrint.mockImplementation(() => Promise.resolve({ uri: `file:///Caches/Print/run${n++}.pdf` }));
    native.mergePdfs = jest.fn((_inputs: string[], out: string) => Promise.resolve(out));
  });
  afterEach(() => {
    mockPrint.mockReset();
    mockPrint.mockResolvedValue({ uri: 'file:///output.pdf' });
  });

  test('renders one print job per run and merges them in order', async () => {
    const uri = await generatePdf(pages, { pageSize: 'Auto', searchable: true });
    expect(mockPrint).toHaveBeenCalledTimes(3);
    expect(mockPrint.mock.calls.map(c => [c[0].width, c[0].height])).toEqual([[595, 842], [842, 595], [595, 842]]);
    expect(mockPrint.mock.calls[1][0].html).toContain('@page{size:842pt 595pt;margin:0}');
    // Each run carries only its own pages, with the text layer.
    expect(mockPrint.mock.calls.map(c => c[0].html.match(/class="s"/g).length)).toEqual([1, 1, 1]);
    expect(mockPrint.mock.calls[1][0].html).toContain('Total &lt;due&gt;');
    expect(native.mergePdfs).toHaveBeenCalledWith(
      ['file:///Caches/Print/run0.pdf', 'file:///Caches/Print/run1.pdf', 'file:///Caches/Print/run2.pdf'],
      expect.stringMatching(/^file:\/\/\/Caches\/Print\/merged-[a-z0-9]+\.pdf$/),
    );
    expect(uri).toMatch(/merged-/);
    // The intermediate runs are gone; the result is not.
    for (const r of ['run0', 'run1', 'run2']) {
      expect(FileSystem.deleteAsync).toHaveBeenCalledWith(`file:///Caches/Print/${r}.pdf`, { idempotent: true });
    }
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(uri, expect.anything());
  });

  test('overlays get each page index and its own box size', async () => {
    const overlay = jest.fn(() => '');
    await generatePdf(pages, { pageSize: 'Auto', overlayHtml: overlay });
    const calls = overlay.mock.calls as unknown as [number, { width: number; height: number }][];
    expect(calls.map(c => c[0])).toEqual([0, 1, 2]);
    // The scans are within the A4 snap, so each box nearly fills its own sheet.
    expect(calls.map(([, b]) => [Math.round(b.width), Math.round(b.height)])).toEqual([
      [595, 842],
      [842, 595],
      [595, 842],
    ]);
  });

  test('progress runs once through the pages, then reports rendering once', async () => {
    const onProgress = jest.fn();
    await generatePdf(pages, { pageSize: 'Auto', onProgress });
    expect(onProgress.mock.calls).toEqual([
      [0, 3, 'preparing'],
      [1, 3, 'preparing'],
      [2, 3, 'preparing'],
      [3, 3, 'rendering'],
    ]);
  });

  test('a document of one shape keeps the single render (no merge)', async () => {
    sizesByUri = {};
    await generatePdf(pages, { pageSize: 'Auto' });
    expect(mockPrint).toHaveBeenCalledTimes(1);
    expect(native.mergePdfs).not.toHaveBeenCalled();
  });

  test('A4 setting: the landscape page gets A4 landscape', async () => {
    await generatePdf(pages, { pageSize: 'A4' });
    expect(mockPrint.mock.calls.map(c => [c[0].width, c[0].height])).toEqual([[595, 842], [842, 595], [595, 842]]);
  });

  test('older builds without mergePdfs keep one paper size for everything', async () => {
    delete native.mergePdfs;
    await generatePdf(pages, { pageSize: 'Auto' });
    expect(mockPrint).toHaveBeenCalledTimes(1);
    expect(mockPrint.mock.calls[0][0]).toMatchObject({ width: 595, height: 842 });
    expect(mockPrint.mock.calls[0][0].html.match(/class="s"/g)).toHaveLength(3);
  });

  test('a failed merge falls back to one paper size and cleans up the runs', async () => {
    native.mergePdfs = jest.fn(() => Promise.reject(new Error('ERR_PDF_MERGE')));
    const uri = await generatePdf(pages, { pageSize: 'Auto' });
    expect(mockPrint).toHaveBeenCalledTimes(4);
    expect(mockPrint.mock.calls[3][0].html.match(/class="s"/g)).toHaveLength(3);
    expect(uri).toBe('file:///Caches/Print/run3.pdf');
    for (const r of ['run0', 'run1', 'run2']) {
      expect(FileSystem.deleteAsync).toHaveBeenCalledWith(`file:///Caches/Print/${r}.pdf`, { idempotent: true });
    }
  });

  test('cancelling between runs deletes the finished runs and never merges', async () => {
    const c = new AbortController();
    let n = 0;
    mockPrint.mockImplementation(() => {
      const uri = `file:///Caches/Print/run${n++}.pdf`;
      if (n === 1) setTimeout(() => c.abort(), 0);
      return new Promise(r => setTimeout(() => r({ uri }), 5));
    });
    await expect(generatePdf(pages, { pageSize: 'Auto', signal: c.signal })).rejects.toBeInstanceOf(PdfCancelledError);
    await new Promise(r => setTimeout(r, 20));
    expect(native.mergePdfs).not.toHaveBeenCalled();
    expect(mockPrint).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///Caches/Print/run0.pdf', { idempotent: true });
  });

  test('a render error in a later run deletes the earlier runs', async () => {
    let n = 0;
    mockPrint.mockImplementation(() =>
      n++ === 1 ? Promise.reject(new Error('WebKit died')) : Promise.resolve({ uri: `file:///Caches/Print/run${n - 1}.pdf` }),
    );
    await expect(generatePdf(pages, { pageSize: 'Auto' })).rejects.toMatchObject({ kind: 'render' });
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///Caches/Print/run0.pdf', { idempotent: true });
    expect(native.mergePdfs).not.toHaveBeenCalled();
  });
});

describe('long documents print in bounded runs (r7 #7)', () => {
  const A4 = PAPER_SIZES_PT.A4;
  beforeEach(() => {
    let n = 0;
    mockPrint.mockImplementation(() => Promise.resolve({ uri: `file:///Caches/Print/run${n++}.pdf` }));
    native.mergePdfs = jest.fn((_inputs: string[], out: string) => Promise.resolve(out));
  });
  afterEach(() => {
    mockPrint.mockReset();
    mockPrint.mockResolvedValue({ uri: 'file:///output.pdf' });
  });

  test('splitLongRuns cuts runs into pieces of at most MAX_RUN_PAGES on the same paper', () => {
    const landscape = { width: 842, height: 595 };
    expect(splitLongRuns([{ start: 0, end: 60, paper: A4 }, { start: 60, end: 62, paper: landscape }], 25)).toEqual([
      { start: 0, end: 25, paper: A4 },
      { start: 25, end: 50, paper: A4 },
      { start: 50, end: 60, paper: A4 },
      { start: 60, end: 62, paper: landscape },
    ]);
    expect(splitLongRuns([{ start: 0, end: 25, paper: A4 }], 25)).toHaveLength(1);
    expect(splitLongRuns([])).toEqual([]);
  });

  test('a 200-page document renders 8 jobs of 25 and merges them in order', async () => {
    const pages = Array.from({ length: 200 }, (_, i) => `file:///p${i}.jpg`);
    const uri = await generatePdf(pages, { pageSize: 'A4', quality: 'high' });
    expect(mockPrint).toHaveBeenCalledTimes(8);
    expect(mockPrint.mock.calls.map(c => c[0].html.match(/class="s"/g).length)).toEqual(Array(8).fill(MAX_RUN_PAGES));
    expect(native.mergePdfs).toHaveBeenCalledTimes(1);
    expect(native.mergePdfs!.mock.calls[0][0]).toEqual(Array.from({ length: 8 }, (_, i) => `file:///Caches/Print/run${i}.pdf`));
    expect(uri).toMatch(/merged-/);
  });

  test('each run’s images are read only after the previous run has rendered', async () => {
    imageSize = { width: 1000, height: 1400 }; // under the long-document cap: read as-is
    const order: string[] = [];
    mockReadAs.mockImplementation((u: string) => { order.push('read'); return Promise.resolve(`B64-${u}`); });
    let n = 0;
    mockPrint.mockImplementation(() => { order.push('print'); return Promise.resolve({ uri: `file:///Caches/Print/run${n++}.pdf` }); });
    const pages = Array.from({ length: 60 }, (_, i) => `file:///p${i}.jpg`);
    await generatePdf(pages, { pageSize: 'A4', quality: 'high' });
    // read ×25, print, read ×25, print, read ×10, print — never more than one run of images held.
    let held = 0;
    let most = 0;
    for (const step of order) {
      if (step === 'read') most = Math.max(most, ++held);
      else held = 0;
    }
    expect(most).toBe(MAX_RUN_PAGES);
    expect(order.filter(s => s === 'print')).toHaveLength(3);
    // Each job carries only its own pages' images.
    expect(mockPrint.mock.calls[1][0].html).toContain('B64-file:///p25.jpg');
    expect(mockPrint.mock.calls[1][0].html).not.toContain('B64-file:///p24.jpg');
    mockReadAs.mockReset();
    mockReadAs.mockResolvedValue('FAKEBASE64');
  });

  test('progress still runs once through the pages and reports rendering once', async () => {
    const onProgress = jest.fn();
    const pages = Array.from({ length: 30 }, (_, i) => `file:///p${i}.jpg`);
    await generatePdf(pages, { pageSize: 'A4', onProgress });
    const phases = onProgress.mock.calls.map(c => c[2]);
    expect(phases.filter(p => p === 'rendering')).toHaveLength(1);
    expect(onProgress.mock.calls[onProgress.mock.calls.length - 1]).toEqual([30, 30, 'rendering']);
    expect(onProgress.mock.calls.filter(c => c[2] === 'preparing').map(c => c[0])).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  test('r8 #3: a failed merge of a long document fails cleanly — never one giant render', async () => {
    native.mergePdfs = jest.fn(() => Promise.reject(new Error('ERR_PDF_MERGE')));
    const pages = Array.from({ length: 60 }, (_, i) => `file:///p${i}.jpg`);
    await expect(generatePdf(pages, { pageSize: 'A4' })).rejects.toMatchObject({ kind: 'render' });
    // Only the three bounded runs were printed; no fourth all-pages job.
    expect(mockPrint).toHaveBeenCalledTimes(3);
    expect(Math.max(...mockPrint.mock.calls.map(c => c[0].html.match(/class="s"/g).length))).toBe(MAX_RUN_PAGES);
    for (const r of ['run0', 'run1', 'run2']) {
      expect(FileSystem.deleteAsync).toHaveBeenCalledWith(`file:///Caches/Print/${r}.pdf`, { idempotent: true });
    }
  });

  test('r8 #3: a failed merge of a short mixed document still falls back to one bounded job', async () => {
    native.mergePdfs = jest.fn(() => Promise.reject(new Error('ERR_PDF_MERGE')));
    sizesByUri = Object.fromEntries(
      Array.from({ length: MAX_RUN_PAGES }, (_, i) => [`file:///p${i}.jpg`, i % 2 ? LANDSCAPE : PORTRAIT]),
    );
    const pages = Array.from({ length: MAX_RUN_PAGES }, (_, i) => `file:///p${i}.jpg`);
    const uri = await generatePdf(pages, { pageSize: 'Auto' });
    const last = mockPrint.mock.calls[mockPrint.mock.calls.length - 1][0];
    expect(last.html.match(/class="s"/g)).toHaveLength(MAX_RUN_PAGES);
    expect(uri).toBe(`file:///Caches/Print/run${mockPrint.mock.calls.length - 1}.pdf`);
  });

  test('without the native merge a long document stays one job (older builds)', async () => {
    delete native.mergePdfs;
    const pages = Array.from({ length: 40 }, (_, i) => `file:///p${i}.jpg`);
    await generatePdf(pages, { pageSize: 'A4' });
    expect(mockPrint).toHaveBeenCalledTimes(1);
  });
});

describe('page numbers on export', () => {
  const { pageNumberLabel, pageNumberHtml } = jest.requireActual('../lib/pdf') as typeof import('../lib/pdf');

  test('labels: off, "3", "3 of 12"', () => {
    expect(pageNumberLabel('off', 2, 12)).toBe('');
    expect(pageNumberLabel(undefined, 2, 12)).toBe('');
    expect(pageNumberLabel('number', 2, 12)).toBe('3');
    expect(pageNumberLabel('of-total', 2, 12)).toBe('3 of 12');
    expect(pageNumberHtml('off', 0, 1)).toBe('');
  });

  test('every sheet gets its number, bottom-centre on the paper, with the total across runs', async () => {
    native.mergePdfs = jest.fn().mockResolvedValue('file:///merged.pdf');
    // Portrait, landscape, portrait: three runs, three print jobs.
    sizesByUri = { 'file:///b.jpg': { width: 1600, height: 1200 } };
    await generatePdf(['file:///a.jpg', 'file:///b.jpg', 'file:///c.jpg'], { pageSize: 'A4', pageNumbers: 'of-total' });
    const htmls = mockPrint.mock.calls.map(c => c[0].html as string);
    expect(htmls).toHaveLength(3);
    expect(htmls[0]).toContain('<div class="pn"><span>1 of 3</span></div>');
    expect(htmls[1]).toContain('<div class="pn"><span>2 of 3</span></div>');
    expect(htmls[2]).toContain('<div class="pn"><span>3 of 3</span></div>');
    // On the sheet (outside the image box), sized in PDF points.
    expect(htmls[0]).toMatch(/<\/div><div class="pn">.*<\/div><\/div>/);
    expect(htmls[0]).toMatch(/\.pn\{position:absolute;left:0;right:0;bottom:calc\(14 \* var\(--pt\)\)/);
  });

  test('off by default: no number, and the searchable text layer is unchanged', async () => {
    await generatePdf(['file:///a.jpg'], { searchable: true });
    expect(htmlOf()).not.toContain('class="pn"');
    await generatePdf(['file:///a.jpg'], { searchable: true, pageNumbers: 'number' });
    const numbered = mockPrint.mock.calls[1][0].html as string;
    expect(numbered).toContain('<div class="pn"><span>1</span></div>');
    expect(numbered).toContain('Total &lt;due&gt; &amp; paid');
    expect(numbered).toContain('class="t"');
  });
});
