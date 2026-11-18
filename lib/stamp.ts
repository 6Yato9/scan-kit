// lib/stamp.ts
// Overlay markup for the Watermark, Timestamp and Sign tools. Each builder
// returns HTML for lib/pdf.ts generatePdf's `overlayHtml`: it is drawn in a box
// that exactly covers one page image, positioned with percentages, sized with
// the `--pt` CSS variable (one PDF point). The same numbers drive the on-screen
// previews, so what the user sees is what lands in the PDF.
import { formatDate, formatDateTime } from './format';
import { escapeHtml } from './pdf';
import { BAKE_MAX_PIXELS } from './bake-html';

const FONT = 'Helvetica,Arial,sans-serif';

// ── Watermark ────────────────────────────────────────────────────────────────

export type WatermarkStyle = 'diagonal' | 'center' | 'footer';
export type StampColor = 'gray' | 'red' | 'blue';

/**
 * Ink colours. They double as the on-screen swatches, so gray is a true mid
 * gray: near-black read as "black" on the swatch and vanished on a dark card,
 * while on the page (at watermark opacity) it printed as light gray anyway.
 */
export const STAMP_RGB: Record<StampColor, [number, number, number]> = {
  gray: [112, 112, 112],
  red: [200, 30, 30],
  blue: [20, 80, 190],
};

/**
 * Watermark font size as a fraction of the page width, so long text still
 * fits across the page and short text doesn't become enormous.
 */
export function watermarkFontFraction(text: string, style: WatermarkStyle): number {
  if (style === 'footer') return 0.022;
  const len = Math.max(1, [...text.trim()].length);
  const span = style === 'diagonal' ? 1.05 : 0.85; // usable line length, in page widths
  return Math.min(0.16, Math.max(0.03, span / (len * 0.62)));
}

/** Tuned with the mid-gray ink so a gray watermark prints at the same light gray as before. */
export function watermarkOpacity(style: WatermarkStyle): number {
  return style === 'footer' ? 0.85 : 0.28;
}

export const WATERMARK_ANGLE = -35;

export function watermarkOverlay(
  text: string,
  style: WatermarkStyle,
  color: StampColor,
  pageWidthPt: number,
): string {
  const [r, g, b] = STAMP_RGB[color];
  const fontPt = watermarkFontFraction(text, style) * pageWidthPt;
  const ink = `rgba(${r},${g},${b},${watermarkOpacity(style)})`;
  const label = escapeHtml(text.trim());
  const common = `font:700 calc(${fontPt.toFixed(2)} * var(--pt)) ${FONT};color:${ink};white-space:nowrap;letter-spacing:0.04em`;
  if (style === 'footer') {
    return `<div style="position:absolute;left:0;right:0;bottom:3%;text-align:center;${common}">${label}</div>`;
  }
  const rotate = style === 'diagonal' ? `transform:rotate(${WATERMARK_ANGLE}deg);` : '';
  return (
    `<div style="position:absolute;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;overflow:hidden">` +
    `<div style="${rotate}${common}">${label}</div></div>`
  );
}

// ── Timestamp ────────────────────────────────────────────────────────────────

export type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

/**
 * Inset from the page edges, as a fraction of the page width. The stamp lives
 * in the page's outer margin: about 10pt from the edge and about 10pt type on
 * a Letter or A4 page, so its whole box (≈3% of the width) stays clear of a
 * border or text that starts 5% in, where the old 3% inset and 2.4% type
 * drew it across the page's border line.
 */
export const CORNER_INSET = 0.016;
export const TIMESTAMP_FONT_FRACTION = 0.016;

export function timestampOverlay(text: string, corner: Corner, pageWidthPt: number): string {
  const fontPt = TIMESTAMP_FONT_FRACTION * pageWidthPt;
  const inset = `${(CORNER_INSET * 100).toFixed(2)}%`;
  const [v, h] = corner.split('-') as ['top' | 'bottom', 'left' | 'right'];
  // Percent insets on top/bottom refer to the box HEIGHT; use points instead so
  // the gap matches the horizontal one.
  const insetPt = (CORNER_INSET * pageWidthPt).toFixed(2);
  return (
    `<div style="position:absolute;${v}:calc(${insetPt} * var(--pt));${h}:${inset};` +
    `padding:calc(${(fontPt * 0.35).toFixed(2)} * var(--pt)) calc(${(fontPt * 0.6).toFixed(2)} * var(--pt));` +
    `background:rgba(255,255,255,0.85);border-radius:calc(${(fontPt * 0.3).toFixed(2)} * var(--pt));` +
    `font:500 calc(${fontPt.toFixed(2)} * var(--pt)) ${FONT};color:#222;white-space:nowrap">` +
    `${escapeHtml(text)}</div>`
  );
}

export type TimestampFormat = 'date' | 'datetime';

/** The stamp text, in the device's date and time format (see lib/format.ts). */
export function formatStamp(ts: number, format: TimestampFormat, locale?: string): string {
  return format === 'date' ? formatDate(ts, locale) : formatDateTime(ts, locale);
}

// ── Signature ────────────────────────────────────────────────────────────────

/** Signature image placement as fractions (0..1) of the page image box. */
export type Placement = { x: number; y: number; w: number };

export type Signature = { dataUri: string; width: number; height: number };

/** Pen colour the signature is drawn in on the page. */
export type SignatureInk = 'black' | 'blue';

/**
 * The ink each pen colour lands on the page in. Black is the colour the pad
 * already saves the strokes in (Ink.signature in lib/theme.ts), so it needs
 * no recolouring; blue is a ballpoint blue, dark enough to read as ink on a
 * scan rather than as a highlight.
 */
export const SIGNATURE_INK: Record<SignatureInk, string> = {
  black: '#111111',
  blue: '#1d3f9e',
};

/** Signature height as a fraction of the page height, for a page of the given aspect (h / w). */
export function signatureHeightFraction(sig: Signature, placement: Placement, pageAspect: number): number {
  return (placement.w * (sig.height / sig.width)) / pageAspect;
}

/**
 * Keeps the signature fully on the page: no wider than the page, no taller
 * than it (a placement made on a landscape page, or for a wider signature,
 * can be too big for a portrait one), and moved in from any edge it crosses.
 */
export function clampPlacement(sig: Signature, p: Placement, pageAspect: number): Placement {
  const ratio = sig.width > 0 ? sig.height / sig.width : 1;
  const maxW = Math.min(1, ratio > 0 ? pageAspect / ratio : 1);
  const w = Math.min(Math.max(0, p.w), maxW);
  const hFrac = signatureHeightFraction(sig, { ...p, w }, pageAspect);
  return {
    w,
    x: Math.min(Math.max(0, p.x), Math.max(0, 1 - w)),
    y: Math.min(Math.max(0, p.y), Math.max(0, 1 - hFrac)),
  };
}

/** Default spot: bottom right, clear of the edge. */
export function defaultPlacement(sig: Signature, pageAspect: number, w = 0.32): Placement {
  const hFrac = signatureHeightFraction(sig, { x: 0, y: 0, w }, pageAspect);
  return { w, x: 1 - w - 0.06, y: Math.max(0, 1 - hFrac - 0.05) };
}

export function signatureOverlay(sig: Signature, p: Placement): string {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig.dataUri)) return '';
  const pct = (n: number) => `${(n * 100).toFixed(3)}%`;
  return `<img src="${sig.dataUri}" style="position:absolute;left:${pct(p.x)};top:${pct(p.y)};width:${pct(p.w)};height:auto" />`;
}

// ── Burned into the page (edit in place) ────────────────────────────────────
//
// Sign, Watermark and Timestamp normally change the document itself: the mark
// is drawn into the page JPEG (and its unfiltered `.orig` shadow, so a later
// filter change keeps it), the pages stay images, searchable and re-filterable
// (lib/page-stamp.ts). The drawing happens on a canvas in a hidden WebView
// (components/page-stamper.tsx), with the same geometry as the HTML overlays
// above and the on-screen previews: every size is a fraction of the page width.

/** What to draw on a page, in page-relative terms. */
export type StampSpec =
  | { kind: 'signature'; signature: Signature; placement: Placement; ink?: SignatureInk }
  | { kind: 'watermark'; text: string; style: WatermarkStyle; color: StampColor }
  | {
      kind: 'timestamp';
      text: string;
      corner: Corner;
      /**
       * Dragged position, between the page's inset edges (0 = left / top,
       * 1 = right / bottom; lib/placement.ts). Absent: the corner's.
       */
      anchor?: { x: number; y: number };
    }
  | {
      kind: 'redact';
      /** Opaque black boxes, each as fractions (0..1) of the page width / height. */
      boxes: RedactRect[];
    };

/** A redaction box as fractions (0..1) of the page: x, w of the width; y, h of the height. */
export type RedactRect = { x: number; y: number; w: number; h: number };

/** The fill a redaction is burned in with: pure black, fully opaque. */
export const REDACT_FILL = '#000000';

/**
 * The boxes clamped to the page, with empty or invalid ones dropped. A box
 * only ever grows outwards to a whole pixel when drawn (redactPixelRect), so
 * what the user covered is always covered.
 */
export function cleanRedactRects(boxes: readonly RedactRect[]): RedactRect[] {
  const out: RedactRect[] = [];
  for (const b of boxes) {
    if (!b || ![b.x, b.y, b.w, b.h].every(n => typeof n === 'number' && Number.isFinite(n))) continue;
    const x0 = Math.min(1, Math.max(0, b.x));
    const y0 = Math.min(1, Math.max(0, b.y));
    const x1 = Math.min(1, Math.max(0, b.x + b.w));
    const y1 = Math.min(1, Math.max(0, b.y + b.h));
    if (x1 - x0 <= 0 || y1 - y0 <= 0) continue;
    out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return out;
}

/**
 * The pixels a box covers on a canvas `width` × `height`: rounded OUTWARD to
 * whole pixels (floor the near edges, ceil the far ones), so a box never
 * leaves a sliver of a glyph uncovered at its edge.
 */
export function redactPixelRect(r: RedactRect, width: number, height: number): { x: number; y: number; w: number; h: number } {
  // The epsilon keeps float noise (0.1 + 0.2 = 0.30000000000000004) from
  // adding a pixel; real fractions of a pixel still round outward.
  const x0 = Math.max(0, Math.floor(r.x * width + 1e-6));
  const y0 = Math.max(0, Math.floor(r.y * height + 1e-6));
  const x1 = Math.min(width, Math.ceil((r.x + r.w) * width - 1e-6));
  const y1 = Math.min(height, Math.ceil((r.y + r.h) * height - 1e-6));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * The spec with every number the canvas needs worked out, so the canvas code
 * stays a dumb painter and the geometry is unit-tested here. Fractions are of
 * the page width unless named otherwise.
 */
export type ResolvedStamp =
  | {
      kind: 'signature';
      x: number;
      y: number;
      w: number;
      /** Ink to recolour the strokes to; null keeps them as drawn (black). */
      tint: string | null;
    }
  | {
      kind: 'watermark';
      text: string;
      layout: 'rotated' | 'center' | 'footer';
      angle: number;
      fontFrac: number;
      ink: string;
      /** Footer only: the line's bottom edge, as a fraction of the page HEIGHT. */
      bottomFracOfHeight: number;
    }
  | {
      kind: 'timestamp';
      text: string;
      corner: Corner;
      /** 0..1 between the inset edges, see StampSpec. */
      ax: number;
      ay: number;
      fontFrac: number;
      insetFrac: number;
      padV: number;
      padH: number;
      radius: number;
      ink: string;
      bg: string;
    }
  | { kind: 'redact'; rects: RedactRect[]; fill: string };

/** Matches Ink.stampText / Ink.stampBg in lib/theme.ts and timestampOverlay above. */
const STAMP_TEXT = '#222222';
const STAMP_BG = 'rgba(255,255,255,0.85)';

export function resolveStamp(spec: StampSpec): ResolvedStamp {
  if (spec.kind === 'redact') {
    return { kind: 'redact', rects: cleanRedactRects(spec.boxes), fill: REDACT_FILL };
  }
  if (spec.kind === 'signature') {
    const ink = spec.ink ?? 'black';
    return {
      kind: 'signature',
      x: spec.placement.x,
      y: spec.placement.y,
      w: spec.placement.w,
      tint: ink === 'black' ? null : SIGNATURE_INK[ink],
    };
  }
  if (spec.kind === 'watermark') {
    const [r, g, b] = STAMP_RGB[spec.color];
    return {
      kind: 'watermark',
      text: spec.text.trim(),
      layout: spec.style === 'diagonal' ? 'rotated' : spec.style,
      angle: spec.style === 'diagonal' ? WATERMARK_ANGLE : 0,
      fontFrac: watermarkFontFraction(spec.text, spec.style),
      ink: `rgba(${r},${g},${b},${watermarkOpacity(spec.style)})`,
      bottomFracOfHeight: 0.97,
    };
  }
  const [v, h] = spec.corner.split('-');
  const unit = (n: unknown, fallback: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback);
  return {
    kind: 'timestamp',
    text: spec.text,
    corner: spec.corner,
    ax: unit(spec.anchor?.x, h === 'right' ? 1 : 0),
    ay: unit(spec.anchor?.y, v === 'bottom' ? 1 : 0),
    fontFrac: TIMESTAMP_FONT_FRACTION,
    insetFrac: CORNER_INSET,
    padV: 0.35,
    padH: 0.6,
    radius: 0.3,
    ink: STAMP_TEXT,
    bg: STAMP_BG,
  };
}

/** True when the spec has something to draw (a watermark needs text, a signature a PNG). */
export function stampIsDrawable(spec: StampSpec): boolean {
  if (spec.kind === 'redact') return cleanRedactRects(spec.boxes).length > 0;
  if (spec.kind === 'watermark') return spec.text.trim().length > 0;
  if (spec.kind === 'timestamp') return spec.text.trim().length > 0;
  return /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(spec.signature.dataUri) && spec.placement.w > 0;
}

/**
 * Canvas painter for a ResolvedStamp, as page JavaScript. `drawStamp(ctx, w,
 * h, s, sig)` paints onto a canvas of w × h pixels that already holds the page;
 * `sig` is the loaded signature (an <img> or a canvas; signatures only).
 *
 * A signature is kept whole on the page even when the placement was made on a
 * page of another shape ("Sign every page" across portrait and landscape
 * pages): it is moved in from an edge it would cross, never cut off.
 */
export const STAMP_CANVAS_JS = `
var STAMP_FONT = 'Helvetica, Arial, sans-serif';
function spacedWidth(ctx, chars, ls) {
  var t = 0;
  for (var i = 0; i < chars.length; i++) t += ctx.measureText(chars[i]).width + ls;
  return t;
}
function drawSpaced(ctx, chars, x, y, ls) {
  for (var i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], x, y);
    x += ctx.measureText(chars[i]).width + ls;
  }
}
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
function sigSize(sig) {
  return { w: sig.naturalWidth || sig.width, h: sig.naturalHeight || sig.height };
}
function redactRect(r, w, h) {
  var x0 = Math.max(0, Math.floor(r.x * w + 1e-6)), y0 = Math.max(0, Math.floor(r.y * h + 1e-6));
  var x1 = Math.min(w, Math.ceil((r.x + r.w) * w - 1e-6)), y1 = Math.min(h, Math.ceil((r.y + r.h) * h - 1e-6));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}
function drawStamp(ctx, w, h, s, sig) {
  ctx.save();
  if (s.kind === 'redact') {
    // Opaque, no blending, no smoothing: the pixels under a box are replaced.
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = s.fill;
    for (var ri = 0; ri < s.rects.length; ri++) {
      var px = redactRect(s.rects[ri], w, h);
      if (px.w > 0 && px.h > 0) ctx.fillRect(px.x, px.y, px.w, px.h);
    }
  } else if (s.kind === 'signature') {
    var n = sigSize(sig);
    var sw = Math.min(s.w * w, w);
    var sh = sw * (n.h / n.w);
    if (sh > h) { sh = h; sw = sh * (n.w / n.h); }
    var sx = Math.min(Math.max(0, s.x * w), w - sw);
    var sy = Math.min(Math.max(0, s.y * h), h - sh);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sig, sx, sy, sw, sh);
  } else if (s.kind === 'watermark') {
    var f = s.fontFrac * w;
    var ls = 0.04 * f;
    var chars = Array.from(s.text);
    ctx.font = '700 ' + f + 'px ' + STAMP_FONT;
    ctx.fillStyle = s.ink;
    ctx.textBaseline = 'middle';
    var tw = spacedWidth(ctx, chars, ls);
    if (s.layout === 'footer') {
      var lh = f * 1.15;
      drawSpaced(ctx, chars, (w - tw) / 2, s.bottomFracOfHeight * h - lh / 2, ls);
    } else {
      ctx.translate(w / 2, h / 2);
      if (s.angle) ctx.rotate(s.angle * Math.PI / 180);
      drawSpaced(ctx, chars, -tw / 2, 0, ls);
    }
  } else if (s.kind === 'timestamp') {
    var f2 = s.fontFrac * w;
    var inset = s.insetFrac * w;
    ctx.font = '500 ' + f2 + 'px ' + STAMP_FONT;
    var bw = ctx.measureText(s.text).width + 2 * s.padH * f2;
    var bh = f2 * 1.15 + 2 * s.padV * f2;
    // Between the inset edges: 0 = left / top, 1 = right / bottom (the corners).
    var bx = inset + s.ax * Math.max(0, w - 2 * inset - bw);
    var by = inset + s.ay * Math.max(0, h - 2 * inset - bh);
    ctx.fillStyle = s.bg;
    roundRect(ctx, bx, by, bw, bh, s.radius * f2);
    ctx.fill();
    ctx.fillStyle = s.ink;
    ctx.textBaseline = 'middle';
    ctx.fillText(s.text, bx + s.padH * f2, by + bh / 2);
  }
  ctx.restore();
}
`;

/** JSON for inline <script>: "</script>" in user text can't end the script early. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * Canvas sizes the stamp tries, largest first, in pixels. The first is the
 * filter bake's cap (lib/bake-html.ts BAKE_MAX_PIXELS, under iOS WebKit's
 * 16,777,216-px canvas limit), so a page the app can filter can be stamped.
 * Pages are stored at ≤ 4096 px on the long edge (12.6 MP at most), so that
 * normally means full size. If WebKit can't give a canvas that big — on a
 * phone it shares a smaller memory budget across every canvas in the
 * process, and an over-budget canvas has no context or encodes to "data:," —
 * the page is drawn again smaller rather than failing.
 */
export const STAMP_PIXEL_STEPS = [BAKE_MAX_PIXELS, 8_000_000, 4_000_000];
export const STAMP_MAX_PIXELS = STAMP_PIXEL_STEPS[0];

/**
 * What the stamp page posts back, in order:
 * - `STAMP_STEP:<what>` while it works (the host's "still alive" signal);
 * - `STAMP_PAGE:<jpeg data URL>`, then `STAMP_ORIG:<jpeg data URL>` when there
 *   is a shadow — one at a time, so only one page's pixels are ever in flight;
 * - `STAMP_DONE:{"scaled":bool}` — scaled: drawn below full size to fit memory;
 * - or `STAMP_ERROR:<code>`: load-page, load-orig, load-signature, empty,
 *   canvas (no canvas that size), encode (canvas wouldn't encode), or
 *   script:<message>.
 */
export type StampMessage =
  | { type: 'step'; what: string }
  | { type: 'page'; data: string }
  | { type: 'orig'; data: string }
  | { type: 'done'; scaled: boolean }
  | { type: 'error'; code: string }
  | null;

export function parseStampMessage(data: string): StampMessage {
  if (data.startsWith('STAMP_STEP:')) return { type: 'step', what: data.slice(11) };
  if (data.startsWith('STAMP_PAGE:')) return { type: 'page', data: data.slice(11) };
  if (data.startsWith('STAMP_ORIG:')) return { type: 'orig', data: data.slice(11) };
  if (data.startsWith('STAMP_DONE:')) {
    let scaled = false;
    try { scaled = !!(JSON.parse(data.slice(11)) as { scaled?: boolean }).scaled; } catch {}
    return { type: 'done', scaled };
  }
  if (data.startsWith('STAMP_ERROR:')) return { type: 'error', code: data.slice(12) || 'unknown' };
  return null;
}

/**
 * HTML that draws `spec` onto the page image at `pageSrc` and, when given, its
 * `.orig` shadow at `origSrc`, each at its natural size (see
 * STAMP_PIXEL_STEPS), posting the results as StampMessages.
 *
 * Built for a phone's memory, not the simulator's: the signature is decoded
 * once (and recoloured once); then the page is decoded, drawn, encoded and
 * posted, and its canvas and image are released (a canvas only gives its
 * memory back when sized to 0 × 0) before the shadow is even loaded. So at
 * most one page image and one canvas are alive at a time, where drawing both
 * at once used to hold two of each.
 *
 * Must be loaded through components/local-webview.tsx (file access).
 */
export function buildStampHtml(pageSrc: string, origSrc: string | null, spec: StampSpec): string {
  const resolved = resolveStamp(spec);
  const sigSrc = spec.kind === 'signature' ? spec.signature.dataUri : null;
  return `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#000;">
<script>
var SPEC = ${scriptJson(resolved)};
var SOURCES = ${scriptJson({ page: pageSrc, orig: origSrc, sig: sigSrc })};
var STEPS = ${scriptJson(STAMP_PIXEL_STEPS)};
var scaled = false;
function post(msg) {
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(msg);
  else setTimeout(function () { post(msg); }, 30);
}
function fail(code) { var e = new Error(code); e.stampCode = code; return e; }
${STAMP_CANVAS_JS}
function load(src, code) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function () {
      if (!img.naturalWidth || !img.naturalHeight) { reject(fail(code === 'load-signature' ? code : 'empty')); return; }
      resolve(img);
    };
    img.onerror = function () { reject(fail(code)); };
    img.src = src;
  });
}
function release(c) { if (c) { c.width = 0; c.height = 0; } }
function drop(img) { if (img) { img.onload = null; img.onerror = null; img.removeAttribute('src'); } }
function fit(w, h, cap) {
  if (w * h <= cap) return { w: w, h: h };
  var k = Math.sqrt(cap / (w * h));
  return { w: Math.max(1, Math.floor(w * k)), h: Math.max(1, Math.floor(h * k)) };
}
// The signature in its ink (a small canvas), once per job; black is drawn
// as saved.
function inked(sig) {
  if (!sig || !SPEC.tint) return sig;
  var c = document.createElement('canvas');
  c.width = sig.naturalWidth; c.height = sig.naturalHeight;
  var x = c.getContext('2d');
  if (!x) return sig;
  x.drawImage(sig, 0, 0);
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = SPEC.tint;
  x.fillRect(0, 0, c.width, c.height);
  return c;
}
// One page at the largest size this WebKit will give a canvas for.
function render(base, sig) {
  var last = 'canvas';
  for (var i = 0; i < STEPS.length; i++) {
    var size = fit(base.naturalWidth, base.naturalHeight, STEPS[i]);
    if (i > 0 && size.w === base.naturalWidth && size.h === base.naturalHeight) continue;
    var c = document.createElement('canvas');
    c.width = size.w; c.height = size.h;
    var ctx = c.getContext('2d');
    if (!ctx) { release(c); last = 'canvas'; continue; }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(base, 0, 0, size.w, size.h);
    drawStamp(ctx, size.w, size.h, SPEC, sig);
    var out = c.toDataURL('image/jpeg', 0.92);
    release(c);
    // An over-budget canvas encodes to "data:," instead of throwing.
    if (out.indexOf('data:image/jpeg') !== 0) { last = 'encode'; continue; }
    if (size.w < base.naturalWidth) scaled = true;
    return out;
  }
  throw fail(last);
}
function side(src, code, tag, sig) {
  return load(src, code).then(function (img) {
    post('STAMP_STEP:' + tag + '-loaded');
    var out = render(img, sig);
    drop(img);
    post('STAMP_' + tag.toUpperCase() + ':' + out);
  });
}
var sigImg = null;
post('STAMP_STEP:start');
(SOURCES.sig ? load(SOURCES.sig, 'load-signature') : Promise.resolve(null))
  .then(function (s) {
    sigImg = inked(s);
    if (SPEC.kind === 'signature' && !sigImg) throw fail('load-signature');
    return side(SOURCES.page, 'load-page', 'page', sigImg);
  })
  .then(function () { return SOURCES.orig ? side(SOURCES.orig, 'load-orig', 'orig', sigImg) : null; })
  .then(function () { post('STAMP_DONE:' + JSON.stringify({ scaled: scaled })); })
  .catch(function (e) {
    post('STAMP_ERROR:' + (e && e.stampCode ? e.stampCode : 'script:' + (e && e.message ? e.message : 'unknown')));
  });
</script>
</body></html>`;
}
