// lib/quad.ts
// Pure geometry for the four-corner (perspective) crop: no React, no files.
//
// FRAMES
//  - Source frame: the page's uncropped, upright source photo (page-N.src.jpg),
//    normalised so (0,0) is its top-left and (1,1) its bottom-right.
//  - View frame: the source as the crop editor shows it, turned clockwise by
//    the geometry's `rotation` so the page reads upright. Also normalised 0..1.
//
// GEOMETRY ({ quad, rotation })
//  - `quad` is [x0,y0, x1,y1, x2,y2, x3,y3] in the SOURCE frame, listing the
//    corners that become the finished page's top-left, top-right,
//    bottom-right and bottom-left, in that order. It is handed to the native
//    perspective warp as is, so the warp's output is the finished page
//    (already turned): turning a page never needs a second JPEG pass.
//  - `rotation` (0/90/180/270, clockwise) is how the editor turns the source
//    so the selected page appears upright. Turning a page cw by 90° is
//    rotation + 90 and the quad's corner list rotated by one (rotateGeometry).
//
// With rotation 0, quad == what VisionOcr.detectQuad returns (TL,TR,BR,BL on
// the upright photo).

export type Rotation = 0 | 90 | 180 | 270;
export type Quad = number[];
export type PageGeometry = { quad: Quad; rotation: Rotation };
export type Point = { x: number; y: number };

/** The whole image, TL, TR, BR, BL. */
export const FULL_QUAD: Quad = [0, 0, 1, 0, 1, 1, 0, 1];

export function normRotation(deg: number): Rotation {
  const r = (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
  return r as Rotation;
}

export function isRotation(v: unknown): v is Rotation {
  return v === 0 || v === 90 || v === 180 || v === 270;
}

/** Eight finite numbers, each within 0..1 (a hair of tolerance for float noise). */
export function isQuad(q: unknown): q is Quad {
  return Array.isArray(q) && q.length === 8 && q.every(n => typeof n === 'number' && Number.isFinite(n) && n >= -1e-6 && n <= 1 + 1e-6);
}

export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function clampQuad(q: Quad): Quad {
  return q.map(clamp01);
}

export function toPoints(q: Quad): Point[] {
  return [0, 1, 2, 3].map(i => ({ x: q[i * 2], y: q[i * 2 + 1] }));
}

export function fromPoints(p: Point[]): Quad {
  return p.flatMap(pt => [pt.x, pt.y]);
}

/**
 * True when the four points (in order) form a convex, non-degenerate,
 * non-self-intersecting quadrilateral that runs CLOCKWISE on screen (y down)
 * — TL, TR, BR, BL, or a cyclic shift of it; the native warp rejects anything
 * else (a counter-clockwise list would be a mirrored page). `aspect` scales x
 * before the test so a quad in a normalised frame is judged in true
 * proportions; `minArea` is in the same (scaled) units.
 */
export function isConvexQuad(q: Quad, aspect = 1, minArea = 1e-4): boolean {
  if (!isQuad(q)) return false;
  const p = toPoints(q).map(pt => ({ x: pt.x * aspect, y: pt.y }));
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4], c = p[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (s < 0) return false; // counter-clockwise turn: mirrored or self-intersecting
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  // Convex with consistent turns can still wind twice only if it self-
  // intersects, which a 4-gon with all-same-sign turns cannot. Check area.
  return Math.abs(polygonArea(p)) >= minArea;
}

function polygonArea(p: Point[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const j = (i + 1) % p.length;
    a += p[i].x * p[j].y - p[j].x * p[i].y;
  }
  return a / 2;
}

/** True when `q` is (within `eps`) the whole image in its natural corner order. */
export function isFullQuad(q: Quad, eps = 1e-3): boolean {
  return isQuad(q) && q.every((v, i) => Math.abs(v - FULL_QUAD[i]) <= eps);
}

// ── Rotation ────────────────────────────────────────────────────────────────

/** A source-frame point as seen in the view frame (source turned cw by `r`). */
export function sourceToView(pt: Point, r: Rotation): Point {
  switch (r) {
    case 90: return { x: 1 - pt.y, y: pt.x };
    case 180: return { x: 1 - pt.x, y: 1 - pt.y };
    case 270: return { x: pt.y, y: 1 - pt.x };
    default: return { x: pt.x, y: pt.y };
  }
}

/** Inverse of sourceToView. */
export function viewToSource(pt: Point, r: Rotation): Point {
  switch (r) {
    case 90: return { x: pt.y, y: 1 - pt.x };
    case 180: return { x: 1 - pt.x, y: 1 - pt.y };
    case 270: return { x: 1 - pt.y, y: pt.x };
    default: return { x: pt.x, y: pt.y };
  }
}

export function quadSourceToView(q: Quad, r: Rotation): Quad {
  return fromPoints(toPoints(q).map(p => sourceToView(p, r)));
}

export function quadViewToSource(q: Quad, r: Rotation): Quad {
  return fromPoints(toPoints(q).map(p => viewToSource(p, r)));
}

/**
 * The corner list for the output turned clockwise by `deg`: the new top-left
 * is the old bottom-left (90°), and so on. The corners themselves don't move.
 */
export function rotateCornerOrder(q: Quad, deg: number): Quad {
  const steps = normRotation(deg) / 90;
  const p = toPoints(q);
  return fromPoints([0, 1, 2, 3].map(i => p[(i + 4 - steps) % 4]));
}

/** The geometry after turning the finished page clockwise by `deg` (90 = right, -90 = left). */
export function rotateGeometry(g: PageGeometry, deg: number): PageGeometry {
  return { quad: rotateCornerOrder(g.quad, deg), rotation: normRotation(g.rotation + deg) };
}

/** The image's size once turned by `r` (width and height swap at 90/270). */
export function rotatedSize(w: number, h: number, r: Rotation): { w: number; h: number } {
  return r === 90 || r === 270 ? { w: h, h: w } : { w, h };
}

// ── Screen mapping (aspect-fit) ─────────────────────────────────────────────

/** Where an image (natural w×h, turned by r) sits when aspect-fitted in a box. */
export type Fit = { scale: number; offX: number; offY: number; dispW: number; dispH: number };

export function fitRect(boxW: number, boxH: number, imgW: number, imgH: number, r: Rotation = 0): Fit | null {
  if (!(boxW > 0 && boxH > 0 && imgW > 0 && imgH > 0)) return null;
  const { w, h } = rotatedSize(imgW, imgH, r);
  const scale = Math.min(boxW / w, boxH / h);
  const dispW = w * scale;
  const dispH = h * scale;
  return { scale, dispW, dispH, offX: (boxW - dispW) / 2, offY: (boxH - dispH) / 2 };
}

export function viewToScreen(pt: Point, f: Fit): Point {
  return { x: f.offX + pt.x * f.dispW, y: f.offY + pt.y * f.dispH };
}

/** Screen point → view-frame point, clamped to the image. */
export function screenToView(pt: Point, f: Fit): Point {
  return { x: clamp01((pt.x - f.offX) / f.dispW), y: clamp01((pt.y - f.offY) / f.dispH) };
}

// ── Editing ─────────────────────────────────────────────────────────────────

/** Moves corner `i` (0..3) of a view-frame quad by (dx, dy), clamped to the image. */
export function moveCorner(q: Quad, i: number, dx: number, dy: number): Quad {
  const out = [...q];
  out[i * 2] = clamp01(q[i * 2] + dx);
  out[i * 2 + 1] = clamp01(q[i * 2 + 1] + dy);
  return out;
}

/**
 * Moves edge `i` (corner i → corner i+1) by (dx, dy). Both corners move by the
 * same amount; the shift is reduced so neither leaves the image (the edge
 * keeps its shape rather than one end sticking to the border).
 */
export function moveEdge(q: Quad, i: number, dx: number, dy: number): Quad {
  const a = i, b = (i + 1) % 4;
  const xs = [q[a * 2], q[b * 2]];
  const ys = [q[a * 2 + 1], q[b * 2 + 1]];
  const ddx = dx < 0 ? Math.max(dx, -Math.min(...xs)) : Math.min(dx, 1 - Math.max(...xs));
  const ddy = dy < 0 ? Math.max(dy, -Math.min(...ys)) : Math.min(dy, 1 - Math.max(...ys));
  const out = [...q];
  out[a * 2] = xs[0] + ddx;
  out[b * 2] = xs[1] + ddx;
  out[a * 2 + 1] = ys[0] + ddy;
  out[b * 2 + 1] = ys[1] + ddy;
  return clampQuad(out);
}

/** Midpoint of edge `i` (corner i → corner i+1). */
export function edgeMidpoint(q: Quad, i: number): Point {
  const b = (i + 1) % 4;
  return { x: (q[i * 2] + q[b * 2]) / 2, y: (q[i * 2 + 1] + q[b * 2 + 1]) / 2 };
}

/**
 * Output size (px) a perspective warp of `q` on a w×h image should have:
 * the average of opposite edge lengths, which keeps the page's proportions.
 */
export function warpOutputSize(q: Quad, w: number, h: number): { width: number; height: number } {
  const p = toPoints(q).map(pt => ({ x: pt.x * w, y: pt.y * h }));
  const d = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  return {
    width: Math.max(1, Math.round((d(p[0], p[1]) + d(p[3], p[2])) / 2)),
    height: Math.max(1, Math.round((d(p[0], p[3]) + d(p[1], p[2])) / 2)),
  };
}

/** Axis-aligned bounds of a quad (normalised), for fallbacks without a perspective warp. */
export function quadBounds(q: Quad): { x: number; y: number; w: number; h: number } {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** True when two geometries describe the same crop (within `eps`). */
export function sameGeometry(a: PageGeometry, b: PageGeometry, eps = 1e-4): boolean {
  return a.rotation === b.rotation && a.quad.length === 8 && b.quad.length === 8
    && a.quad.every((v, i) => Math.abs(v - b.quad[i]) <= eps);
}
