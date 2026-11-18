// lib/long-image.ts
// Stitches a document's pages into one tall JPEG using an off-screen WebView
// canvas. iOS WebKit refuses canvases above ~16.7M pixels (toDataURL then
// returns "data:,"), so the output is scaled to fit a pixel budget.

/** Stay safely under WebKit's 4096×4096 (16,777,216 px) canvas area cap. */
export const CANVAS_PIXEL_BUDGET = 15_000_000;
/** WebKit also caps each canvas side; keep the height well inside it. */
export const CANVAS_MAX_SIDE = 32_000;
/** No point exceeding typical scan width; keeps files reasonable. */
export const MAX_OUTPUT_WIDTH = 1600;

export type LongImagePlan = { width: number; heights: number[]; totalHeight: number };

/**
 * Output width and per-page heights for stacking pages of the given natural
 * sizes at one common width, within the canvas limits. Pages with an unknown
 * size are assumed to be A4 portrait.
 */
export function planLongImage(sizes: { width: number; height: number }[]): LongImagePlan {
  const ratios = sizes.map(s => (s.width > 0 && s.height > 0 ? s.height / s.width : Math.SQRT2));
  const ratioSum = ratios.reduce((a, r) => a + r, 0) || 1;
  const known = sizes.map(s => (s.width > 0 && s.height > 0 ? s.width : 0));
  const widest = Math.max(...known, 0) || MAX_OUTPUT_WIDTH;
  const byArea = Math.sqrt(CANVAS_PIXEL_BUDGET / ratioSum);
  const byHeight = CANVAS_MAX_SIDE / ratioSum;
  const width = Math.max(1, Math.floor(Math.min(widest, MAX_OUTPUT_WIDTH, byArea, byHeight)));
  const heights = ratios.map(r => Math.max(1, Math.round(width * r)));
  return { width, heights, totalHeight: heights.reduce((a, h) => a + h, 0) };
}

/**
 * HTML that draws each `src` (file:// URL) into one canvas following `plan`
 * and posts back `data:image/jpeg;…`, or `ERROR:<reason>`. The host WebView must
 * allow file access (see components/filter-baker.tsx) or the canvas is tainted.
 */
export function buildLongImageHtml(srcs: string[], plan: LongImagePlan): string {
  return `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#fff;">
<script>
var SRCS = ${JSON.stringify(srcs)};
var PLAN = ${JSON.stringify(plan)};
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
    canvas.width = PLAN.width;
    canvas.height = PLAN.totalHeight;
    var ctx = canvas.getContext('2d');
    if (!ctx) { post('ERROR:canvas'); return; }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, PLAN.width, PLAN.totalHeight);
    var y = 0, drawn = 0;
    for (var i = 0; i < SRCS.length; i++) {
      var img = await load(SRCS[i]);
      if (img) { ctx.drawImage(img, 0, y, PLAN.width, PLAN.heights[i]); drawn++; }
      y += PLAN.heights[i];
    }
    if (!drawn) { post('ERROR:load'); return; }
    var url = canvas.toDataURL('image/jpeg', 0.85);
    if (!url || url.length < 64 || url.indexOf('data:image/jpeg') !== 0) { post('ERROR:encode'); return; }
    post(url);
  } catch (e) {
    post('ERROR:' + (e && e.message ? e.message : 'unknown'));
  }
})();
</script>
</body></html>`;
}
