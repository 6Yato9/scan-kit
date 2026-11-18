// __tests__/tools.test.ts
// Pure logic behind the Tools tab screens: stamp overlays, long-image sizing,
// compression sizing and book-spread splitting.
jest.mock('expo-file-system/legacy', () => ({
  readAsStringAsync: jest.fn(),
  deleteAsync: jest.fn(),
}));
jest.mock('expo-print', () => ({ printToFileAsync: jest.fn() }));
jest.mock('expo-image-manipulator', () => ({ manipulateAsync: jest.fn(), SaveFormat: { JPEG: 'jpeg' } }));
jest.mock('../lib/ocr', () => ({ recognizeLines: jest.fn() }));

import {
  clampPlacement,
  defaultPlacement,
  formatStamp,
  signatureHeightFraction,
  signatureOverlay,
  timestampOverlay,
  watermarkFontFraction,
  watermarkOverlay,
} from '../lib/stamp';
import { CANVAS_MAX_SIDE, CANVAS_PIXEL_BUDGET, MAX_OUTPUT_WIDTH, planLongImage } from '../lib/long-image';
import { spreadHalves } from '../lib/book-split';

// lib/compress imports expo-file-system's File; resizeFor itself is pure.
jest.mock('expo-file-system', () => ({ File: class {}, Directory: class {}, Paths: { document: 'file:///d' } }));
jest.mock('../lib/storage', () => ({ patchDocument: jest.fn() }));
import { resizeFor } from '../lib/compress';

describe('watermark overlay', () => {
  test('escapes user text so markup cannot break the page', () => {
    const html = watermarkOverlay('<b>"A&B"</b>', 'diagonal', 'gray', 595);
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;');
  });

  test('long text gets a smaller font than short text, within bounds', () => {
    const short = watermarkFontFraction('DRAFT', 'diagonal');
    const long = watermarkFontFraction('CONFIDENTIAL — INTERNAL USE ONLY', 'diagonal');
    expect(long).toBeLessThan(short);
    expect(short).toBeLessThanOrEqual(0.16);
    expect(long).toBeGreaterThanOrEqual(0.03);
  });

  test('sizes are expressed in PDF points via --pt', () => {
    expect(watermarkOverlay('X', 'footer', 'red', 500)).toMatch(/calc\(11\.00 \* var\(--pt\)\)/);
  });
});

describe('timestamp overlay', () => {
  test('anchors to the chosen corner and escapes the text', () => {
    const html = timestampOverlay('<now>', 'top-left', 600);
    expect(html).toMatch(/top:calc\(/);
    expect(html).toMatch(/left:3\.00%/);
    expect(html).toContain('&lt;now&gt;');
  });

  test('formats date and date-time', () => {
    const ts = new Date(2026, 10, 17, 14, 5).getTime();
    expect(formatStamp(ts, 'date', 'en-US')).toBe('Nov 17, 2026');
    expect(formatStamp(ts, 'datetime', 'en-US')).toMatch(/^Nov 17, 2026, 2:05\s?PM$/);
  });
});

describe('signature placement', () => {
  const sig = { dataUri: 'data:image/png;base64,AAAA', width: 400, height: 100 };

  test('height fraction accounts for page aspect', () => {
    // 0.4 page widths wide, 4:1 signature -> 0.1 page widths tall; page is 1.5 widths tall.
    expect(signatureHeightFraction(sig, { x: 0, y: 0, w: 0.4 }, 1.5)).toBeCloseTo(0.1 / 1.5);
  });

  test('default placement sits bottom right, on the page', () => {
    const p = defaultPlacement(sig, Math.SQRT2);
    expect(p.x + p.w).toBeLessThanOrEqual(1);
    expect(p.x).toBeGreaterThan(0.5);
    expect(p.y + signatureHeightFraction(sig, p, Math.SQRT2)).toBeLessThanOrEqual(1);
    expect(p.y).toBeGreaterThan(0.8);
  });

  test('clamps a placement dragged off the page', () => {
    const p = clampPlacement(sig, { x: 0.9, y: 1.2, w: 0.3 }, Math.SQRT2);
    expect(p.x).toBeCloseTo(0.7);
    expect(p.y + signatureHeightFraction(sig, p, Math.SQRT2)).toBeCloseTo(1);
    expect(clampPlacement(sig, { x: -1, y: -1, w: 0.3 }, 1.4)).toMatchObject({ x: 0, y: 0 });
  });

  test('only embeds real PNG data URIs', () => {
    expect(signatureOverlay(sig, { x: 0.1, y: 0.2, w: 0.3 })).toContain('left:10.000%');
    expect(signatureOverlay({ ...sig, dataUri: 'javascript:alert(1)' }, { x: 0, y: 0, w: 0.3 })).toBe('');
    expect(signatureOverlay({ ...sig, dataUri: 'data:image/png;base64,A" onerror="x' }, { x: 0, y: 0, w: 0.3 })).toBe('');
  });
});

describe('long image plan', () => {
  test('keeps a few pages at up to the output width', () => {
    const plan = planLongImage([{ width: 1200, height: 1700 }, { width: 1200, height: 1700 }]);
    expect(plan.width).toBe(1200);
    expect(plan.totalHeight).toBe(plan.heights[0] * 2);
  });

  test('caps the width of large scans', () => {
    expect(planLongImage([{ width: 3000, height: 4000 }]).width).toBe(MAX_OUTPUT_WIDTH);
  });

  test('stays under the WebKit canvas limits for many full-size pages', () => {
    const plan = planLongImage(Array.from({ length: 30 }, () => ({ width: 2480, height: 3508 })));
    expect(plan.width * plan.totalHeight).toBeLessThanOrEqual(CANVAS_PIXEL_BUDGET * 1.01);
    expect(plan.totalHeight).toBeLessThanOrEqual(CANVAS_MAX_SIDE + 30);
    expect(plan.heights).toHaveLength(30);
  });

  test('unknown sizes fall back to A4 portrait', () => {
    const plan = planLongImage([{ width: 0, height: 0 }]);
    expect(plan.heights[0] / plan.width).toBeCloseTo(Math.SQRT2, 2);
  });
});

describe('compress sizing', () => {
  test('resizes only when the long edge is over the limit', () => {
    expect(resizeFor(1000, 1400, 2200)).toEqual([]);
    expect(resizeFor(3000, 4000, 2200)).toEqual([{ resize: { height: 2200 } }]);
    expect(resizeFor(4000, 3000, 2200)).toEqual([{ resize: { width: 2200 } }]);
    expect(resizeFor(0, 0, 2200)).toEqual([]);
  });
});

describe('book spread split', () => {
  test('halves cover the whole image without overlap, odd widths included', () => {
    const [l, r] = spreadHalves(1001, 700);
    expect(l).toEqual({ originX: 0, originY: 0, width: 500, height: 700 });
    expect(r).toEqual({ originX: 500, originY: 0, width: 501, height: 700 });
  });
});
