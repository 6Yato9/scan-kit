// Geometry of the four-corner crop (lib/quad.ts).
import {
  FULL_QUAD,
  edgeMidpoint,
  fitRect,
  isConvexQuad,
  isFullQuad,
  moveCorner,
  moveEdge,
  normRotation,
  quadSourceToView,
  quadViewToSource,
  rotateCornerOrder,
  rotateGeometry,
  rotatedSize,
  sameGeometry,
  screenToView,
  sourceToView,
  viewToScreen,
  viewToSource,
  warpOutputSize,
  type Rotation,
} from '../lib/quad';

const ROTATIONS: Rotation[] = [0, 90, 180, 270];
const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));

describe('source ↔ view frame', () => {
  test.each(ROTATIONS)('viewToSource undoes sourceToView at %i°', r => {
    for (const p of [{ x: 0.1, y: 0.7 }, { x: 0, y: 0 }, { x: 1, y: 0.25 }]) {
      const back = viewToSource(sourceToView(p, r), r);
      expect(back.x).toBeCloseTo(p.x, 12);
      expect(back.y).toBeCloseTo(p.y, 12);
    }
  });

  test('turning clockwise sends the top-left corner to the top-right, and so on', () => {
    expect(sourceToView({ x: 0, y: 0 }, 90)).toEqual({ x: 1, y: 0 });
    expect(sourceToView({ x: 1, y: 0 }, 90)).toEqual({ x: 1, y: 1 });
    expect(sourceToView({ x: 0, y: 0 }, 180)).toEqual({ x: 1, y: 1 });
    expect(sourceToView({ x: 0, y: 0 }, 270)).toEqual({ x: 0, y: 1 });
  });

  test('a turned page shows its own top-left corner at the view\'s top-left', () => {
    // Page outline on a landscape photo, then the page turned right once.
    const g = rotateGeometry({ quad: [0.1, 0.1, 0.9, 0.12, 0.88, 0.9, 0.12, 0.88], rotation: 0 }, 90);
    const view = quadSourceToView(g.quad, g.rotation);
    // TL of the view quad is the leftmost-top of the four.
    const pts = [0, 1, 2, 3].map(i => ({ x: view[i * 2], y: view[i * 2 + 1] }));
    expect(pts[0].x).toBeLessThan(0.5);
    expect(pts[0].y).toBeLessThan(0.5);
    expect(pts[2].x).toBeGreaterThan(0.5);
    expect(pts[2].y).toBeGreaterThan(0.5);
    close(quadViewToSource(view, g.rotation), g.quad);
  });
});

describe('rotation of the geometry', () => {
  test('one quarter turn = the corner list shifted by one (the warp turns the output with it)', () => {
    expect(rotateCornerOrder([1, 1, 2, 2, 3, 3, 4, 4], 90)).toEqual([4, 4, 1, 1, 2, 2, 3, 3]);
    expect(rotateCornerOrder([1, 1, 2, 2, 3, 3, 4, 4], -90)).toEqual([2, 2, 3, 3, 4, 4, 1, 1]);
    expect(rotateCornerOrder([1, 1, 2, 2, 3, 3, 4, 4], 180)).toEqual([3, 3, 4, 4, 1, 1, 2, 2]);
  });

  test('four turns either way are the identity; left undoes right', () => {
    const g = { quad: [0.1, 0.2, 0.8, 0.1, 0.9, 0.9, 0.2, 0.8], rotation: 0 as Rotation };
    let r = g;
    for (let i = 0; i < 4; i++) r = rotateGeometry(r, 90);
    expect(sameGeometry(r, g)).toBe(true);
    expect(sameGeometry(rotateGeometry(rotateGeometry(g, 90), -90), g)).toBe(true);
    expect(rotateGeometry(g, -90).rotation).toBe(270);
  });

  test('normRotation folds any multiple of 90 into 0..270', () => {
    expect(normRotation(-90)).toBe(270);
    expect(normRotation(450)).toBe(90);
    expect(normRotation(360)).toBe(0);
  });

  test('a turned quad stays convex and clockwise', () => {
    let g = { quad: [0.1, 0.2, 0.8, 0.1, 0.9, 0.9, 0.2, 0.8], rotation: 0 as Rotation };
    for (let i = 0; i < 4; i++) {
      g = rotateGeometry(g, 90);
      expect(isConvexQuad(quadSourceToView(g.quad, g.rotation))).toBe(true);
      expect(isConvexQuad(g.quad)).toBe(true);
    }
  });
});

describe('convexity', () => {
  test('accepts the full image and a skewed page', () => {
    expect(isConvexQuad(FULL_QUAD)).toBe(true);
    expect(isConvexQuad([0.07, 0.07, 0.9, 0.05, 0.94, 0.92, 0.11, 0.95])).toBe(true);
  });
  test('rejects a crossed (bow-tie) outline', () => {
    expect(isConvexQuad([0, 0, 1, 1, 1, 0, 0, 1])).toBe(false);
  });
  test('rejects a dent (one corner pulled inside)', () => {
    expect(isConvexQuad([0, 0, 1, 0, 0.4, 0.4, 0, 1])).toBe(false);
  });
  test('rejects a mirrored (counter-clockwise) outline, which the warp refuses', () => {
    expect(isConvexQuad([0, 0, 0, 1, 1, 1, 1, 0])).toBe(false);
  });
  test('rejects degenerate and tiny outlines, and junk', () => {
    expect(isConvexQuad([0, 0, 1, 0, 1, 0, 0, 0])).toBe(false);
    expect(isConvexQuad([0.5, 0.5, 0.501, 0.5, 0.501, 0.501, 0.5, 0.501])).toBe(false);
    expect(isConvexQuad([0, 0, 1, 0, 1, 1] as number[])).toBe(false);
    expect(isConvexQuad([0, 0, 1, 0, 1, NaN, 0, 1])).toBe(false);
  });
  test('isFullQuad', () => {
    expect(isFullQuad([...FULL_QUAD])).toBe(true);
    expect(isFullQuad([0, 0, 1, 0, 1, 0.9, 0, 1])).toBe(false);
  });
});

describe('aspect-fit screen mapping', () => {
  test('a portrait photo in a portrait box: centred, letterboxed left and right', () => {
    const f = fitRect(300, 600, 1000, 1500)!;
    expect(f.scale).toBeCloseTo(0.3);
    expect(f.dispW).toBeCloseTo(300);
    expect(f.dispH).toBeCloseTo(450);
    expect(f.offY).toBeCloseTo(75);
    expect(f.offX).toBeCloseTo(0);
  });

  test('turned 90°, the fit uses the swapped size', () => {
    const f = fitRect(300, 600, 1500, 1000, 90)!; // landscape photo shown upright-portrait
    expect(rotatedSize(1500, 1000, 90)).toEqual({ w: 1000, h: 1500 });
    expect(f.dispW).toBeCloseTo(300);
    expect(f.dispH).toBeCloseTo(450);
  });

  test('screen ↔ view round trip, clamped to the image', () => {
    const f = fitRect(320, 480, 1000, 1000)!;
    const p = { x: 0.25, y: 0.8 };
    const s = viewToScreen(p, f);
    const back = screenToView(s, f);
    expect(back.x).toBeCloseTo(0.25);
    expect(back.y).toBeCloseTo(0.8);
    expect(screenToView({ x: -50, y: 9999 }, f)).toEqual({ x: 0, y: 1 });
  });

  test('no fit until both sizes are known', () => {
    expect(fitRect(0, 100, 10, 10)).toBeNull();
    expect(fitRect(100, 100, 0, 10)).toBeNull();
  });
});

describe('editing', () => {
  test('moveCorner clamps to the image', () => {
    expect(moveCorner([...FULL_QUAD], 0, -0.2, 0.1)).toEqual([0, 0.1, 1, 0, 1, 1, 0, 1]);
  });

  test('moveEdge moves both corners of a side by the same amount, stopping at the border without bending', () => {
    const q = [0.2, 0.2, 0.8, 0.3, 0.8, 0.8, 0.2, 0.8];
    const up = moveEdge(q, 0, 0, -0.5); // top edge; the higher corner stops at 0
    expect(up[1]).toBeCloseTo(0);
    expect(up[3]).toBeCloseTo(0.1); // same shift as the other corner: shape kept
    const mid = edgeMidpoint(q, 1);
    expect(mid).toEqual({ x: 0.8, y: 0.55 });
  });

  test('warpOutputSize keeps the page proportions', () => {
    expect(warpOutputSize(FULL_QUAD, 1000, 1400)).toEqual({ width: 1000, height: 1400 });
    const s = warpOutputSize([0.1, 0.1, 0.9, 0.1, 0.9, 0.5, 0.1, 0.5], 1000, 1000);
    expect(s).toEqual({ width: 800, height: 400 });
  });
});
