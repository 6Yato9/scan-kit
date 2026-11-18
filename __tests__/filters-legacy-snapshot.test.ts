import { combinedFilterRN } from '../lib/filters';
import { PIXEL_KERNELS_JS } from '../lib/pixel-kernels';
import type { PageAdjustment, PageFilter } from '../types/document';

// DATA SAFETY. Filter ids and adjustments are stored in users' documents and
// re-applied (from the page's .orig) whenever a page is re-baked: after a
// crop, a rotate, a retake, or the startup self-heal. A filter id must
// therefore keep producing exactly the pixels it produced when the user chose
// it. These checksums were taken from the R11 kernels BEFORE the R12 filter
// work started; any change to what an existing id (or an existing adjustment)
// does to pixels fails here.

type Op = Record<string, number>;
type Apply = (d: Uint8ClampedArray, w: number, h: number, ops: Op[]) => void;
const applyOps = new Function(`${PIXEL_KERNELS_JS}; return applyOps;`)() as Apply;

const W = 220, H = 300;

/**
 * A deterministic photographed page with everything the filters care about:
 * a cream sheet lit from the top-left with a hand-shadow blob, sensor noise,
 * dark text lines, faint pencil, a thin rule, a red stamp, a blue signature,
 * a yellow highlighter band and a grey photo box.
 */
function syntheticPage(): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  let seed = 987654321;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let c: [number, number, number] = [234, 226, 204];
      if (y >= 30 && y < 140 && x > 20 && x < 200 && y % 18 >= 6 && y % 18 < 10 && x % 8 < 5) c = [28, 28, 32];
      if (y >= 150 && y < 153 && x > 20 && x < 120) c = [176, 172, 160]; // pencil
      if (y === 160 && x > 20 && x < 200) c = [140, 138, 132]; // thin rule
      if (y >= 170 && y < 182 && x > 20 && x < 200) c = [240, 220, 70]; // highlighter
      if (y >= 174 && y < 178 && x > 30 && x < 150 && x % 7 < 4) c = [30, 30, 30];
      const dx = x - 160, dy = y - 230;
      const rr = Math.sqrt(dx * dx + dy * dy);
      if (rr > 22 && rr < 30) c = [190, 40, 45]; // stamp ring
      if (y > 200 && y < 260 && x > 20 && x < 90) c = [110, 105, 100]; // photo box
      if (Math.abs(y - (280 + 6 * Math.sin(x / 6))) < 1.5 && x > 30 && x < 110) c = [30, 50, 150]; // signature
      const light = (1 - 0.35 * (x / W) * (y / H)) * (1 - 0.5 * Math.exp(-((x - 150) ** 2 + (y - 90) ** 2) / 1800));
      const n = 8 * rnd();
      const i = (y * W + x) * 4;
      d[i] = c[0] * light + n; d[i + 1] = c[1] * light + n; d[i + 2] = c[2] * light + n; d[i + 3] = 255;
    }
  }
  return d;
}

/** FNV-1a over the RGB bytes. */
function checksum(d: Uint8ClampedArray): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < d.length; i++) {
    if ((i & 3) === 3) continue;
    h ^= d[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const ADJ: Record<string, PageAdjustment | undefined> = {
  none: undefined,
  zero: { brightness: 0, contrast: 0, saturation: 0 },
  mixed: { brightness: 20, contrast: -15, saturation: 30 },
  dark: { brightness: -40, contrast: 35, saturation: -60 },
};

const LEGACY: PageFilter[] = ['original', 'enhanced', 'grayscale', 'bw'];

// Taken from commit ddf4d35 (R11) before any R12 change.
const EXPECTED: Record<string, string> = {
  'original:none': 'c96509b5',
  'original:zero': 'c96509b5',
  'original:mixed': 'dc21c5f5',
  'original:dark': 'd41b99a0',
  'enhanced:none': 'aea39f68',
  'enhanced:zero': 'aea39f68',
  'enhanced:mixed': 'cb264d67',
  'enhanced:dark': '13951043',
  'grayscale:none': 'a4c0e6aa',
  'grayscale:zero': 'a4c0e6aa',
  'grayscale:mixed': '61a95915',
  'grayscale:dark': '79c09e72',
  'bw:none': '9030fe80',
  'bw:zero': '9030fe80',
  'bw:mixed': '0b6977c4',
  'bw:dark': 'eda63e26',
};

describe('existing filter ids are pixel-identical to R11', () => {
  for (const f of LEGACY) {
    for (const a of Object.keys(ADJ)) {
      test(`${f} + ${a}`, () => {
        const d = syntheticPage();
        const ops = combinedFilterRN(f, ADJ[a]) ?? [];
        applyOps(d, W, H, ops as Op[]);
        const got = checksum(d);
        if (process.env.PRINT_SNAPSHOT) console.log(`'${f}:${a}': '${got}',`);
        else expect(got).toBe(EXPECTED[`${f}:${a}`]);
      });
    }
  }
});
