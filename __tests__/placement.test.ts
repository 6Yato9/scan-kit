// lib/placement.ts — placing a signature by hand (drag, corner resize, pinch)
// and dragging the timestamp; plus how the result maps onto the page that
// lib/stamp.ts draws, for pages of any shape.
import {
  anchorToOrigin,
  boxToPlacement,
  centerBoxAt,
  clampBox,
  cornerAnchor,
  handleTargetOffset,
  maxBoxWidth,
  minBoxWidth,
  moveBox,
  originToAnchor,
  placementToBox,
  resizeBox,
  scaleBox,
  type Box,
  type Bounds,
} from '../lib/placement';
import { clampPlacement, signatureHeightFraction, resolveStamp } from '../lib/stamp';

const page: Bounds = { width: 300, height: 400 };
const box: Box = { x: 100, y: 200, w: 80, h: 20 }; // a 4:1 signature
const ratio = 0.25;
const close = (a: Box, b: Box) => {
  for (const k of ['x', 'y', 'w', 'h'] as const) expect(a[k]).toBeCloseTo(b[k], 6);
};

describe('limits', () => {
  test('max width is the page width, or less when the page is too short for the shape', () => {
    expect(maxBoxWidth(page, ratio)).toBe(300);
    // A landscape page 300 × 60: a 4:1 box can be at most 240 wide.
    expect(maxBoxWidth({ width: 300, height: 60 }, ratio)).toBe(240);
  });

  test('min width is 44 pt or 6% of the page, never above the max', () => {
    expect(minBoxWidth(page, ratio)).toBe(44);
    expect(minBoxWidth({ width: 1000, height: 2000 }, ratio)).toBe(60);
    expect(minBoxWidth({ width: 300, height: 8 }, ratio)).toBe(32);
  });
});

describe('moving', () => {
  test('follows the finger', () => {
    close(moveBox(box, 20, -50, page), { x: 120, y: 150, w: 80, h: 20 });
  });

  test('stops at every page edge, size unchanged', () => {
    close(moveBox(box, -500, -500, page), { x: 0, y: 0, w: 80, h: 20 });
    close(moveBox(box, 500, 500, page), { x: 220, y: 380, w: 80, h: 20 });
  });

  test('a tap centres it on the point, kept on the page', () => {
    close(centerBoxAt(box, 150, 100, page), { x: 110, y: 90, w: 80, h: 20 });
    close(centerBoxAt(box, 5, 399, page), { x: 0, y: 380, w: 80, h: 20 });
  });
});

describe('resizing from a corner', () => {
  test('bottom-right grows outward with the top-left pinned and the shape kept', () => {
    const b = resizeBox(box, 'br', 40, 10, page, 44);
    expect(b.x).toBe(100);
    expect(b.y).toBe(200);
    expect(b.w).toBeGreaterThan(80);
    expect(b.h / b.w).toBeCloseTo(ratio);
  });

  test('each corner pins the opposite one', () => {
    const right = box.x + box.w;
    const bottom = box.y + box.h;
    const tl = resizeBox(box, 'tl', -40, -10, page, 44);
    expect(tl.x + tl.w).toBeCloseTo(right);
    expect(tl.y + tl.h).toBeCloseTo(bottom);
    const tr = resizeBox(box, 'tr', 40, -10, page, 44);
    expect(tr.x).toBeCloseTo(box.x);
    expect(tr.y + tr.h).toBeCloseTo(bottom);
    const bl = resizeBox(box, 'bl', -40, 10, page, 44);
    expect(bl.x + bl.w).toBeCloseTo(right);
    expect(bl.y).toBeCloseTo(box.y);
    for (const b of [tl, tr, bl]) {
      expect(b.w).toBeGreaterThan(80);
      expect(b.h / b.w).toBeCloseTo(ratio);
    }
  });

  test('pushing a corner inward shrinks it', () => {
    expect(resizeBox(box, 'br', -20, -5, page, 44).w).toBeLessThan(80);
    expect(resizeBox(box, 'tl', 20, 5, page, 44).w).toBeLessThan(80);
  });

  test('measured along the diagonal: a sideways wobble barely changes the size', () => {
    const straight = resizeBox(box, 'br', 40, 10, page, 44).w;
    const wobble = resizeBox(box, 'br', 40, 10 + 30, page, 44).w;
    expect(Math.abs(wobble - straight)).toBeLessThan(10);
  });

  test('never smaller than the minimum', () => {
    expect(resizeBox(box, 'br', -500, -500, page, 44).w).toBe(44);
  });

  test('stops at the page edge on the dragged side', () => {
    const b = resizeBox(box, 'br', 1000, 250, page, 44);
    expect(b.x + b.w).toBeLessThanOrEqual(300 + 1e-9);
    expect(b.y + b.h).toBeLessThanOrEqual(400 + 1e-9);
    expect(b.x).toBe(100);
    const t = resizeBox(box, 'tl', -1000, -250, page, 44);
    expect(t.x).toBeGreaterThanOrEqual(-1e-9);
    expect(t.y).toBeGreaterThanOrEqual(-1e-9);
  });

  test('a short landscape page caps the size by its height', () => {
    const wide: Bounds = { width: 300, height: 60 };
    const b = resizeBox({ x: 0, y: 0, w: 100, h: 25 }, 'br', 1000, 1000, wide, 44);
    expect(b.h).toBeLessThanOrEqual(60 + 1e-9);
    expect(b.w).toBeCloseTo(240);
  });
});

describe('pinching', () => {
  test('scales around the centre', () => {
    const b = scaleBox(box, 1.5, page, 44);
    expect(b.w).toBeCloseTo(120);
    expect(b.x + b.w / 2).toBeCloseTo(box.x + box.w / 2);
    expect(b.y + b.h / 2).toBeCloseTo(box.y + box.h / 2);
  });

  test('clamped between min and max, and moved back onto the page', () => {
    expect(scaleBox(box, 0.01, page, 44).w).toBe(44);
    const big = scaleBox({ x: 250, y: 380, w: 40, h: 10 }, 100, page, 44);
    expect(big.w).toBe(300);
    expect(big.x).toBe(0);
    expect(big.y + big.h).toBeLessThanOrEqual(400);
  });
});

describe('preview to page', () => {
  test('a box round-trips through page fractions', () => {
    const p = boxToPlacement(box, page);
    expect(p).toEqual({ x: 100 / 300, y: 0.5, w: 80 / 300 });
    close(placementToBox(p, ratio, page), box);
  });

  test('the height lib/stamp.ts draws is the box height, for any page shape', () => {
    const sig = { dataUri: 'data:image/png;base64,AA==', width: 400, height: 100 };
    for (const bounds of [page, { width: 354, height: 236 }, { width: 200, height: 600 }]) {
      const b: Box = { x: 10, y: 20, w: 120, h: 30 };
      const p = boxToPlacement(b, bounds);
      const aspect = bounds.height / bounds.width;
      expect(signatureHeightFraction(sig, p, aspect) * bounds.height).toBeCloseTo(b.h);
      // What the canvas gets: the same numbers, unchanged.
      expect(resolveStamp({ kind: 'signature', signature: sig, placement: p })).toMatchObject({ x: p.x, y: p.y, w: p.w });
    }
  });

  test('a placement made on a portrait page stays whole on a landscape one', () => {
    const sig = { dataUri: 'data:image/png;base64,AA==', width: 200, height: 100 };
    // 90% wide on a portrait page: 0.45 page widths tall; a 3:2 landscape page is only 0.667 tall.
    const p = clampPlacement(sig, { x: 0.05, y: 0.5, w: 0.9 }, 2 / 3);
    expect(p.y + signatureHeightFraction(sig, p, 2 / 3)).toBeLessThanOrEqual(1 + 1e-9);
    expect(p.x + p.w).toBeLessThanOrEqual(1);
    // A very wide one is narrowed until it fits the page height.
    const tall = clampPlacement({ ...sig, height: 400 }, { x: 0, y: 0, w: 1 }, 2 / 3);
    expect(signatureHeightFraction({ ...sig, height: 400 }, tall, 2 / 3)).toBeLessThanOrEqual(1 + 1e-9);
  });

  test('clampBox keeps a box on the page', () => {
    close(clampBox({ x: -5, y: 395, w: 80, h: 20 }, page), { x: 0, y: 380, w: 80, h: 20 });
  });
});

describe('corner handles', () => {
  test('a 44-pt target reaches at most a quarter into the box', () => {
    const small = handleTargetOffset('br', 40, 12);
    expect(small).toEqual({ left: -10, top: -3 });
    const big = handleTargetOffset('tl', 200, 100);
    expect(big).toEqual({ left: -30, top: -30 });
    // The middle of even a small box is left for dragging it.
    const tl = handleTargetOffset('tl', 60, 16);
    const tr = handleTargetOffset('tr', 60, 16);
    const tlRight = tl.left + 44; // relative to x = 0
    const trLeft = 60 + tr.left;
    expect(trLeft - tlRight).toBeGreaterThan(0);
  });
});

describe('timestamp anchor', () => {
  test('corners sit at the inset from both edges', () => {
    expect(anchorToOrigin(cornerAnchor('top-left'), 300, 400, 60, 10, 5)).toEqual({ x: 5, y: 5 });
    expect(anchorToOrigin(cornerAnchor('bottom-right'), 300, 400, 60, 10, 5)).toEqual({ x: 235, y: 385 });
  });

  test('a dragged position maps back to its anchor, and snaps near edges and the middle', () => {
    const a = originToAnchor(100, 150, 300, 400, 60, 10, 5);
    const o = anchorToOrigin(a, 300, 400, 60, 10, 5);
    expect(o.x).toBeCloseTo(100);
    expect(o.y).toBeCloseTo(150);
    expect(originToAnchor(7, 383, 300, 400, 60, 10, 5)).toEqual({ x: 0, y: 1 });
    expect(originToAnchor(121, 6, 300, 400, 60, 10, 5)).toEqual({ x: 0.5, y: 0 });
    // Dragged past the page: held at the inset edge.
    expect(originToAnchor(-50, 900, 300, 400, 60, 10, 5)).toEqual({ x: 0, y: 1 });
  });

  test('the same anchor lands at the same relative place on any page and text width', () => {
    const a = { x: 0.3, y: 0.7 };
    const small = anchorToOrigin(a, 300, 400, 60, 10, 5);
    const big = anchorToOrigin(a, 3000, 4000, 600, 100, 50);
    expect(big.x / 10).toBeCloseTo(small.x);
    expect(big.y / 10).toBeCloseTo(small.y);
  });

  test('the canvas gets the anchor (or the corner when none was dragged)', () => {
    expect(resolveStamp({ kind: 'timestamp', text: 'x', corner: 'top-right' })).toMatchObject({ ax: 1, ay: 0 });
    expect(resolveStamp({ kind: 'timestamp', text: 'x', corner: 'top-right', anchor: { x: 0.5, y: 0.25 } })).toMatchObject({ ax: 0.5, ay: 0.25 });
    expect(resolveStamp({ kind: 'timestamp', text: 'x', corner: 'top-right', anchor: { x: 7, y: Number.NaN } })).toMatchObject({ ax: 1, ay: 0 });
  });
});
