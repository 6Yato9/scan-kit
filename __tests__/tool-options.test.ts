// Round 16 tool options: the pure helpers behind them (page ranges, Compress
// sizes, Long image layout, Extract text formatting, Erase marks strength,
// Book reading order, ID card size) and the remembered-choice parsers, whose
// defaults must be exactly the tools as they were.
jest.mock('expo-file-system/legacy', () => ({ readAsStringAsync: jest.fn(), deleteAsync: jest.fn() }));
jest.mock('expo-print', () => ({ printToFileAsync: jest.fn() }));
jest.mock('expo-image-manipulator', () => ({ manipulateAsync: jest.fn(), SaveFormat: { JPEG: 'jpeg' } }));
jest.mock('../lib/ocr', () => ({ recognizeLines: jest.fn() }));
jest.mock('../modules/vision-ocr/src', () => ({ VisionOcr: {} }));
const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItem: jest.fn(async (k: string, v: string) => { mockStore.set(k, v); }),
}));
import {
  chunkPages,
  describeParts,
  oddEvenPages,
  pagesInRanges,
  parsePageRanges,
  parseSplitPrefs,
  rangeLabel,
  selectionLabel,
} from '../lib/page-ranges';
import {
  DEFAULT_COMPRESS_PDF,
  estimateFor,
  parseCompressPdfPrefs,
  pdfOptionsFor,
  SMALLEST_EDGE,
  targetVerdict,
} from '../lib/compress-pdf';
import { estimatePdfBytes, MIN_CUSTOM_EDGE, roundUpEstimate } from '../lib/pdf';
import { DEFAULT_LONG_IMAGE, MAX_OUTPUT_WIDTH, parseLongImageOptions, planLongImage, CANVAS_PIXEL_BUDGET, buildLongImageHtml } from '../lib/long-image';
import { formatRecognized, joinParagraphs, paragraphText, parseExtractTextPrefs, textFileName } from '../lib/text-format';
import { eraseAdjustment, parseEraseStrength } from '../lib/erase-strength';
import { orderSpread, parseBookPrefs } from '../lib/book-split';
import { cardWidthMm, ID_CARD_SCALES, maxCardScale, planIdCardSheet } from '../lib/id-card-sheet';
import { jsonObject, numberIn, readToolPrefs, writeToolPrefs } from '../lib/tool-prefs';

describe('page ranges', () => {
  test('numbers, ranges, open ends and dashes', () => {
    expect(parsePageRanges('1-3, 5', 6)).toEqual({ ok: true, ranges: [[0, 1, 2], [4]] });
    expect(parsePageRanges(' 2 – 3 ; 6- ', 6)).toEqual({ ok: true, ranges: [[1, 2], [5]] });
    expect(parsePageRanges('4-end,1to2', 5)).toEqual({ ok: true, ranges: [[3, 4], [0, 1]] });
  });

  test('says what is wrong, in words', () => {
    expect(parsePageRanges('', 4)).toMatchObject({ ok: false });
    expect(parsePageRanges('1-9', 4)).toEqual({ ok: false, error: 'There’s no page 9: this document has 4 pages.' });
    expect(parsePageRanges('0', 4)).toMatchObject({ ok: false, error: expect.stringContaining('no page 0') });
    expect(parsePageRanges('3-1', 4)).toEqual({ ok: false, error: '3–1 runs backwards. Write it as 1–3.' });
    expect(parsePageRanges('a-b', 4)).toMatchObject({ ok: false, error: expect.stringContaining('isn’t a page') });
  });

  test('selections, chunks, odd and even, labels', () => {
    expect(pagesInRanges([[2, 3], [0], [3]])).toEqual([0, 2, 3]);
    expect(chunkPages(7, 3)).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
    expect(chunkPages(4, 1)).toEqual([[0], [1], [2], [3]]);
    expect(oddEvenPages(5, 'odd')).toEqual([0, 2, 4]);
    expect(oddEvenPages(5, 'even')).toEqual([1, 3]);
    expect(rangeLabel([0, 1, 2, 4, 6, 7])).toBe('1–3, 5, 7–8');
    expect(selectionLabel(new Set([3, 0, 1]))).toBe('1–2, 4');
    expect(describeParts([[0, 1, 2], [3, 4, 5]])).toBe('2 documents: pages 1–3, 4–6');
    expect(describeParts([[0]])).toBe('1 document: page 1');
    expect(describeParts(chunkPages(16, 2))).toBe('8 documents: pages 1–2, 3–4, 5–6, 7–8, 9–10, 11–12, and 2 more');
  });

  test('split prefs default to the classic split in two', () => {
    expect(parseSplitPrefs({})).toEqual({ mode: 'at', every: 1 });
    expect(parseSplitPrefs({ mode: 'every', every: 3.4 })).toEqual({ mode: 'every', every: 3 });
    expect(parseSplitPrefs({ mode: 'odd', every: -2 })).toEqual({ mode: 'at', every: 1 });
  });
});

describe('Compress › Smaller PDF sizes', () => {
  const pages = Array.from({ length: 6 }, () => ({ bytes: 700_000, width: 2400, height: 3200 }));

  test('the default is exactly what Compress always made (the small preset, searchable)', () => {
    expect(DEFAULT_COMPRESS_PDF).toEqual({ sizing: { kind: 'preset', preset: 'small' }, searchable: true, level: 'balanced' });
    expect(pdfOptionsFor(DEFAULT_COMPRESS_PDF.sizing, pages, true)).toEqual({ quality: 'small', fits: true });
    expect(estimateFor(DEFAULT_COMPRESS_PDF.sizing, pages, true)).toBe(estimatePdfBytes(pages, 'small', true));
  });

  test('presets grow in size; Smallest is its own size', () => {
    const sizes = (['smallest', 'small', 'medium', 'large'] as const).map(p => estimateFor({ kind: 'preset', preset: p }, pages, false));
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
    expect(pdfOptionsFor({ kind: 'preset', preset: 'smallest' }, pages, false).maxEdge).toBe(SMALLEST_EDGE);
  });

  test('a target picks a size that fits, or says it may not', () => {
    const MB = 1024 * 1024;
    const o = pdfOptionsFor({ kind: 'target', mb: 1 }, pages, false);
    expect(o.fits).toBe(true);
    expect(roundUpEstimate(estimatePdfBytes(pages, 'standard', false, o.maxEdge))).toBeLessThanOrEqual(MB);
    const many = Array.from({ length: 200 }, () => ({ bytes: 900_000, width: 2400, height: 3200 }));
    expect(pdfOptionsFor({ kind: 'target', mb: 1 }, many, false)).toEqual({ quality: 'standard', maxEdge: MIN_CUSTOM_EDGE, fits: false });
    expect(targetVerdict(900_000, 1)).toEqual({ ok: true, text: 'Under the 1 MB limit' });
    expect(targetVerdict(1.2 * MB, 1).ok).toBe(false);
  });

  test('remembered choices are validated', () => {
    expect(parseCompressPdfPrefs({})).toEqual(DEFAULT_COMPRESS_PDF);
    expect(parseCompressPdfPrefs({ sizing: { kind: 'target', mb: 2 }, searchable: false, level: 'sharp' })).toEqual({
      sizing: { kind: 'target', mb: 2 },
      searchable: false,
      level: 'sharp',
    });
    expect(parseCompressPdfPrefs({ sizing: { kind: 'target', mb: 3 } }).sizing).toEqual(DEFAULT_COMPRESS_PDF.sizing);
    expect(parseCompressPdfPrefs({ sizing: { kind: 'custom', edge: 5000 } }).sizing).toEqual({ kind: 'custom', edge: 2400 });
    expect(parseCompressPdfPrefs({ sizing: { kind: 'preset', preset: 'huge' }, level: 'x' })).toEqual(DEFAULT_COMPRESS_PDF);
  });
});

describe('Long image options', () => {
  const sizes = [{ width: 1200, height: 1600 }, { width: 1200, height: 1600 }, { width: 1200, height: 800 }];

  test('defaults lay the pages out as before: edge to edge, white, 0.85', () => {
    const plan = planLongImage(sizes, DEFAULT_LONG_IMAGE);
    expect(plan).toMatchObject({ width: 1200, canvasWidth: 1200, gap: 0, margin: 0, tops: [0, 1600, 3200], totalHeight: 4000 });
    const html = buildLongImageHtml(['file:///a.jpg'], plan);
    expect(html).toContain('var BG = "#ffffff"');
    expect(html).toContain('var Q = 0.85');
  });

  test('spacing and margin are shares of the page width, and every page sits where planned', () => {
    const plan = planLongImage(sizes, { gap: 'large', margin: 'small' });
    expect(plan.gap).toBe(Math.round(plan.width * 0.06));
    expect(plan.margin).toBe(Math.round(plan.width * 0.02));
    expect(plan.canvasWidth).toBe(plan.width + 2 * plan.margin);
    expect(plan.tops[1]).toBe(plan.tops[0] + plan.heights[0] + plan.gap);
    expect(plan.totalHeight).toBe(plan.tops[2] + plan.heights[2] + plan.margin);
  });

  test('still within the canvas budget with margins; width choices cap the pages', () => {
    const many = Array.from({ length: 30 }, () => ({ width: 2480, height: 3508 }));
    const plan = planLongImage(many, { gap: 'large', margin: 'large', maxWidth: 2400 });
    expect(plan.canvasWidth * plan.totalHeight).toBeLessThanOrEqual(CANVAS_PIXEL_BUDGET * 1.01);
    expect(planLongImage([{ width: 3000, height: 4000 }], { maxWidth: 1080 }).width).toBe(1080);
    expect(planLongImage([{ width: 3000, height: 4000 }], { maxWidth: 2400 }).width).toBe(2400);
    expect(planLongImage([{ width: 3000, height: 4000 }]).width).toBe(MAX_OUTPUT_WIDTH);
  });

  test('a stored value is validated; the look is escaped into the page', () => {
    expect(parseLongImageOptions(null)).toEqual(DEFAULT_LONG_IMAGE);
    expect(parseLongImageOptions('{"gap":"small","maxWidth":999,"background":"black"}')).toEqual({
      ...DEFAULT_LONG_IMAGE,
      gap: 'small',
      background: 'black',
    });
    expect(buildLongImageHtml([], planLongImage(sizes), { background: 'red;alert(1)', quality: 5 })).toContain('var BG = "#ffffff"');
  });
});

describe('Extract text formatting', () => {
  test('joins each paragraph, mends hyphenated words, keeps real hyphens', () => {
    expect(joinParagraphs('Your lease for Flat 3B\nexpires on 31 Dec-\nember.\n\nKind regards,\nJean-\nPierre')).toBe(
      'Your lease for Flat 3B expires on 31 December.\n\nKind regards, Jean-Pierre',
    );
    expect(formatRecognized('a\nb', 'keep')).toBe('a\nb');
    expect(formatRecognized('a\nb', 'join')).toBe('a b');
  });

  test('finds paragraph breaks from the spacing between lines', () => {
    const line = (text: string, top: number) => ({ text, top, height: 20 });
    expect(paragraphText([line('Title', 0), line('Dear tenant,', 50), line('Your lease', 100), line('expires.', 124)])).toBe(
      'Title\n\nDear tenant,\n\nYour lease\nexpires.',
    );
    expect(paragraphText([])).toBe('');
  });

  test('prefs and the .txt name', () => {
    expect(parseExtractTextPrefs({})).toEqual({ lineBreaks: 'keep', shareAs: 'text' });
    expect(parseExtractTextPrefs({ lineBreaks: 'join', shareAs: 'file' })).toEqual({ lineBreaks: 'join', shareAs: 'file' });
    expect(textFileName('\n Lease: Renewal / Notice.\nDear tenant')).toBe('Lease Renewal Notice.txt');
    expect(textFileName('   ')).toBe('Recognized text.txt');
  });
});

describe('Erase marks, Book mode, ID card', () => {
  test('erase strength: Standard is the old +30 / +30; the others differ', () => {
    expect(parseEraseStrength({})).toBe('standard');
    expect(eraseAdjustment('standard')).toEqual({ brightness: 30, contrast: 30, saturation: 0 });
    expect(eraseAdjustment('light').brightness).toBeLessThan(30);
    expect(eraseAdjustment('strong').brightness).toBeGreaterThan(30);
  });

  test('reading order flips each spread only for right-to-left books', () => {
    expect(orderSpread(['L', 'R'], 'ltr')).toEqual(['L', 'R']);
    expect(orderSpread(['L', 'R'], 'rtl')).toEqual(['R', 'L']);
    expect(orderSpread(['P'], 'rtl')).toEqual(['P']);
    expect(parseBookPrefs({ order: 'rtl' })).toEqual({ order: 'rtl' });
    expect(parseBookPrefs({ order: 'up' })).toEqual({ order: 'ltr' });
  });

  test('ID card: real size by default, enlarged within its half sheet', () => {
    const sides = [{ width: 1700, height: 1072 }, { width: 1700, height: 1072 }];
    expect(planIdCardSheet(sides, 'A4')).toEqual(planIdCardSheet(sides, 'A4', undefined, 1));
    const big = planIdCardSheet(sides, 'A4', undefined, ID_CARD_SCALES.large);
    expect(cardWidthMm(big)).toBeCloseTo(85.6 * 1.5, 0);
    for (const c of big.cards) {
      expect(c.x).toBeGreaterThan(0);
      expect(c.x + c.width).toBeLessThan(big.width);
    }
    expect(big.cards[0].y + big.cards[0].height).toBeLessThanOrEqual(big.height / 2);
    expect(big.cards[1].y).toBeGreaterThanOrEqual(big.height / 2);
    expect(maxCardScale('Letter')).toBeGreaterThan(1.5);
  });
});

describe('tool prefs storage', () => {
  test('round trip, and anything damaged reads as the defaults', async () => {
    const parse = (o: Record<string, unknown>) => ({ n: numberIn(o.n, 1, 9, 5) });
    expect(await readToolPrefs('@k', parse)).toEqual({ n: 5 });
    await writeToolPrefs('@k', { n: 7 });
    expect(await readToolPrefs('@k', parse)).toEqual({ n: 7 });
    mockStore.set('@k', '{oops');
    expect(await readToolPrefs('@k', parse)).toEqual({ n: 5 });
    expect(jsonObject('[1]')).toEqual({});
    expect(numberIn('3', 1, 9, 5)).toBe(5);
  });
});
