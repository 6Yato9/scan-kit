// lib/camera-layout.ts
// Geometry of the full-screen camera (app/camera.tsx): where the floating
// controls sit, where the captured page appears on screen, and how the
// "flying" thumbnail travels into the stack of captured pages. Pure, so it is
// unit-tested (__tests__/camera-layout.test.ts).
//
// The native preview (modules/vision-ocr DocumentCameraView) fills the whole
// screen and shows the camera frames aspect-FILL: scaled to cover the view,
// centred, the overflow cropped (on an iPhone in portrait the frames are 3:4
// and the screen is taller, so a strip of each side is not shown; the photo
// still holds it). The native view maps its outline with the same rule, so
// the outline stays on the paper; these helpers use it too, for what RN draws.

export type Rect = { x: number; y: number; w: number; h: number };
export type Insets = { top: number; bottom: number; left: number; right: number };

/** Screen edge to the floating controls (the safe area is added). */
export const CAMERA_GUTTER = 16;
/** Height of the top row of floating buttons. */
export const CAMERA_TOP_ROW = 44;
/** Gap between the safe area's top and the top row. */
export const CAMERA_TOP_GAP = 4;
/** Gap between the top row and the status pill. */
export const CAMERA_PILL_GAP = 12;
/** Room the status pill may take (two lines: mode title + status). */
export const CAMERA_PILL_ROOM = 56;
/** Height of the bottom cluster (shutter, stack, Done). */
export const CAMERA_CONTROLS = 104;
/** Minimum gap between the rows and the screen's top / bottom edge (no safe area there, or the status bar hidden on an iPad). */
export const CAMERA_EDGE_MIN = 12;

/** Where an image of `aspect` (width / height) lands when it covers a W x H view (aspect-fill). */
export function aspectFillRect(aspect: number, W: number, H: number): Rect {
  if (!(aspect > 0) || !(W > 0) || !(H > 0)) return { x: 0, y: 0, w: Math.max(0, W), h: Math.max(0, H) };
  const s = Math.max(W / aspect, H);
  const h = s;
  const w = s * aspect;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

/**
 * The on-screen bounding box of a page outline (normalised, upright, top-left
 * origin: [x0,y0, … x3,y3]) in an image of `aspect` shown aspect-fill in a
 * W x H view, clipped to the view. Null when there is no outline or what is
 * left on screen is smaller than `minSize` either way.
 */
export function quadScreenRect(
  quad: readonly number[] | null | undefined,
  aspect: number,
  W: number,
  H: number,
  minSize = 48,
): Rect | null {
  if (!quad || quad.length < 8 || quad.some(v => !Number.isFinite(v))) return null;
  const fill = aspectFillRect(aspect, W, H);
  const xs = [quad[0], quad[2], quad[4], quad[6]].map(v => fill.x + v * fill.w);
  const ys = [quad[1], quad[3], quad[5], quad[7]].map(v => fill.y + v * fill.h);
  const x0 = Math.max(0, Math.min(...xs));
  const x1 = Math.min(W, Math.max(...xs));
  const y0 = Math.max(0, Math.min(...ys));
  const y1 = Math.min(H, Math.max(...ys));
  if (x1 - x0 < minSize || y1 - y0 < minSize) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Uniform scale + offset that shrinks `from` into `to` (centre on centre,
 * fitting inside it), for a transform applied around `from`'s centre.
 */
export function flyTransform(from: Rect, to: Rect): { dx: number; dy: number; scale: number } {
  const scale = from.w > 0 && from.h > 0 ? Math.min(to.w / from.w, to.h / from.h) : 1;
  return {
    dx: to.x + to.w / 2 - (from.x + from.w / 2),
    dy: to.y + to.h / 2 - (from.y + from.h / 2),
    scale,
  };
}

export type CameraChromeLayout = {
  /** Top of the floating top row. */
  topRowY: number;
  /** Top of the status pill. */
  pillY: number;
  /** Top of the bottom cluster (CAMERA_CONTROLS tall). */
  controlsY: number;
  /** Left / right padding of both rows (gutter + safe area). */
  padLeft: number;
  padRight: number;
  /** Free middle of the screen, between the pill and the bottom cluster (the card guide is centred in it). */
  middle: Rect;
};

/** Where the floating chrome goes on a W x H screen with these safe-area insets. */
export function cameraChromeLayout(W: number, H: number, insets: Insets): CameraChromeLayout {
  const topRowY = Math.max(insets.top, CAMERA_EDGE_MIN) + CAMERA_TOP_GAP;
  const pillY = topRowY + CAMERA_TOP_ROW + CAMERA_PILL_GAP;
  const controlsY = H - Math.max(insets.bottom, CAMERA_EDGE_MIN) - CAMERA_CONTROLS;
  const padLeft = CAMERA_GUTTER + insets.left;
  const padRight = CAMERA_GUTTER + insets.right;
  const middleTop = pillY + CAMERA_PILL_ROOM;
  return {
    topRowY,
    pillY,
    controlsY,
    padLeft,
    padRight,
    middle: { x: padLeft, y: middleTop, w: Math.max(0, W - padLeft - padRight), h: Math.max(0, controlsY - middleTop) },
  };
}

/** A frame of `aspect` (width / height) centred in `area`, at most `fraction` of it either way. */
export function centredFrame(area: Rect, aspect: number, fraction = 0.85): Rect {
  const w = Math.max(0, Math.min(area.w * fraction, area.h * fraction * aspect));
  const h = aspect > 0 ? w / aspect : 0;
  return { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h };
}
