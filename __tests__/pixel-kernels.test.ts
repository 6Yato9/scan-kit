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
} = {}) {
  const paper = opts.paper ?? [236, 228, 208];
  const shadow = opts.shadow ?? 0.45;
  const ink = opts.ink ?? [30, 30, 34];
  const d = new Uint8ClampedArray(w * h * 4);
  const isText = (x: number, y: number) =>
    x > w * 0.1 && x < w * 0.9 && y % 24 >= 8 && y % 24 < 12 && (x % 9) < 6 && y > h * 0.1 && y < h * 0.6;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Light falls off smoothly from 1 (left) to `shadow` (right).
      const light = 1 - (1 - shadow) * Math.min(1, Math.max(0, (x / w - 0.3) / 0.6));
      const base = opts.paint?.(x, y) ?? (isText(x, y) ? ink : paper);
      const i = (y * w + x) * 4;
      d[i] = base[0] * light; d[i + 1] = base[1] * light; d[i + 2] = base[2] * light; d[i + 3] = 255;
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
