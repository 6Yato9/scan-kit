// lib/stamp.ts
// Overlay markup for the Watermark, Timestamp and Sign tools. Each builder
// returns HTML for lib/pdf.ts generatePdf's `overlayHtml`: it is drawn in a box
// that exactly covers one page image, positioned with percentages, sized with
// the `--pt` CSS variable (one PDF point). The same numbers drive the on-screen
// previews, so what the user sees is what lands in the PDF.
import { formatDate, formatDateTime } from './format';
import { escapeHtml } from './pdf';

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

/** Signature height as a fraction of the page height, for a page of the given aspect (h / w). */
export function signatureHeightFraction(sig: Signature, placement: Placement, pageAspect: number): number {
  return (placement.w * (sig.height / sig.width)) / pageAspect;
}

/** Keeps the signature fully on the page. */
export function clampPlacement(sig: Signature, p: Placement, pageAspect: number): Placement {
  const hFrac = signatureHeightFraction(sig, p, pageAspect);
  return {
    w: p.w,
    x: Math.min(Math.max(0, p.x), Math.max(0, 1 - p.w)),
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
  | { kind: 'signature'; signature: Signature; placement: Placement }
  | { kind: 'watermark'; text: string; style: WatermarkStyle; color: StampColor }
  | { kind: 'timestamp'; text: string; corner: Corner };

/**
 * The spec with every number the canvas needs worked out, so the canvas code
 * stays a dumb painter and the geometry is unit-tested here. Fractions are of
 * the page width unless named otherwise.
 */
export type ResolvedStamp =
  | { kind: 'signature'; x: number; y: number; w: number }
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
      fontFrac: number;
      insetFrac: number;
      padV: number;
      padH: number;
      radius: number;
      ink: string;
      bg: string;
    };

/** Matches Ink.stampText / Ink.stampBg in lib/theme.ts and timestampOverlay above. */
const STAMP_TEXT = '#222222';
const STAMP_BG = 'rgba(255,255,255,0.85)';

export function resolveStamp(spec: StampSpec): ResolvedStamp {
  if (spec.kind === 'signature') {
    return { kind: 'signature', x: spec.placement.x, y: spec.placement.y, w: spec.placement.w };
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
  return {
    kind: 'timestamp',
    text: spec.text,
    corner: spec.corner,
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
  if (spec.kind === 'watermark') return spec.text.trim().length > 0;
  if (spec.kind === 'timestamp') return spec.text.trim().length > 0;
  return /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(spec.signature.dataUri) && spec.placement.w > 0;
}

/**
 * Canvas painter for a ResolvedStamp, as page JavaScript. `drawStamp(ctx, w,
 * h, s, sig)` paints onto a canvas of w × h pixels that already holds the page;
 * `sig` is the loaded signature <img> (signatures only).
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
function drawStamp(ctx, w, h, s, sig) {
  ctx.save();
  if (s.kind === 'signature') {
    var sw = s.w * w;
    var sh = sw * (sig.naturalHeight / sig.naturalWidth);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sig, s.x * w, s.y * h, sw, sh);
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
    var parts = s.corner.split('-');
    var bx = parts[1] === 'left' ? inset : w - inset - bw;
    var by = parts[0] === 'top' ? inset : h - inset - bh;
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

/** Largest canvas the stamp draws to; see lib/bake-html.ts BAKE_MAX_PIXELS. */
export const STAMP_MAX_PIXELS = 16_000_000;

/**
 * HTML that draws `spec` onto the page image at `pageSrc` and, when given, its
 * `.orig` shadow at `origSrc`, each at its natural size, and posts back
 * `STAMP:{"page":"data:image/jpeg…","orig":…|null}` (or `STAMP_ERROR:…`).
 * The host must allow file access exactly like the filter baker does.
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
var MAX_PIXELS = ${STAMP_MAX_PIXELS};
function post(msg) {
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(msg);
  else setTimeout(function () { post(msg); }, 30);
}
${STAMP_CANVAS_JS}
function load(src) {
  return new Promise(function (resolve, reject) {
    if (!src) { resolve(null); return; }
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function () { resolve(img); };
    img.onerror = function () { reject(new Error('load')); };
    img.src = src;
  });
}
function render(base, sig) {
  var w = base.naturalWidth, h = base.naturalHeight;
  if (!w || !h) throw new Error('empty');
  if (w * h > MAX_PIXELS) {
    var k = Math.sqrt(MAX_PIXELS / (w * h));
    w = Math.max(1, Math.floor(w * k)); h = Math.max(1, Math.floor(h * k));
  }
  var c = document.createElement('canvas');
  c.width = w; c.height = h;
  var ctx = c.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(base, 0, 0, w, h);
  drawStamp(ctx, w, h, SPEC, sig);
  var out = c.toDataURL('image/jpeg', 0.92);
  if (out.indexOf('data:image/jpeg') !== 0) throw new Error('encode');
  return out;
}
Promise.all([load(SOURCES.page), load(SOURCES.orig).catch(function () { return null; }), load(SOURCES.sig)])
  .then(function (imgs) {
    if (SPEC.kind === 'signature' && !(imgs[2] && imgs[2].naturalWidth)) throw new Error('signature');
    var page = render(imgs[0], imgs[2]);
    var orig = imgs[1] ? render(imgs[1], imgs[2]) : null;
    post('STAMP:' + JSON.stringify({ page: page, orig: orig }));
  })
  .catch(function (e) { post('STAMP_ERROR:' + (e && e.message ? e.message : 'unknown')); });
</script>
</body></html>`;
}
