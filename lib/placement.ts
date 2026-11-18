// lib/placement.ts
// The maths behind placing a mark on a page by hand (components/placement-frame.tsx):
// a box of fixed aspect ratio (the signature) that is dragged by its body,
// resized from any corner with the opposite corner pinned, or pinched around
// its centre — always kept whole on the page and between a minimum and a
// maximum size. Everything here is in preview points; `boxToPlacement` turns
// the result into the page fractions lib/stamp.ts draws with, so what the
// user sees on the preview is exactly what lands in the page.
//
// Also the anchor maths for the timestamp label, which is dragged but not
// resized: its position is stored as where it sits between the page's inset
// edges (0 = left / top edge, 1 = right / bottom edge), so it maps onto any
// page shape and any text width without ever leaving the page.
import type { Placement } from './stamp';

/** A box in preview points; `h / w` is the mark's fixed aspect ratio. */
export type Box = { x: number; y: number; w: number; h: number };
export type Bounds = { width: number; height: number };
export type Handle = 'tl' | 'tr' | 'bl' | 'br';

export const HANDLES: Handle[] = ['tl', 'tr', 'bl', 'br'];

/** Smallest a signature can be made on the preview, in points. */
export const MIN_BOX_POINTS = 44;
/** …and as a fraction of the page width, whichever is bigger. */
export const MIN_BOX_FRACTION = 0.06;

/** The widest the box can be: the page's width, or as wide as fits the page's height. */
export function maxBoxWidth(bounds: Bounds, ratio: number): number {
  if (!(ratio > 0)) return bounds.width;
  return Math.max(0, Math.min(bounds.width, bounds.height / ratio));
}

/** The narrowest the box can be on a preview of `bounds` (never above the widest). */
export function minBoxWidth(bounds: Bounds, ratio: number): number {
  return Math.min(Math.max(MIN_BOX_POINTS, MIN_BOX_FRACTION * bounds.width), maxBoxWidth(bounds, ratio));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Shifts the box (size unchanged) so it lies wholly on the page. */
export function clampBox(b: Box, bounds: Bounds): Box {
  return {
    ...b,
    x: clamp(b.x, 0, Math.max(0, bounds.width - b.w)),
    y: clamp(b.y, 0, Math.max(0, bounds.height - b.h)),
  };
}

/** Dragged by its body by (dx, dy) from where it was when the drag started. */
export function moveBox(start: Box, dx: number, dy: number, bounds: Bounds): Box {
  return clampBox({ ...start, x: start.x + dx, y: start.y + dy }, bounds);
}

/**
 * Dragged by a corner by (dx, dy): the opposite corner stays where it is and
 * the box keeps its shape. The drag is measured along the box's diagonal, so
 * pulling a corner outwards grows it and pushing it in shrinks it, whichever
 * way the finger wanders. The size stops at the page edges, at the minimum
 * and at the maximum.
 */
export function resizeBox(start: Box, handle: Handle, dx: number, dy: number, bounds: Bounds, minW: number): Box {
  const ratio = start.w > 0 ? start.h / start.w : 1;
  const sx = handle === 'tr' || handle === 'br' ? 1 : -1;
  const sy = handle === 'bl' || handle === 'br' ? 1 : -1;
  const len = Math.hypot(start.w, start.h) || 1;
  const along = (dx * sx * start.w + dy * sy * start.h) / len;
  const wanted = start.w * ((len + along) / len);
  // The pinned corner.
  const ax = sx > 0 ? start.x : start.x + start.w;
  const ay = sy > 0 ? start.y : start.y + start.h;
  const roomX = sx > 0 ? bounds.width - ax : ax;
  const roomY = (sy > 0 ? bounds.height - ay : ay) / ratio;
  const upper = Math.max(0, Math.min(roomX, roomY, maxBoxWidth(bounds, ratio)));
  const w = clamp(wanted, Math.min(minW, upper), upper);
  const h = w * ratio;
  return { x: sx > 0 ? ax : ax - w, y: sy > 0 ? ay : ay - h, w, h };
}

/** Pinched by `scale` (1 = as it was) around its centre, then kept on the page. */
export function scaleBox(start: Box, scale: number, bounds: Bounds, minW: number): Box {
  const ratio = start.w > 0 ? start.h / start.w : 1;
  const maxW = maxBoxWidth(bounds, ratio);
  const w = clamp(start.w * (scale > 0 ? scale : 1), Math.min(minW, maxW), maxW);
  const h = w * ratio;
  const cx = start.x + start.w / 2;
  const cy = start.y + start.h / 2;
  return clampBox({ x: cx - w / 2, y: cy - h / 2, w, h }, bounds);
}

/** Centred on a tapped point (preview points), kept on the page. */
export function centerBoxAt(start: Box, px: number, py: number, bounds: Bounds): Box {
  return clampBox({ ...start, x: px - start.w / 2, y: py - start.h / 2 }, bounds);
}

/** Page fractions (what lib/stamp.ts draws with) for a box on a preview of `bounds`. */
export function boxToPlacement(b: Box, bounds: Bounds): Placement {
  if (!(bounds.width > 0) || !(bounds.height > 0)) return { x: 0, y: 0, w: 0 };
  return { x: b.x / bounds.width, y: b.y / bounds.height, w: b.w / bounds.width };
}

/** The box a placement covers on a preview of `bounds`, for a mark of aspect `ratio` (h / w). */
export function placementToBox(p: Placement, ratio: number, bounds: Bounds): Box {
  const w = p.w * bounds.width;
  return { x: p.x * bounds.width, y: p.y * bounds.height, w, h: w * ratio };
}

/**
 * Where a corner's 44-pt touch target sits, relative to the corner point, for
 * a box `w` × `h` points: mostly outside the box, reaching in at most a
 * quarter of the box (and never more than 14 pt), so even a small signature
 * keeps the middle of its body free for dragging. Returns the target's
 * top-left offset from the corner.
 */
export function handleTargetOffset(handle: Handle, w: number, h: number, size = 44): { left: number; top: number } {
  const inX = Math.max(0, Math.min(14, w / 4));
  const inY = Math.max(0, Math.min(14, h / 4));
  const right = handle === 'tr' || handle === 'br';
  const bottom = handle === 'bl' || handle === 'br';
  return {
    left: right ? -inX : -(size - inX),
    top: bottom ? -inY : -(size - inY),
  };
}

// ── Timestamp anchor ────────────────────────────────────────────────────────

/** Where a label sits between the page's inset edges: 0 = left / top, 1 = right / bottom. */
export type Anchor = { x: number; y: number };

/** The anchor of a fixed corner. */
export function cornerAnchor(corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'): Anchor {
  return { x: corner.endsWith('right') ? 1 : 0, y: corner.startsWith('bottom') ? 1 : 0 };
}

/** The label's top-left corner for an anchor, on a page `pageW` × `pageH` with the label `boxW` × `boxH`. */
export function anchorToOrigin(a: Anchor, pageW: number, pageH: number, boxW: number, boxH: number, inset: number): { x: number; y: number } {
  return {
    x: inset + clamp(a.x, 0, 1) * Math.max(0, pageW - 2 * inset - boxW),
    y: inset + clamp(a.y, 0, 1) * Math.max(0, pageH - 2 * inset - boxH),
  };
}

/** Anchor positions a dragged label settles on when it comes close: the edges and the middle. */
const SNAPS = [0, 0.5, 1];
export const ANCHOR_SNAP = 0.06;

/**
 * The anchor for a label whose top-left corner has been dragged to (x, y),
 * snapped to an edge or the middle when within ANCHOR_SNAP of it.
 */
export function originToAnchor(x: number, y: number, pageW: number, pageH: number, boxW: number, boxH: number, inset: number): Anchor {
  const spanX = pageW - 2 * inset - boxW;
  const spanY = pageH - 2 * inset - boxH;
  const ax = spanX > 0 ? clamp((x - inset) / spanX, 0, 1) : 0;
  const ay = spanY > 0 ? clamp((y - inset) / spanY, 0, 1) : 0;
  return { x: snap(ax), y: snap(ay) };
}

function snap(v: number): number {
  for (const s of SNAPS) if (Math.abs(v - s) <= ANCHOR_SNAP) return s;
  return v;
}

/** Same anchor (to a hair): used to tick the haptic only when a snap point is reached. */
export function sameAnchor(a: Anchor, b: Anchor): boolean {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}
