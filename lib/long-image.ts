// lib/long-image.ts
// Stitches a document's pages into one tall JPEG using an off-screen WebView
// canvas. iOS WebKit refuses canvases above ~16.7M pixels (toDataURL then
// returns "data:,"), so the output is scaled to fit a pixel budget.
//
// Round 16 options (all default to the image it always made: pages edge to
// edge on white, up to 1600 px wide, JPEG quality 0.85):
// - spacing between pages and an outer margin, each a share of the page width
//   (so they look the same whatever size the output ends up);
// - the background colour of that space (white, light grey, black);
// - the widest the pages may be (1080 / 1600 / 2400 px), still within the
//   canvas budget — the preview's caption says the real size;
// - the JPEG quality.
import { jsonObject, oneOf } from './tool-prefs';

/** Stay safely under WebKit's 4096×4096 (16,777,216 px) canvas area cap. */
export const CANVAS_PIXEL_BUDGET = 15_000_000;
/** WebKit also caps each canvas side; keep the height well inside it. */
export const CANVAS_MAX_SIDE = 32_000;
/** No point exceeding typical scan width; keeps files reasonable. */
export const MAX_OUTPUT_WIDTH = 1600;

export type LongImageSpace = 'none' | 'small' | 'large';
export type LongImageBackground = 'white' | 'grey' | 'black';
export type LongImageQuality = 'smaller' | 'standard' | 'best';

/** Spacing and margin as a share of the page width. */
export const SPACE_SHARE: Record<LongImageSpace, number> = { none: 0, small: 0.02, large: 0.06 };
export const BACKGROUND_HEX: Record<LongImageBackground, string> = { white: '#ffffff', grey: '#e9e9ec', black: '#000000' };
export const JPEG_QUALITY: Record<LongImageQuality, number> = { smaller: 0.7, standard: 0.85, best: 0.95 };
export const WIDTH_CHOICES: readonly number[] = [1080, MAX_OUTPUT_WIDTH, 2400];

export type LongImageOptions = {
  gap: LongImageSpace;
  margin: LongImageSpace;
  background: LongImageBackground;
  maxWidth: number;
  quality: LongImageQuality;
};

export const DEFAULT_LONG_IMAGE: LongImageOptions = {
  gap: 'none',
  margin: 'none',
  background: 'white',
  maxWidth: MAX_OUTPUT_WIDTH,
  quality: 'standard',
};

const SPACES: readonly LongImageSpace[] = ['none', 'small', 'large'];
const BACKGROUNDS: readonly LongImageBackground[] = ['white', 'grey', 'black'];
const QUALITIES: readonly LongImageQuality[] = ['smaller', 'standard', 'best'];

/** Remembered options, validated field by field onto the defaults. Pure. */
export function parseLongImageOptions(o: Record<string, unknown> | string | null): LongImageOptions {
  const v = typeof o === 'string' || o === null ? jsonObject(o) : o;
  const d = DEFAULT_LONG_IMAGE;
  return {
    gap: oneOf(SPACES, v.gap, d.gap),
    margin: oneOf(SPACES, v.margin, d.margin),
    background: oneOf(BACKGROUNDS, v.background, d.background),
    maxWidth: oneOf(WIDTH_CHOICES, v.maxWidth, d.maxWidth),
    quality: oneOf(QUALITIES, v.quality, d.quality),
  };
}

export type LongImagePlan = {
  /** Width of each page in the image, px. */
  width: number;
  heights: number[];
  /** Height of the whole image, px (pages, spacing and margins). */
  totalHeight: number;
  /** Width of the whole image, px (the pages plus the margin on both sides). */
  canvasWidth: number;
  /** Space between pages and around them, px. */
  gap: number;
  margin: number;
  /** Top edge of each page, px. */
  tops: number[];
};

/**
 * Output width and per-page heights for stacking pages of the given natural
 * sizes at one common width, within the canvas limits, with the chosen
 * spacing and margin. Pages with an unknown size are assumed to be A4
 * portrait. With no spacing or margin this is the plan it always was.
 */
export function planLongImage(
  sizes: { width: number; height: number }[],
  options: Partial<Pick<LongImageOptions, 'gap' | 'margin' | 'maxWidth'>> = {},
): LongImagePlan {
  const g = SPACE_SHARE[options.gap ?? 'none'] ?? 0;
  const m = SPACE_SHARE[options.margin ?? 'none'] ?? 0;
  const maxWidth = options.maxWidth && options.maxWidth > 0 ? options.maxWidth : MAX_OUTPUT_WIDTH;
  const ratios = sizes.map(s => (s.width > 0 && s.height > 0 ? s.height / s.width : Math.SQRT2));
  const ratioSum = ratios.reduce((a, r) => a + r, 0) || 1;
  // The image's height and width per pixel of page width.
  const heightPer = ratioSum + Math.max(0, ratios.length - 1) * g + 2 * m;
  const widthPer = 1 + 2 * m;
  const known = sizes.map(s => (s.width > 0 && s.height > 0 ? s.width : 0));
  const widest = Math.max(...known, 0) || maxWidth;
  const byArea = Math.sqrt(CANVAS_PIXEL_BUDGET / (heightPer * widthPer));
  const byHeight = CANVAS_MAX_SIDE / heightPer;
  const width = Math.max(1, Math.floor(Math.min(widest, maxWidth, byArea, byHeight)));
  const heights = ratios.map(r => Math.max(1, Math.round(width * r)));
  const gap = Math.round(width * g);
  const margin = Math.round(width * m);
  const tops: number[] = [];
  let y = margin;
  for (const h of heights) {
    tops.push(y);
    y += h + gap;
  }
  const totalHeight = heights.reduce((a, h) => a + h, 0) + gap * Math.max(0, heights.length - 1) + 2 * margin;
  return { width, heights, totalHeight, canvasWidth: width + 2 * margin, gap, margin, tops };
}

/**
 * HTML that draws each `src` (file:// URL) into one canvas following `plan`
 * and posts back `data:image/jpeg;…`, or `ERROR:<reason>`. The host WebView must
 * allow file access (see components/filter-baker.tsx) or the canvas is tainted.
 */
export function buildLongImageHtml(
  srcs: string[],
  plan: LongImagePlan,
  look: { background?: string; quality?: number } = {},
): string {
  const bg = /^#[0-9a-f]{6}$/i.test(look.background ?? '') ? look.background : '#ffffff';
  const q = Math.min(1, Math.max(0.3, look.quality ?? JPEG_QUALITY.standard));
  return `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#fff;">
<script>
var SRCS = ${JSON.stringify(srcs)};
var PLAN = ${JSON.stringify(plan)};
var BG = ${JSON.stringify(bg)};
var Q = ${q};
function post(msg) {
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(msg);
  else setTimeout(function () { post(msg); }, 30);
}
function load(src) {
  return new Promise(function (resolve) {
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function () { resolve(img); };
    img.onerror = function () { resolve(null); };
    img.src = src;
  });
}
(async function () {
  try {
    var canvas = document.createElement('canvas');
    canvas.width = PLAN.canvasWidth;
    canvas.height = PLAN.totalHeight;
    var ctx = canvas.getContext('2d');
    if (!ctx) { post('ERROR:canvas'); return; }
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, PLAN.canvasWidth, PLAN.totalHeight);
    var drawn = 0;
    for (var i = 0; i < SRCS.length; i++) {
      var img = await load(SRCS[i]);
      if (img) { ctx.drawImage(img, PLAN.margin, PLAN.tops[i], PLAN.width, PLAN.heights[i]); drawn++; }
    }
    if (!drawn) { post('ERROR:load'); return; }
    var url = canvas.toDataURL('image/jpeg', Q);
    if (!url || url.length < 64 || url.indexOf('data:image/jpeg') !== 0) { post('ERROR:encode'); return; }
    post(url);
  } catch (e) {
    post('ERROR:' + (e && e.message ? e.message : 'unknown'));
  }
})();
</script>
</body></html>`;
}
