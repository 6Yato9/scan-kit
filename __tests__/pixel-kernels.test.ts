import { PIXEL_KERNELS_JS } from '../lib/pixel-kernels';

// The exact source WebKit runs, evaluated in Node.
type Op = Record<string, number>;
type Apply = (d: Uint8ClampedArray, w: number, h: number, ops: Op[]) => void;
const applyOps = new Function(`${PIXEL_KERNELS_JS}; return applyOps;`)() as Apply;

type RGB = [number, number, number];

/**
 * A synthetic photographed page: cream paper lit from the left, with the right
 * side falling into shadow (down to `shadow` of full light), dark text lines,
 * and optional extra paint.
 */
function makePage(w: number, h: number, opts: {
  paper?: RGB;
  shadow?: number;
  ink?: RGB;
  paint?: (x: number, y: number) => RGB | null;
  /** Peak-to-peak sensor noise in levels (deterministic). */
  noise?: number;
} = {}) {
  const paper = opts.paper ?? [236, 228, 208];
  const shadow = opts.shadow ?? 0.45;
  const ink = opts.ink ?? [30, 30, 34];
  const d = new Uint8ClampedArray(w * h * 4);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const isText = (x: number, y: number) =>
    x > w * 0.1 && x < w * 0.9 && y % 24 >= 8 && y % 24 < 12 && (x % 9) < 6 && y > h * 0.1 && y < h * 0.6;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Light falls off smoothly from 1 (left) to `shadow` (right).
      const light = 1 - (1 - shadow) * Math.min(1, Math.max(0, (x / w - 0.3) / 0.6));
      const base = opts.paint?.(x, y) ?? (isText(x, y) ? ink : paper);
      const i = (y * w + x) * 4;
      const n = (opts.noise ?? 0) * rnd();
      d[i] = base[0] * light + n; d[i + 1] = base[1] * light + n; d[i + 2] = base[2] * light + n; d[i + 3] = 255;
    }
  }
  return { d, isText };
}

const W = 240, H = 320;
const at = (d: Uint8ClampedArray, x: number, y: number): RGB => {
  const i = (y * W + x) * 4;
  return [d[i], d[i + 1], d[i + 2]];
};
const lum = ([r, g, b]: RGB) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Bare-paper and ink sample points, on the lit side and deep in the shadow. */
const PAPER_LIT: [number, number] = [30, 250];
const PAPER_SHADOW: [number, number] = [225, 250];
function inkPixel(isText: (x: number, y: number) => boolean, fromX: number): [number, number] {
  for (let x = fromX; x < W; x++) for (let y = 40; y < 200; y++) if (isText(x, y)) return [x, y];
  throw new Error('no ink');
}

describe('Enhanced (magic colour)', () => {
  test('a shadow gradient flattens: paper is white on both sides', () => {
    const { d } = makePage(W, H);
    expect(lum(at(d, ...PAPER_SHADOW))).toBeLessThan(120); // really dark before
    applyOps(d, W, H, [{ magic: 1 }]);
    for (const p of [PAPER_LIT, PAPER_SHADOW]) {
      const c = at(d, ...p);
      expect(Math.min(...c)).toBeGreaterThanOrEqual(245);
    }
  });

  test('yellowed paper becomes neutral white', () => {
    const { d } = makePage(W, H, { paper: [228, 210, 160], shadow: 1 });
    applyOps(d, W, H, [{ magic: 1 }]);
    const [r, g, b] = at(d, ...PAPER_LIT);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(4);
    expect(b).toBeGreaterThanOrEqual(245);
  });

  test('text stays dark, in light and in shadow', () => {
    const { d, isText } = makePage(W, H);
    const lit = inkPixel(isText, 30), dim = inkPixel(isText, 200);
    applyOps(d, W, H, [{ magic: 1 }]);
    expect(lum(at(d, ...lit))).toBeLessThan(60);
    expect(lum(at(d, ...dim))).toBeLessThan(60);
  });

  test('a red stamp keeps its hue', () => {
    const stamp = (x: number, y: number): RGB | null =>
      (x - 60) ** 2 + (y - 270) ** 2 < 20 ** 2 && (x - 60) ** 2 + (y - 270) ** 2 > 14 ** 2 ? [190, 40, 45] : null;
    const { d } = makePage(W, H, { paint: stamp, shadow: 1 });
    applyOps(d, W, H, [{ magic: 1 }]);
    const [r, g, b] = at(d, 60 + 17, 270);
    expect(r).toBeGreaterThan(150);
    expect(r - g).toBeGreaterThan(80);
    expect(r - b).toBeGreaterThan(80);
  });

  test('a large dark grey box is not blown out to white', () => {
    const box = (x: number, y: number): RGB | null => (x > 40 && x < 140 && y > 230 && y < 300 ? [70, 70, 72] : null);
    const { d } = makePage(W, H, { paint: box, shadow: 1 });
    applyOps(d, W, H, [{ magic: 1 }]);
    expect(lum(at(d, 90, 265))).toBeLessThan(110);
  });

  test('a uniform page does not produce NaN or garbage', () => {
    const d = new Uint8ClampedArray(64 * 64 * 4).fill(200);
    applyOps(d, 64, 64, [{ magic: 1 }]);
    expect(d.every(v => Number.isFinite(v))).toBe(true);
    expect(d[0]).toBeGreaterThanOrEqual(245);
  });
});

// Enhanced and Grayscale whiten the paper by clipping what is within a few
// percent of it, which used to erase faint pencil, a light signature line and
// thin rules. The stroke guard must keep those while the soft shadow, the
// paper noise and the anti-aliased edges of printed text behave as before.
describe('faint strokes survive whitening (Enhanced and Grayscale)', () => {
  const PAPER: RGB = [236, 228, 208];
  const shade = (k: number): RGB => [PAPER[0] * k, PAPER[1] * k, PAPER[2] * k];
  // A pencil note (25% darker than the paper, 2 px), a signature rule (12%
  // darker, 1 px), both running from the lit side into the shadow.
  const strokes = (x: number, y: number): RGB | null => {
    if (x > 30 && x < 210 && y >= 250 && y < 252) return shade(0.75);
    if (x > 30 && x < 210 && y === 290) return shade(0.88);
    return null;
  };
  const isStroke = (x: number, y: number) => x > 26 && x < 214 && ((y >= 246 && y < 256) || (y >= 286 && y <= 294));

  for (const [label, op] of [['Enhanced', { magic: 1 }], ['Grayscale', { docgray: 1 }]] as [string, Op][]) {
    test(`${label}: pencil and a thin rule stay visible, lit and in shadow`, () => {
      const { d } = makePage(W, H, { paint: strokes, shadow: 0.55, noise: 6 });
      applyOps(d, W, H, [op]);
      for (const x of [50, 190]) {
        expect(lum(at(d, x, 250))).toBeLessThan(150);
        expect(lum(at(d, x, 251))).toBeLessThan(150);
        expect(lum(at(d, x, 290))).toBeLessThan(200);
      }
    });

    test(`${label}: the soft shadow and paper noise still come out clean white`, () => {
      const { d } = makePage(W, H, { paint: strokes, shadow: 0.55, noise: 6 });
      applyOps(d, W, H, [op]);
      let paper = 0, grey = 0;
      for (let y = 215; y < H; y++) for (let x = 0; x < W; x++) {
        if (isStroke(x, y)) continue;
        paper++;
        if (lum(at(d, x, y)) < 240) grey++;
      }
      expect(grey / paper).toBeLessThan(0.002);
    });

    test(`${label}: printed text does not get bolder (its light halo stays light)`, () => {
      // Black text with a 1 px anti-aliased halo 15% darker than the paper.
      const text = (x: number, y: number): RGB | null => {
        if (x < 40 || x > 200 || y < 240 || y > 262) return null;
        if (y >= 248 && y < 254 && x % 10 < 5) return [25, 25, 28];
        if (y >= 247 && y < 255 && x % 10 < 6) return shade(0.85);
        return null;
      };
      const { d } = makePage(W, H, { paint: text, shadow: 1 });
      applyOps(d, W, H, [op]);
      expect(lum(at(d, 102, 250))).toBeLessThan(40);   // the ink
      expect(lum(at(d, 105, 250))).toBeGreaterThan(200); // its halo
    });
  }
});

/** Hue in degrees and HSV saturation of an RGB triple. */
function hueSat([r, g, b]: RGB): [number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
  if (!c) return [0, 0];
  let h = mx === r ? ((g - b) / c) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
  h *= 60; if (h < 0) h += 360;
  return [h, c / mx];
}

describe('Enhanced keeps colour faithfully; Grayscale removes it', () => {
  // Printed colours as they would look on white paper, photographed on cream
  // paper under a warm light (multiplied by the paper colour).
  const swatches: Record<string, RGB> = {
    highlighter: [255, 236, 60],
    teal: [20, 140, 150],
    orange: [232, 110, 40],
    blueInk: [30, 50, 150],
    red: [205, 35, 45],
  };
  const names = Object.keys(swatches);
  const paintSwatches = (x: number, y: number): RGB | null => {
    if (y < 220 || y >= 300 || x < 20 || x >= 220) return null;
    const c = swatches[names[Math.floor((x - 20) / 40)]];
    return [c[0] * 236 / 255, c[1] * 228 / 255, c[2] * 208 / 255];
  };
  const centre = (k: number): [number, number] => [40 + 40 * k, 260];

  test('hue is preserved and nothing turns neon', () => {
    const { d } = makePage(W, H, { paint: paintSwatches, shadow: 1 });
    applyOps(d, W, H, [{ magic: 1 }]);
    names.forEach((name, k) => {
      const want = hueSat(swatches[name]), got = hueSat(at(d, ...centre(k)));
      const dh = Math.min(Math.abs(got[0] - want[0]), 360 - Math.abs(got[0] - want[0]));
      expect([name, dh < 10]).toEqual([name, true]);
      expect([name, got[1] > want[1] * 0.75]).toEqual([name, true]);   // still colourful
    });
    // The highlighter stays a highlighter: it keeps some blue (not 255,255,0).
    const hl = at(d, ...centre(0));
    expect(hl[2]).toBeGreaterThan(25);
    expect(hl[0] - hl[2]).toBeLessThan(240);
  });

  test('Grayscale outputs no colour at all', () => {
    const { d } = makePage(W, H, { paint: paintSwatches, shadow: 1 });
    applyOps(d, W, H, [{ docgray: 1 }]);
    names.forEach((_, k) => {
      const [r, g, b] = at(d, ...centre(k));
      expect(r).toBe(g);
      expect(g).toBe(b);
    });
  });
});

describe('Black & white (adaptive threshold)', () => {
  test('a hand-shadow gradient becomes clean white paper with black text, no blotches', () => {
    const { d, isText } = makePage(W, H, { shadow: 0.4 });
    const lit = inkPixel(isText, 30), dim = inkPixel(isText, 200);
    applyOps(d, W, H, [{ docbw: 1 }]);
    // Every bare-paper pixel across the whole page, shadow included, is white.
    let blackPaper = 0;
    for (let y = 220; y < H; y++) for (let x = 0; x < W; x++) if (at(d, x, y)[0] < 200) blackPaper++;
    expect(blackPaper).toBe(0);
    expect(at(d, ...lit)[0]).toBeLessThan(40);
    expect(at(d, ...dim)[0]).toBeLessThan(40);
  });

  test('a faint pencil stroke stays visible', () => {
    const pencil = (x: number, y: number): RGB | null => (y >= 260 && y < 262 && x > 40 && x < 200 ? [160, 156, 150] : null);
    const { d } = makePage(W, H, { paint: pencil, shadow: 0.6 });
    applyOps(d, W, H, [{ docbw: 1 }]);
    expect(at(d, 60, 260)[0]).toBeLessThan(100);
    expect(at(d, 180, 261)[0]).toBeLessThan(100);
  });

  test('a large dark area stays solid (Sauvola alone would hollow it out)', () => {
    const box = (x: number, y: number): RGB | null => (x > 40 && x < 160 && y > 230 && y < 310 ? [60, 60, 60] : null);
    const { d } = makePage(W, H, { paint: box, shadow: 1 });
    applyOps(d, W, H, [{ docbw: 1 }]);
    expect(at(d, 100, 270)[0]).toBe(0);
  });

  test('a highlighter band turns white with no dotted outline, its text stays black', () => {
    const hl = (x: number, y: number): RGB | null => {
      if (x < 40 || x > 200 || y < 250 || y >= 280) return null;
      if (y >= 262 && y < 268 && x > 60 && x < 180 && x % 9 < 5) return [25, 25, 25];
      return [236, 214, 50];   // yellow highlighter on cream paper
    };
    const { d } = makePage(W, H, { paint: hl, shadow: 1 });
    applyOps(d, W, H, [{ docbw: 1 }]);
    let dark = 0;
    for (let y = 244; y < 286; y++) for (let x = 34; x < 206; x++) {
      const inText = y >= 262 && y < 268 && x > 58 && x < 182;
      if (!inText && at(d, x, y)[0] < 200) dark++;
    }
    expect(dark).toBe(0);
    expect(at(d, 64, 264)[0]).toBeLessThan(40);
  });

  test('a red stamp still turns black', () => {
    const stamp = (x: number, y: number): RGB | null => (x > 50 && x < 58 && y > 240 && y < 300 ? [190, 40, 45] : null);
    const { d } = makePage(W, H, { paint: stamp, shadow: 1 });
    applyOps(d, W, H, [{ docbw: 1 }]);
    expect(at(d, 54, 270)[0]).toBeLessThan(40);
  });

  test('output is gray (r = g = b)', () => {
    const { d } = makePage(W, H);
    applyOps(d, W, H, [{ docbw: 1 }]);
    const [r, g, b] = at(d, 100, 100);
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  test('the Brightness slider (bias) moves the threshold', () => {
    const grey = (x: number, y: number): RGB | null => (y >= 260 && y < 264 && x > 40 && x < 200 ? [175, 170, 160] : null);
    const darker = makePage(W, H, { paint: grey, shadow: 1 }).d;
    const lighter = Uint8ClampedArray.from(darker);
    applyOps(darker, W, H, [{ docbw: 1, bias: -0.8 }]);
    applyOps(lighter, W, H, [{ docbw: 1, bias: 0.8 }]);
    expect(at(darker, 100, 261)[0]).toBeLessThan(at(lighter, 100, 261)[0]);
  });
  test('even the darkest Brightness setting keeps bare paper white, shadow included', () => {
    const { d } = makePage(W, H, { shadow: 0.4 });
    applyOps(d, W, H, [{ docbw: 1, bias: -1, crisp: -1 }]);
    let notWhite = 0;
    for (let y = 220; y < H; y++) for (let x = 0; x < W; x++) if (at(d, x, y)[0] < 230) notWhite++;
    expect(notWhite).toBe(0);
  });
});

describe('Grayscale (flattened)', () => {
  test('flattens the shadow, keeps text dark, outputs gray', () => {
    const { d, isText } = makePage(W, H);
    const dim = inkPixel(isText, 200);
    applyOps(d, W, H, [{ docgray: 1 }]);
    const p = at(d, ...PAPER_SHADOW);
    expect(p[0]).toBeGreaterThanOrEqual(245);
    expect(p[0]).toBe(p[1]);
    expect(at(d, ...dim)[0]).toBeLessThan(60);
  });
});

describe('composition with the Adjust sliders', () => {
  test('brightness after Enhanced dims the white paper', () => {
    const { d } = makePage(W, H);
    applyOps(d, W, H, [{ magic: 1 }, { brightness: 0.8 }]);
    expect(at(d, ...PAPER_LIT)[0]).toBeGreaterThanOrEqual(200);
    expect(at(d, ...PAPER_LIT)[0]).toBeLessThanOrEqual(206);
  });

  test('saturate 0 after Enhanced removes colour', () => {
    const stamp = (x: number, y: number): RGB | null => (x > 50 && x < 70 && y > 260 && y < 280 ? [190, 40, 45] : null);
    const { d } = makePage(W, H, { paint: stamp, shadow: 1 });
    applyOps(d, W, H, [{ magic: 1 }, { saturate: 0 }]);
    const [r, g, b] = at(d, 60, 270);
    expect(Math.abs(r - g)).toBeLessThanOrEqual(1);
    expect(Math.abs(g - b)).toBeLessThanOrEqual(1);
  });
});

test('a 0.75 MP page runs in linear time (no per-window inner loops)', () => {
  // WebKit's JIT does a 12 MP page in a few hundred ms per filter; jest's VM is
  // far slower, so this is only a guard against an O(pixels x window) regression.
  const w = 750, h = 1000;
  const d = new Uint8ClampedArray(w * h * 4).fill(210);
  for (const op of [{ magic: 1 }, { docgray: 1 }, { docbw: 1 }] as Op[]) {
    const t = Date.now();
    applyOps(d, w, h, [op]);
    expect(Date.now() - t).toBeLessThan(5000);
  }
});
