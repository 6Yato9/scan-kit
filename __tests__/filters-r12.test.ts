import { combinedFilterRN, isNeutralAdjustment, NO_COLOR_FILTERS } from '../lib/filters';
import { PIXEL_KERNELS_JS } from '../lib/pixel-kernels';
import { buildPreviewHtml } from '../lib/bake-html';
import type { PageFilter } from '../types/document';

// The R12 filters (No shadow, Photo, Faint text, Whiteboard, Ink saver) and
// the Sharpness slider, run on synthetic pages through the exact kernel source
// WebKit evaluates.

type Op = Record<string, number>;
type RGB = [number, number, number];
const kernels = new Function(`${PIXEL_KERNELS_JS}; return { applyOps: applyOps, sharpen: sharpen };`)() as {
  applyOps: (d: Uint8ClampedArray, w: number, h: number, ops: Op[]) => void;
  sharpen: (d: Uint8ClampedArray, w: number, h: number, amt: number) => void;
};
const { applyOps } = kernels;

const W = 240, H = 320;

/**
 * Cream paper lit from the left, the right side in shadow (down to `shadow`),
 * dark text lines in the top half, and whatever `paint` adds.
 */
function makePage(opts: { paper?: RGB; shadow?: number; noise?: number; paint?: (x: number, y: number) => RGB | null } = {}) {
  const paper = opts.paper ?? [236, 228, 208];
  const shadow = opts.shadow ?? 0.45;
  const d = new Uint8ClampedArray(W * H * 4);
  let seed = 4242;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const isText = (x: number, y: number) =>
    x > 24 && x < 216 && y % 24 >= 8 && y % 24 < 12 && (x % 9) < 6 && y > 32 && y < 150;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const light = 1 - (1 - shadow) * Math.min(1, Math.max(0, (x / W - 0.3) / 0.6));
      const base = opts.paint?.(x, y) ?? (isText(x, y) ? [30, 30, 34] : paper);
      const n = (opts.noise ?? 0) * rnd();
      const i = (y * W + x) * 4;
      d[i] = base[0] * light + n; d[i + 1] = base[1] * light + n; d[i + 2] = base[2] * light + n; d[i + 3] = 255;
    }
  }
  return { d, isText };
}

const at = (d: Uint8ClampedArray, x: number, y: number): RGB => {
  const i = (y * W + x) * 4;
  return [d[i], d[i + 1], d[i + 2]];
};
const lum = ([r, g, b]: RGB) => 0.299 * r + 0.587 * g + 0.114 * b;
const chroma = ([r, g, b]: RGB) => Math.max(r, g, b) - Math.min(r, g, b);
const mean = (d: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number) => {
  let s = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += lum(at(d, x, y)); n++; }
  return s / n;
};
const run = (d: Uint8ClampedArray, ops: Op[]) => { applyOps(d, W, H, ops); return d; };
const isGray = (d: Uint8ClampedArray) => {
  for (let i = 0; i < d.length; i += 4) if (d[i] !== d[i + 1] || d[i + 1] !== d[i + 2]) return false;
  return true;
};

const PAPER_LIT: [number, number] = [30, 250];
const PAPER_SHADOW: [number, number] = [225, 250];

/** A red stamp ring and a blue signature line in the lower half. */
const colourPaint = (x: number, y: number): RGB | null => {
  const r = Math.hypot(x - 170, y - 240);
  if (r > 20 && r < 27) return [195, 45, 50];
  if (y >= 280 && y < 283 && x > 30 && x < 120) return [35, 55, 160];
  return null;
};
const STAMP: [number, number] = [170 + 23, 240];
const SIGN: [number, number] = [60, 281];

describe('No shadow', () => {
  test('flattens the shadow and the paper tint to white', () => {
    const d = run(makePage().d, [{ noshadow: 1 }]);
    for (const p of [PAPER_LIT, PAPER_SHADOW]) {
      const c = at(d, ...p);
      expect(Math.min(...c)).toBeGreaterThanOrEqual(245);
      expect(chroma(c)).toBeLessThanOrEqual(6);
    }
  });

  test('keeps text at its printed weight: dark, but lighter than Enhanced makes it', () => {
    const page = makePage();
    const ns = run(Uint8ClampedArray.from(page.d), [{ noshadow: 1 }]);
    const en = run(Uint8ClampedArray.from(page.d), [{ magic: 1 }]);
    // Mean over a text band includes anti-aliasing, so it shows the weight.
    const band = (d: Uint8ClampedArray) => mean(d, 30, 32, 200, 150);
    expect(band(ns)).toBeGreaterThan(band(en));
    let darkest = 255;
    for (let y = 32; y < 150; y++) for (let x = 30; x < 70; x++) if (page.isText(x, y)) darkest = Math.min(darkest, lum(at(ns, x, y)));
    expect(darkest).toBeLessThan(70);
  });

  test('colour keeps its hue', () => {
    const d = run(makePage({ paint: colourPaint }).d, [{ noshadow: 1 }]);
    const [r, g, b] = at(d, ...STAMP);
    expect(r).toBeGreaterThan(g + 60);
    expect(r).toBeGreaterThan(b + 60);
    const s = at(d, ...SIGN);
    expect(s[2]).toBeGreaterThan(s[0] + 40);
  });
});

describe('Photo', () => {
  test('does not flatten the lighting (a photo keeps its light and shade)', () => {
    const d = run(makePage().d, [{ photo: 1 }]);
    expect(lum(at(d, ...PAPER_LIT)) - lum(at(d, ...PAPER_SHADOW))).toBeGreaterThan(60);
  });

  test('stretches a dull, low-contrast picture to the full range, keeping hue', () => {
    const d = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = x / (W - 1), i = (y * W + x) * 4;
      d[i] = 70 + 150 * t; d[i + 1] = 60 + 150 * t; d[i + 2] = 50 + 140 * t; d[i + 3] = 255;
    }
    const before = at(d, 120, 100);
    run(d, [{ photo: 1 }]);
    expect(lum(at(d, 0, 100))).toBeLessThan(25);
    expect(lum(at(d, W - 1, 100))).toBeGreaterThan(245);
    const after = at(d, 120, 100);
    // Warm stays warm: red above green above blue, as before.
    expect(before[0] > before[1] && before[1] > before[2]).toBe(true);
    expect(after[0] > after[1] && after[1] > after[2]).toBe(true);
  });

  test('a full-range picture is left nearly as it is', () => {
    const d = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = Math.round((255 * x) / (W - 1)), i = (y * W + x) * 4;
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
    run(d, [{ photo: 1 }]);
    expect(Math.abs(lum(at(d, 120, 100)) - 128)).toBeLessThan(12);
  });
});

describe('Faint text', () => {
  const pencil = (x: number, y: number): RGB | null =>
    (y >= 200 && y < 202 && x > 30 && x < 210 && x % 11 < 8 ? [196, 190, 176] : null);
  // Pencil only a little darker than the paper, lit and in the shadow.
  const PENCIL_LIT: [number, number] = [40, 200];
  const PENCIL_SHADOW: [number, number] = [190, 200];

  test('darkens faint pencil far more than Grayscale does, in light and shadow', () => {
    const page = makePage({ paint: pencil, noise: 4 });
    const ft = run(Uint8ClampedArray.from(page.d), [{ faint: 1 }]);
    const gr = run(Uint8ClampedArray.from(page.d), [{ docgray: 1 }]);
    for (const p of [PENCIL_LIT, PENCIL_SHADOW]) {
      expect(lum(at(ft, ...p))).toBeLessThan(110);
      expect(lum(at(ft, ...p))).toBeLessThan(lum(at(gr, ...p)) - 50);
    }
  });

  test('paper stays clean white (grain and the shadow edge are not "found" as writing)', () => {
    const d = run(makePage({ noise: 6 }).d, [{ faint: 1 }]);
    let grey = 0;
    for (let y = 160; y < 320; y++) for (let x = 0; x < W; x++) if (lum(at(d, x, y)) < 230) grey++;
    expect(grey / (160 * W)).toBeLessThan(0.002);
  });

  test('a large dark shape stays solid, not a hollow outline', () => {
    const box = (x: number, y: number): RGB | null => (x > 40 && x < 120 && y > 180 && y < 260 ? [90, 85, 80] : null);
    const d = run(makePage({ paint: box }).d, [{ faint: 1 }]);
    expect(lum(at(d, 80, 220))).toBeLessThan(140);
  });

  test('outputs gray', () => {
    expect(isGray(run(makePage({ paint: colourPaint }).d, [{ faint: 1 }]))).toBe(true);
  });
});

describe('Whiteboard', () => {
  const marker = (x: number, y: number): RGB | null => {
    if (y >= 200 && y < 206 && x > 30 && x < 200) return [70, 100, 150]; // dull blue marker
    if (y >= 230 && y < 236 && x > 30 && x < 200) return [205, 200, 192]; // ghost of erased writing
    return null;
  };

  test('board is white and erased ghosting is gone', () => {
    const d = run(makePage({ paper: [222, 224, 220], paint: marker }).d, [{ board: 1 }]);
    for (const p of [PAPER_LIT, PAPER_SHADOW, [60, 233] as [number, number], [190, 233] as [number, number]]) {
      expect(lum(at(d, ...p))).toBeGreaterThanOrEqual(245);
    }
  });

  test('marker colour comes out more saturated than Enhanced makes it, same hue', () => {
    const page = makePage({ paper: [222, 224, 220], paint: marker });
    const wb = run(Uint8ClampedArray.from(page.d), [{ board: 1 }]);
    const en = run(Uint8ClampedArray.from(page.d), [{ magic: 1 }]);
    for (const x of [50, 180]) {
      const b = at(wb, x, 203), e = at(en, x, 203);
      expect(chroma(b)).toBeGreaterThan(chroma(e) + 15);
      expect(b[2]).toBe(Math.max(...b)); // still blue
    }
  });
});

describe('Ink saver', () => {
  const box = (x: number, y: number): RGB | null => (x > 30 && x < 130 && y > 180 && y < 280 ? [25, 25, 28] : null);

  test('text is dark gray (readable, lighter than Grayscale); big solids are much lighter', () => {
    const page = makePage({ paint: box });
    const eco = run(Uint8ClampedArray.from(page.d), [{ eco: 1 }]);
    const gr = run(Uint8ClampedArray.from(page.d), [{ docgray: 1 }]);
    let ecoText = 255, grText = 255;
    for (let y = 32; y < 150; y++) for (let x = 30; x < 70; x++) if (page.isText(x, y)) {
      ecoText = Math.min(ecoText, lum(at(eco, x, y)));
      grText = Math.min(grText, lum(at(gr, x, y)));
    }
    expect(ecoText).toBeGreaterThan(grText + 30);
    expect(ecoText).toBeLessThan(110);
    expect(lum(at(eco, 80, 230))).toBeGreaterThan(150);
    expect(lum(at(eco, ...PAPER_SHADOW))).toBeGreaterThanOrEqual(250);
    expect(isGray(eco)).toBe(true);
  });
});

describe('Sharpness', () => {
  /** Naive reference: unsharp mask with a full box blur of the luminance. */
  function reference(src: Uint8ClampedArray, w: number, h: number, amt: number): Uint8ClampedArray {
    const d = Uint8ClampedArray.from(src);
    const long = Math.max(w, h), r = Math.max(1, Math.round(long / 1500));
    const L = new Float64Array(w * h);
    for (let j = 0; j < w * h; j++) L[j] = (0.299 * src[j * 4] + 0.587 * src[j * 4 + 1] + 0.114 * src[j * 4 + 2] + 0.5) | 0;
    const gain = amt > 0 ? amt * 1.6 : amt;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++)
        for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) { s += L[yy * w + xx]; n++; }
      const diff = L[y * w + x] - s / n;
      if (amt > 0 && diff < 2 && diff > -2) continue;
      const off = Math.max(-48, Math.min(48, diff * gain)), i = (y * w + x) * 4;
      d[i] += off; d[i + 1] += off; d[i + 2] += off;
    }
    return d;
  }

  test.each([[0.6, 37, 23], [-0.8, 37, 23], [1, 1600, 9], [0.5, 5, 3000]])(
    'streaming version matches the naive one exactly (amount %p, %p x %p)',
    (amt, w, h) => {
      let seed = 99;
      const src = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < src.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; src[i] = (i & 3) === 3 ? 255 : seed % 256; }
      const got = Uint8ClampedArray.from(src);
      kernels.sharpen(got, w, h, amt);
      expect(Buffer.from(got).equals(Buffer.from(reference(src, w, h, amt)))).toBe(true);
    },
  );

  test('a soft edge gets crisper; flat paper is untouched; negative softens', () => {
    const mk = () => {
      const d = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const v = x < 118 ? 40 : x > 122 ? 230 : 40 + (x - 118) * 38, i = (y * W + x) * 4;
        d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
      }
      return d;
    };
    const slope = (d: Uint8ClampedArray) => lum(at(d, 123, 50)) - lum(at(d, 118, 50));
    const sharp = run(mk(), [{ sharpen: 1 }]), soft = run(mk(), [{ sharpen: -1 }]), base = mk();
    expect(slope(sharp)).toBeGreaterThan(slope(base));
    expect(slope(soft)).toBeLessThan(slope(base));
    expect(at(sharp, 20, 50)).toEqual(at(base, 20, 50));
    expect(at(sharp, 200, 50)).toEqual(at(base, 200, 50));
  });
});

describe('every new filter', () => {
  const ops: Record<string, Op[]> = {
    noshadow: [{ noshadow: 1 }], photo: [{ photo: 1 }], faint: [{ faint: 1 }],
    board: [{ board: 1 }], eco: [{ eco: 1 }], sharpen: [{ sharpen: 0.7 }],
  };
  test.each(Object.keys(ops))('%s: degenerate sizes and a blank page do not throw or produce NaN', k => {
    for (const [w, h] of [[1, 1], [2, 50], [50, 2], [3, 3]]) {
      const d = new Uint8ClampedArray(w * h * 4).fill(200);
      expect(() => applyOps(d, w, h, ops[k])).not.toThrow();
    }
    const d = new Uint8ClampedArray(W * H * 4).fill(255);
    applyOps(d, W, H, ops[k]);
    expect(d.every(v => Number.isFinite(v))).toBe(true);
    expect(lum(at(d, 100, 100))).toBeGreaterThan(240);
  });

  test.each(Object.keys(ops))('%s: runs in linear time on a 0.75 MP page', k => {
    const w = 1000, h = 750, d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < d.length; i += 4) { const v = (i / 4) % 37 < 3 ? 40 : 220; d[i] = v; d[i + 1] = v; d[i + 2] = v - 10; d[i + 3] = 255; }
    const t = Date.now();
    applyOps(d, w, h, ops[k]);
    // Generous: jest's VM is far slower than WebKit's JIT (see the 12 MP
    // timings in the R12 report); this catches accidental O(n * window) loops.
    expect(Date.now() - t).toBeLessThan(5000);
  });
});

describe('filter ids and adjustments (lib/filters.ts)', () => {
  test('new ids map to their kernels', () => {
    expect(combinedFilterRN('noshadow')).toEqual([{ noshadow: 1 }]);
    expect(combinedFilterRN('photo')).toEqual([{ photo: 1 }]);
    expect(combinedFilterRN('fainttext')).toEqual([{ faint: 1 }]);
    expect(combinedFilterRN('whiteboard')).toEqual([{ board: 1 }]);
    expect(combinedFilterRN('inksaver')).toEqual([{ eco: 1 }]);
  });

  test('Sharpness runs after the filter and before the other sliders; before the threshold on Black & white', () => {
    expect(combinedFilterRN('enhanced', { brightness: 10, contrast: 0, saturation: 0, sharpness: 50 }))
      .toEqual([{ magic: 1 }, { sharpen: 0.5 }, { brightness: 1.1 }]);
    expect(combinedFilterRN('original', { brightness: 0, contrast: 0, saturation: 0, sharpness: -30 }))
      .toEqual([{ sharpen: -0.3 }]);
    expect(combinedFilterRN('bw', { brightness: 20, contrast: 0, saturation: 0, sharpness: 100 }))
      .toEqual([{ sharpen: 1 }, { docbw: 1, bias: 0.2 }]);
    expect(combinedFilterRN('photo', { brightness: 0, contrast: 0, saturation: 0, sharpness: 400 }))
      .toEqual([{ photo: 1 }, { sharpen: 1 }]);
  });

  test('an adjustment saved before R12 (no sharpness field) gives the same ops as before', () => {
    expect(combinedFilterRN('enhanced', { brightness: 0, contrast: 10, saturation: -20 }))
      .toEqual([{ magic: 1 }, { contrast: 1.1 }, { saturate: 0.8 }]);
    expect(combinedFilterRN('original', { brightness: 0, contrast: 0, saturation: 0, sharpness: NaN }))
      .toBeUndefined();
  });

  test('Saturation is dropped on every gray filter', () => {
    for (const f of NO_COLOR_FILTERS) {
      const ops = combinedFilterRN(f, { brightness: 0, contrast: 0, saturation: 50 }) ?? [];
      expect(ops.some(o => 'saturate' in o)).toBe(false);
    }
    expect(combinedFilterRN('noshadow', { brightness: 0, contrast: 0, saturation: 50 }))
      .toEqual([{ noshadow: 1 }, { saturate: 1.5 }]);
  });

  test('isNeutralAdjustment counts sharpness', () => {
    expect(isNeutralAdjustment(undefined)).toBe(true);
    expect(isNeutralAdjustment({ brightness: 0, contrast: 0, saturation: 0 })).toBe(true);
    expect(isNeutralAdjustment({ brightness: 0, contrast: 0, saturation: 0, sharpness: 20 })).toBe(false);
  });
});

describe('filter previews (buildPreviewHtml run against a fake canvas)', () => {
  /** Runs the preview page's script with a minimal DOM; returns what it posts. */
  function renderPreviews(opsList: Op[][]): string[] {
    const html = buildPreviewHtml('file:///p.jpg', opsList, 100);
    const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
    const nw = 160, nh = 200;
    const src = makePageScaled(nw, nh);
    type Canvas = { width: number; height: number; data: Uint8ClampedArray | null; getContext: () => unknown; toDataURL: () => string };
    const mkCanvas = (): Canvas => {
      const c: Canvas = {
        width: 0, height: 0, data: null,
        getContext: () => ({
          drawImage: (from: unknown, ...a: number[]) => {
            if (from === img) { c.data = Uint8ClampedArray.from(src); return; }
            // Tile: copy the source canvas's checksum through (scaling is not modelled).
            c.data = Uint8ClampedArray.from((from as Canvas).data!);
            void a;
          },
          getImageData: () => ({ data: Uint8ClampedArray.from(c.data!) }),
          createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
          putImageData: (id: { data: Uint8ClampedArray }) => { c.data = Uint8ClampedArray.from(id.data); },
          fillRect: () => {},
        }),
        toDataURL: () => {
          let hsh = 0x811c9dc5;
          for (let i = 0; i < c.data!.length; i++) hsh = Math.imul(hsh ^ c.data![i], 0x01000193) >>> 0;
          return `data:image/jpeg;base64,${hsh.toString(16)}`;
        },
      };
      return c;
    };
    const img: Record<string, unknown> = { naturalWidth: nw, naturalHeight: nh, complete: false };
    const posted: string[] = [];
    const doc = { getElementById: () => img, createElement: () => mkCanvas() };
    const win = { ReactNativeWebView: { postMessage: (m: string) => posted.push(m) } };
    new Function('document', 'window', 'setTimeout', script)(doc, win, () => {});
    (img.onload as () => void)();
    expect(posted).toHaveLength(1);
    expect(posted[0].slice(0, 60)).toMatch(/^PREVIEWS:/);
    return JSON.parse(posted[0].slice('PREVIEWS:'.length)) as string[];
  }

  function makePageScaled(w: number, h: number): Uint8ClampedArray {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, ink = y % 16 < 3 && x > 10 && x < w - 10 && y < h * 0.6;
      // Text lines, a mid-gray photo and a light pencil line.
      const photo = x > 20 && x < 70 && y > h * 0.65 && y < h * 0.9;
      const pencil = y === Math.round(h * 0.95) && x > 20 && x < w - 20;
      const v = (ink ? 30 : photo ? 140 : pencil ? 190 : 230) * (1 - 0.35 * (x / w));
      d[i] = v; d[i + 1] = v - 4; d[i + 2] = v - 18; d[i + 3] = 255;
    }
    return d;
  }

  test('one tile per filter, in order, each different, from a single pass', () => {
    const ids: PageFilter[] = ['original', 'enhanced', 'noshadow', 'grayscale', 'bw', 'fainttext', 'photo', 'whiteboard', 'inksaver'];
    const tiles = renderPreviews(ids.map(f => (combinedFilterRN(f) ?? []) as Op[]));
    expect(tiles).toHaveLength(ids.length);
    expect(tiles.filter(t => !(typeof t === 'string' && t.startsWith('data:image/jpeg')))).toEqual([]);
    const dup = tiles.map((t, i) => [ids[i], tiles.indexOf(t)] as const).filter(([, j], i) => j !== i);
    expect(dup).toEqual([]);
    // The original tile is the unfiltered page, whichever filter ran first.
    const again = renderPreviews([[], [{ docgray: 1 }]]);
    expect(again[0]).toBe(tiles[0]);
  });
});
