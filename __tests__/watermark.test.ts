// Watermark type (Single / Tiled), size in points and strength (round 15):
// the geometry the preview and the canvas bake share, the default look being
// exactly the old one, and the remembered choices loading from anything.
const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItem: jest.fn(async (k: string, v: string) => {
    mockStore.set(k, v);
  }),
}));

import {
  STAMP_CANVAS_JS,
  TILE_GAP_EM,
  TILE_ROW_EM,
  TILED_DEFAULT_SIZE_PT,
  WATERMARK_ANGLE,
  WATERMARK_REF_WIDTH_PT,
  WATERMARK_SIZE_RANGE,
  buildStampHtml,
  resolveStamp,
  resolveWatermarkLook,
  watermarkFontFraction,
  watermarkOpacity,
  watermarkTiles,
  type WatermarkStyle,
} from '../lib/stamp';
import {
  DEFAULT_WATERMARK_PREFS,
  loadWatermarkPrefs,
  parseWatermarkPrefs,
  saveWatermarkPrefs,
} from '../lib/watermark-prefs';
import { stepValue } from '../components/value-slider';

const STYLES: WatermarkStyle[] = ['diagonal', 'center', 'footer'];

describe('size and strength', () => {
  test('automatic is exactly the look the tool always had', () => {
    for (const style of STYLES) {
      for (const text of ['DRAFT', 'CONFIDENTIAL', 'CONFIDENTIAL — INTERNAL USE ONLY', 'X']) {
        const look = resolveWatermarkLook(text, { style });
        expect(look).toMatchObject({ layout: 'single', autoSize: true, autoStrength: true });
        expect(look.fontFrac).toBe(watermarkFontFraction(text, style));
        expect(look.opacity).toBe(watermarkOpacity(style));
      }
    }
    // A spec from before the new fields resolves to the old numbers and ink.
    const r = resolveStamp({ kind: 'watermark', text: 'CONFIDENTIAL', style: 'diagonal', color: 'gray' });
    expect(r).toMatchObject({
      layout: 'rotated',
      angle: WATERMARK_ANGLE,
      fontFrac: watermarkFontFraction('CONFIDENTIAL', 'diagonal'),
      ink: 'rgba(112,112,112,0.28)',
    });
    expect(resolveStamp({ kind: 'watermark', text: 'A', style: 'footer', color: 'red' })).toMatchObject({
      layout: 'footer',
      angle: 0,
      ink: 'rgba(200,30,30,0.85)',
    });
  });

  test('the automatic values are shown as whole numbers', () => {
    const look = resolveWatermarkLook('CONFIDENTIAL', { style: 'diagonal' });
    expect(look.sizePt).toBe(Math.round(watermarkFontFraction('CONFIDENTIAL', 'diagonal') * 595));
    expect(look.strength).toBe(28);
    expect(resolveWatermarkLook('X', { style: 'footer' })).toMatchObject({ sizePt: 13, strength: 85 });
    expect(resolveWatermarkLook('X', { style: 'diagonal', layout: 'tiled' })).toMatchObject({
      sizePt: TILED_DEFAULT_SIZE_PT,
      strength: 20,
      autoSize: true,
    });
  });

  test('a size in points is a fraction of an A4-wide page; strength is opacity', () => {
    const look = resolveWatermarkLook('PAID', { style: 'center', sizePt: 119, strength: 45 });
    expect(look.fontFrac).toBeCloseTo(119 / WATERMARK_REF_WIDTH_PT, 10);
    expect(look.opacity).toBe(0.45);
    expect(look).toMatchObject({ sizePt: 119, strength: 45, autoSize: false, autoStrength: false });
    const r = resolveStamp({ kind: 'watermark', text: 'PAID', style: 'center', color: 'blue', sizePt: 119, strength: 45 });
    expect(r).toMatchObject({ layout: 'center', ink: 'rgba(20,80,190,0.45)' });
  });

  test('numbers are clamped to each type’s range, and junk falls back to automatic', () => {
    const { single, tiled } = WATERMARK_SIZE_RANGE;
    expect(resolveWatermarkLook('A', { style: 'diagonal', sizePt: 1 }).sizePt).toBe(single.min);
    expect(resolveWatermarkLook('A', { style: 'diagonal', sizePt: 999 }).sizePt).toBe(single.max);
    expect(resolveWatermarkLook('A', { style: 'diagonal', layout: 'tiled', sizePt: 1 }).sizePt).toBe(tiled.min);
    expect(resolveWatermarkLook('A', { style: 'diagonal', layout: 'tiled', sizePt: 999 }).sizePt).toBe(tiled.max);
    expect(resolveWatermarkLook('A', { style: 'diagonal', strength: 0 }).opacity).toBe(0.1);
    expect(resolveWatermarkLook('A', { style: 'diagonal', strength: 250 }).opacity).toBe(1);
    expect(resolveWatermarkLook('A', { style: 'diagonal', sizePt: NaN, strength: Infinity })).toMatchObject({
      autoSize: true,
      autoStrength: true,
      strength: 28,
    });
  });

  test('tiled resolves to the diagonal angle and the shared spacing', () => {
    const r = resolveStamp({ kind: 'watermark', text: ' COPY ', style: 'footer', color: 'gray', layout: 'tiled', sizePt: 30 });
    expect(r).toMatchObject({ kind: 'watermark', text: 'COPY', layout: 'tiled', angle: WATERMARK_ANGLE, gapEm: TILE_GAP_EM, rowEm: TILE_ROW_EM });
    if (r.kind !== 'watermark') throw new Error();
    expect(r.fontFrac).toBeCloseTo(30 / 595, 10);
  });

  test('the slider steps stay whole and in range', () => {
    expect(stepValue(84, 2, 8, 144)).toBe(86);
    expect(stepValue(143, 2, 8, 144)).toBe(144);
    expect(stepValue(12, -5, 10, 100)).toBe(10);
    expect(stepValue(27.6, 0, 10, 100)).toBe(28);
  });
});

describe('tiled layout', () => {
  const page = { w: 1000, h: 1414 };
  const f = 40;
  const tw = 300;
  const tiles = watermarkTiles(page.w, page.h, f, tw, WATERMARK_ANGLE);

  test('one repeat sits exactly in the middle of the page', () => {
    expect(tiles.some(t => Math.abs(t.x - 500) < 1e-9 && Math.abs(t.y - 707) < 1e-9)).toBe(true);
  });

  test('the whole page is covered: no point is far from a repeat', () => {
    const colPitch = tw + TILE_GAP_EM * f;
    const rowPitch = TILE_ROW_EM * f;
    const maxGap = Math.hypot(colPitch, rowPitch);
    for (let x = 0; x <= page.w; x += 50) {
      for (let y = 0; y <= page.h; y += 50) {
        const nearest = Math.min(...tiles.map(t => Math.hypot(t.x - x, t.y - y)));
        expect(nearest).toBeLessThanOrEqual(maxGap);
      }
    }
  });

  test('every repeat can touch the page (none drawn wholly off it)', () => {
    const reach = Math.hypot(tw, f * 1.2) / 2;
    for (const t of tiles) {
      const dx = Math.max(0, -t.x, t.x - page.w);
      const dy = Math.max(0, -t.y, t.y - page.h);
      expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(reach + 1e-9);
    }
  });

  test('rows are a brick pattern along the text direction', () => {
    const a = (WATERMARK_ANGLE * Math.PI) / 180;
    const colPitch = tw + TILE_GAP_EM * f;
    const rowPitch = TILE_ROW_EM * f;
    // Back in the rotated frame: rows at whole row pitches, odd rows shifted half a step.
    for (const t of tiles) {
      const dx = t.x - 500;
      const dy = t.y - 707;
      const u = dx * Math.cos(a) + dy * Math.sin(a);
      const v = -dx * Math.sin(a) + dy * Math.cos(a);
      const row = Math.round(v / rowPitch);
      expect(v - row * rowPitch).toBeCloseTo(0, 6);
      const shift = Math.abs(row % 2) === 1 ? colPitch / 2 : 0;
      const k = (u - shift) / colPitch;
      expect(k - Math.round(k)).toBeCloseTo(0, 6);
    }
  });

  test('the pattern scales with the page: a bigger page gets the same layout, bigger', () => {
    const big = watermarkTiles(page.w * 3, page.h * 3, f * 3, tw * 3, WATERMARK_ANGLE);
    expect(big.length).toBe(tiles.length);
    big.forEach((t, i) => {
      expect(t.x).toBeCloseTo(tiles[i].x * 3, 6);
      expect(t.y).toBeCloseTo(tiles[i].y * 3, 6);
    });
  });

  test('works for any page shape and stays a sensible number of repeats', () => {
    for (const [w, h] of [[1000, 300], [300, 1600], [1000, 1000]]) {
      const t = watermarkTiles(w, h, (WATERMARK_SIZE_RANGE.tiled.min / 595) * w, w * 0.12, WATERMARK_ANGLE);
      expect(t.length).toBeGreaterThan(0);
      expect(t.length).toBeLessThan(800);
    }
  });

  test('nothing to lay out gives no repeats', () => {
    expect(watermarkTiles(0, 100, 10, 50, -35)).toEqual([]);
    expect(watermarkTiles(100, 100, 0, 50, -35)).toEqual([]);
    expect(watermarkTiles(100, 100, 10, 0, -35)).toEqual([]);
  });

  test('the canvas painter’s copy lays out exactly the same repeats', () => {
    const canvasTiles = new Function(`${STAMP_CANVAS_JS}; return watermarkTiles;`)() as typeof watermarkTiles;
    const cases: [number, number, number, number, number][] = [
      [1000, 1414, 40, 300, -35],
      [3024, 4032, 122, 1650, -35],
      [1214, 700, 31, 99.5, -35],
      [500, 500, 20, 77, 0],
    ];
    for (const [w, h, fs, t, a] of cases) {
      expect(canvasTiles(w, h, fs, t, a, TILE_GAP_EM, TILE_ROW_EM)).toEqual(watermarkTiles(w, h, fs, t, a));
    }
  });

  test('the canvas draws one rotated line of text per repeat', () => {
    const drawStamp = new Function(`${STAMP_CANVAS_JS}; return drawStamp;`)() as (...a: unknown[]) => void;
    const calls = { translate: [] as number[][], rotate: [] as number[], fillText: 0 };
    const ctx = {
      save() {},
      restore() {},
      translate(x: number, y: number) {
        calls.translate.push([x, y]);
      },
      rotate(r: number) {
        calls.rotate.push(r);
      },
      fillText() {
        calls.fillText++;
      },
      measureText: (s: string) => ({ width: s.length * 10 }),
      set font(_: string) {},
      set fillStyle(_: string) {},
      set textBaseline(_: string) {},
    };
    const spec = resolveStamp({ kind: 'watermark', text: 'COPY', style: 'diagonal', color: 'gray', layout: 'tiled', sizePt: 24 });
    drawStamp(ctx, 1000, 1414, spec, null);
    if (spec.kind !== 'watermark') throw new Error();
    const fpx = spec.fontFrac * 1000;
    const tw = 4 * (10 + 0.04 * fpx);
    const expected = watermarkTiles(1000, 1414, fpx, tw, WATERMARK_ANGLE);
    expect(calls.translate).toEqual(expected.map(t => [t.x, t.y]));
    expect(calls.rotate.every(r => r === (WATERMARK_ANGLE * Math.PI) / 180)).toBe(true);
    expect(calls.fillText).toBe(expected.length * 4);
  });

  test('the stamp page carries the tiled spec to the canvas', () => {
    const html = buildStampHtml('file:///p.jpg', null, { kind: 'watermark', text: 'COPY', style: 'diagonal', color: 'red', layout: 'tiled', strength: 30 });
    expect(html).toContain('"layout":"tiled"');
    expect(html).toContain('rgba(200,30,30,0.3)');
  });
});

describe('remembered choices', () => {
  beforeEach(() => mockStore.clear());

  test('nothing stored, or something unreadable, gives the old defaults', () => {
    expect(parseWatermarkPrefs(null)).toEqual(DEFAULT_WATERMARK_PREFS);
    expect(parseWatermarkPrefs('not json')).toEqual(DEFAULT_WATERMARK_PREFS);
    expect(parseWatermarkPrefs('[1,2]')).toEqual(DEFAULT_WATERMARK_PREFS);
    expect(parseWatermarkPrefs('"text"')).toEqual(DEFAULT_WATERMARK_PREFS);
  });

  test('loads field by field: partial, older or newer values keep what is valid', () => {
    expect(parseWatermarkPrefs(JSON.stringify({ style: 'footer', color: 'red' }))).toEqual({
      ...DEFAULT_WATERMARK_PREFS,
      style: 'footer',
      color: 'red',
    });
    const p = parseWatermarkPrefs(
      JSON.stringify({
        text: '  PAID  ',
        layout: 'mosaic',
        style: 'wavy',
        color: 'chartreuse',
        size: { single: 999, tiled: '20', extra: 5 },
        strength: { single: 3, tiled: 55.4 },
        futureField: { a: 1 },
      }),
    );
    expect(p).toEqual({
      text: 'PAID',
      layout: 'single',
      style: 'diagonal',
      color: 'gray',
      customColor: null,
      bold: true,
      size: { single: WATERMARK_SIZE_RANGE.single.max, tiled: null },
      strength: { single: 10, tiled: 55 },
    });
    expect(parseWatermarkPrefs(JSON.stringify({ text: '   ' })).text).toBe('CONFIDENTIAL');
    expect(parseWatermarkPrefs(JSON.stringify({ text: 'X'.repeat(80) })).text).toHaveLength(40);
  });

  test('saved and loaded again unchanged; storage failures never throw', async () => {
    expect(await loadWatermarkPrefs()).toEqual(DEFAULT_WATERMARK_PREFS);
    const prefs = {
      text: 'COPY',
      layout: 'tiled' as const,
      style: 'center' as const,
      color: 'blue' as const,
      customColor: null,
      bold: true,
      size: { single: 60, tiled: 18 },
      strength: { single: null, tiled: 35 },
    };
    await saveWatermarkPrefs(prefs);
    expect(await loadWatermarkPrefs()).toEqual(prefs);
    const AS = jest.requireMock('@react-native-async-storage/async-storage');
    AS.getItem.mockRejectedValueOnce(new Error('disk'));
    expect(await loadWatermarkPrefs()).toEqual(DEFAULT_WATERMARK_PREFS);
    AS.setItem.mockRejectedValueOnce(new Error('disk'));
    await expect(saveWatermarkPrefs(prefs)).resolves.toBeUndefined();
  });
});
