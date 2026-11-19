// Round 16 PDF options (lib/pdf.ts): margins, orientation, page-number
// position, custom image size and the size target — and that the defaults
// lay pages out exactly as before.
jest.mock('expo-file-system/legacy', () => ({ readAsStringAsync: jest.fn(), deleteAsync: jest.fn() }));
jest.mock('expo-print', () => ({ printToFileAsync: jest.fn() }));
jest.mock('expo-image-manipulator', () => ({ manipulateAsync: jest.fn(), SaveFormat: { JPEG: 'jpeg' } }));
jest.mock('../lib/ocr', () => ({ recognizeLines: jest.fn() }));
jest.mock('../modules/vision-ocr/src', () => ({ VisionOcr: {} }));
import {
  buildSheet,
  estimatePdfBytes,
  fitContain,
  fitWithMargin,
  marginOn,
  maxEdgeForTarget,
  MAX_CUSTOM_EDGE,
  MIN_CUSTOM_EDGE,
  pageNumberHtml,
  paperLabel,
  PAPER_SIZES_PT,
  planPaperRuns,
  roundUpEstimate,
  type PreparedPage,
} from '../lib/pdf';

const A4 = PAPER_SIZES_PT.A4;
const PORTRAIT = { width: 1200, height: 1600 };
const LANDSCAPE = { width: 1600, height: 1200 };
const page: PreparedPage = { img: { b64: 'X', mime: 'image/jpeg', ...PORTRAIT }, ocr: null };

describe('margins', () => {
  test('no margin is exactly fitContain', () => {
    expect(fitWithMargin(PORTRAIT, A4, 0)).toEqual(fitContain(PORTRAIT, A4));
    expect(marginOn(A4, 'none')).toBe(0);
    expect(marginOn(A4, undefined)).toBe(0);
  });

  test('a margin keeps the image inside the inset area, centred', () => {
    const m = 36;
    const box = fitWithMargin(PORTRAIT, A4, m);
    const left = box.left * A4.width;
    const top = box.top * A4.height;
    const right = (box.left + box.width) * A4.width;
    const bottom = (box.top + box.height) * A4.height;
    expect(left).toBeGreaterThanOrEqual(m - 1e-6);
    expect(top).toBeGreaterThanOrEqual(m - 1e-6);
    expect(right).toBeLessThanOrEqual(A4.width - m + 1e-6);
    expect(bottom).toBeLessThanOrEqual(A4.height - m + 1e-6);
    // Centred both ways, aspect kept.
    expect(left).toBeCloseTo(A4.width - right, 6);
    expect(top).toBeCloseTo(A4.height - bottom, 6);
    expect((box.width * A4.width) / (box.height * A4.height)).toBeCloseTo(PORTRAIT.width / PORTRAIT.height, 6);
  });

  test('a margin is capped on narrow paper', () => {
    const receipt = { width: 281, height: 842 };
    expect(marginOn(receipt, 'wide')).toBeCloseTo(281 * 0.15, 6);
    expect(marginOn(A4, 'wide')).toBe(72);
  });

  test('the sheet with no margin is the markup it always was', () => {
    const before = buildSheet(page, 0, A4, undefined, { style: 'of-total', total: 3 });
    expect(buildSheet(page, 0, A4, undefined, { style: 'of-total', total: 3, position: 'bottom-center' }, 'none')).toBe(before);
    expect(before).toContain('<div class="pn"><span>1 of 3</span></div>');
  });
});

describe('page number position', () => {
  test('bottom centre is unchanged; right-hand positions inset by the margin', () => {
    expect(pageNumberHtml('number', 1, 5)).toBe('<div class="pn"><span>2</span></div>');
    expect(pageNumberHtml('number', 1, 5, 'bottom-right')).toContain('text-align:right;padding-right:calc(22 * var(--pt))');
    expect(pageNumberHtml('number', 1, 5, 'bottom-right', 36)).toContain('padding-right:calc(36 * var(--pt))');
    const top = pageNumberHtml('of-total', 0, 2, 'top-right');
    expect(top).toContain('bottom:auto;top:calc(14 * var(--pt))');
    expect(top).toContain('1 of 2');
    expect(pageNumberHtml('off', 0, 2, 'top-right')).toBe('');
  });
});

describe('orientation and paper', () => {
  test('auto keeps the per-page plan; forced orientation puts every page on one paper', () => {
    const sizes = [PORTRAIT, LANDSCAPE, PORTRAIT];
    expect(planPaperRuns(sizes, 'A4', true, 'auto')).toEqual(planPaperRuns(sizes, 'A4', true));
    expect(planPaperRuns(sizes, 'A4', true, 'landscape')).toEqual([{ start: 0, end: 3, paper: { width: 842, height: 595 } }]);
    expect(planPaperRuns(sizes, 'Letter', false, 'portrait')).toEqual([{ start: 0, end: 3, paper: PAPER_SIZES_PT.Letter }]);
    // Auto paper ignores orientation (it is shaped like the scan).
    expect(planPaperRuns(sizes, 'Auto', true, 'landscape')).toEqual(planPaperRuns(sizes, 'Auto', true));
  });

  test('US Legal', () => {
    expect(PAPER_SIZES_PT.Legal).toEqual({ width: 612, height: 1008 });
    expect(paperLabel('Legal')).toBe('US Legal');
    expect(planPaperRuns([LANDSCAPE], 'Legal', true)).toEqual([{ start: 0, end: 1, paper: { width: 1008, height: 612 } }]);
  });
});

describe('custom image size and size targets', () => {
  const pages = Array.from({ length: 4 }, () => ({ bytes: 900_000, width: 2400, height: 3200 }));

  test('a custom edge estimates like the preset with that edge', () => {
    expect(estimatePdfBytes(pages, 'standard', false, 1800)).toBe(estimatePdfBytes(pages, 'standard', false));
    expect(estimatePdfBytes(pages, 'standard', false, 1000)).toBeLessThan(estimatePdfBytes(pages, 'small', false));
  });

  test('the target picks the largest size whose shown estimate fits', () => {
    const MB = 1024 * 1024;
    const edge = maxEdgeForTarget(pages, 1 * MB)!;
    expect(edge % 50).toBe(0);
    expect(edge).toBeGreaterThanOrEqual(MIN_CUSTOM_EDGE);
    expect(roundUpEstimate(estimatePdfBytes(pages, 'standard', false, edge))).toBeLessThanOrEqual(MB);
    expect(roundUpEstimate(estimatePdfBytes(pages, 'standard', false, edge + 50))).toBeGreaterThan(MB);
    // Generous target: the largest custom size. Impossible target: null.
    expect(maxEdgeForTarget(pages, 100 * MB)).toBe(MAX_CUSTOM_EDGE);
    expect(maxEdgeForTarget(pages, 10 * 1024)).toBeNull();
  });
});
