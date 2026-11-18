import { BAKE_MAX_PIXELS, buildBakeHtml } from '../lib/bake-html';

const SRC = 'file:///docs/d1/page-0.orig.jpg';

/**
 * Pulls the real pixel-transform out of the generated HTML and runs it in Node,
 * so the maths is tested rather than the string that contains it.
 */
function runOps(ops: Record<string, number>[], rgb: [number, number, number]): number[] {
  const html = buildBakeHtml(SRC, ops);
  const body = html.slice(html.indexOf('var OPS ='), html.indexOf('var img ='));
  // Uint8ClampedArray, exactly like canvas ImageData — integer + clamped, so the
  // maths is exercised under the same rounding the browser applies.
  const data = new Uint8ClampedArray([rgb[0], rgb[1], rgb[2], 255]);
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${body}; apply(arguments[0]); return arguments[0];`);
  return Array.from(fn(data) as number[]);
}

test('embeds the ops and the source', () => {
  const html = buildBakeHtml(SRC, [{ grayscale: 1 }]);
  expect(html).toContain(SRC);
  expect(html).toContain('var OPS = [{"grayscale":1}]');
});

test('does not rely on ctx.filter, which is a silent no-op in this WebKit', () => {
  const html = buildBakeHtml(SRC, [{ grayscale: 1 }]);
  expect(html).not.toContain('ctx.filter');
  expect(html).toContain('getImageData');
  expect(html).toContain('putImageData');
});

test('reports load failure instead of hanging', () => {
  const html = buildBakeHtml(SRC, []);
  expect(html).toContain('onerror');
  expect(html).toContain('BAKE_ERROR');
});

test('grayscale(1) collapses a colour to its luminance', () => {
  const [r, g, b] = runOps([{ grayscale: 1 }], [255, 0, 0]);
  const lum = Math.round(0.2126 * 255);
  expect(r).toBeCloseTo(lum, 0);
  expect(r).toBe(g);
  expect(g).toBe(b);
});

test('grayscale(0) leaves pixels untouched', () => {
  expect(runOps([{ grayscale: 0 }], [10, 200, 30]).slice(0, 3)).toEqual([10, 200, 30]);
});

test('brightness scales channels and clamps at 255', () => {
  expect(runOps([{ brightness: 2 }], [100, 10, 0]).slice(0, 3)).toEqual([200, 20, 0]);
  expect(runOps([{ brightness: 4 }], [100, 0, 0]).slice(0, 3)).toEqual([255, 0, 0]);
});

test('contrast pushes away from mid-grey and clamps at 0', () => {
  expect(runOps([{ contrast: 2 }], [128, 138, 0]).slice(0, 3)).toEqual([128, 148, 0]);
});

test('ops compose in order — bw is grayscale then contrast', () => {
  const out = runOps([{ grayscale: 1 }, { contrast: 2 }], [255, 0, 0]);
  const lum = 0.2126 * 255;
  const expected = Math.max(0, Math.min(255, (lum - 128) * 2 + 128));
  expect(out[0]).toBeCloseTo(expected, 0);
  expect(out[0]).toBe(out[1]);
});

test('an empty op list is a pass-through', () => {
  expect(runOps([], [12, 34, 56]).slice(0, 3)).toEqual([12, 34, 56]);
});

describe('canvas size cap (critique #1: 24 MP photos)', () => {
  function runFit(w: number, h: number): { w: number; h: number } {
    const html = buildBakeHtml(SRC, []);
    const body = html.slice(html.indexOf('var MAX_PIXELS ='), html.indexOf('function post('));
    // eslint-disable-next-line no-new-func
    return new Function(`${body}; return fit(arguments[0], arguments[1]);`)(w, h);
  }

  test('pages within the WebKit limit bake at full size', () => {
    expect(runFit(4096, 3072)).toEqual({ w: 4096, h: 3072 });
  });

  test('a 24 MP photo is scaled to fit under 16 M pixels, keeping its aspect ratio', () => {
    const { w, h } = runFit(5712, 4284);
    expect(w * h).toBeLessThanOrEqual(BAKE_MAX_PIXELS);
    expect(w * h).toBeGreaterThan(BAKE_MAX_PIXELS * 0.99);
    expect(w / h).toBeCloseTo(5712 / 4284, 2);
  });

  test('a 48 MP photo fits too', () => {
    const { w, h } = runFit(8064, 6048);
    expect(w * h).toBeLessThanOrEqual(16_777_216);
  });

  test('an over-limit "data:," result is reported as an error, not saved', () => {
    const html = buildBakeHtml(SRC, []);
    expect(html).toContain("BAKE_ERROR:encode");
    expect(html).toContain("BAKE_ERROR:canvas");
  });
});
