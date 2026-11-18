// lib/bake-html.ts
import { PIXEL_KERNELS_JS } from './pixel-kernels';

/**
 * One filter step: a document filter (`{ magic: 1 }`, `{ docgray: 1 }`,
 * `{ docbw: 1, bias, crisp }`) or a pixel primitive (`{ contrast: 1.3 }`).
 * See lib/pixel-kernels.ts for what each does.
 */
export type BakeOp = Record<string, number>;

/**
 * Largest canvas the bake draws to, in pixels. iOS WebKit refuses canvases
 * above 16,777,216 px (4096²): getContext returns null or toDataURL returns
 * "data:,". A default 24 MP iPhone photo (5712×4284) is well over that, so
 * bigger images are baked at the largest size that fits — still sharper than
 * any screen or A4 print needs. New pages are stored at ≤ 4096 px on the long
 * edge (see lib/files.ts MAX_PAGE_EDGE), so this only bites for pages saved
 * before that cap existed.
 */
export const BAKE_MAX_PIXELS = 16_000_000;

/**
 * HTML that draws `fileSrc` to an offscreen canvas at its natural pixel size with
 * `ops` applied, then posts the result back as a JPEG data URL.
 *
 * The transform is done with explicit per-pixel maths (lib/pixel-kernels.ts) rather than the canvas
 * `ctx.filter` property. `ctx.filter` is silently a no-op in the WebKit this app
 * runs against — the canvas re-encodes the image unchanged, which looks exactly
 * like a successful bake (file rewritten, metadata recorded) while the pixels are
 * untouched. getImageData/putImageData has no such feature dependency.
 *
 * Ops are applied in order, matching how CSS filter chains compose.
 *
 * The host MUST render the WebView with allowFileAccess, allowFileAccessFromFileURLs
 * and allowUniversalAccessFromFileURLs, or the canvas is tainted by the file:// image
 * and toDataURL throws a SecurityError.
 */
export function buildBakeHtml(fileSrc: string, ops: BakeOp[]): string {
  return `<!DOCTYPE html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#000;">
<img id="src" src="${fileSrc}" crossorigin="anonymous" style="display:none" />
<script>
var OPS = ${JSON.stringify(ops)};
var MAX_PIXELS = ${BAKE_MAX_PIXELS};
function fit(w, h) {
  if (w * h <= MAX_PIXELS) return { w: w, h: h };
  var k = Math.sqrt(MAX_PIXELS / (w * h));
  return { w: Math.max(1, Math.floor(w * k)), h: Math.max(1, Math.floor(h * k)) };
}
function post(msg) {
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(msg);
  else setTimeout(function () { post(msg); }, 30);
}
${PIXEL_KERNELS_JS}
var img = document.getElementById('src');
img.onerror = function () { post('BAKE_ERROR:load'); };
img.onload = function () {
  try {
    if (!img.naturalWidth || !img.naturalHeight) { post('BAKE_ERROR:empty'); return; }
    var size = fit(img.naturalWidth, img.naturalHeight);
    var w = size.w, h = size.h;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    if (!ctx) { post('BAKE_ERROR:canvas'); return; }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    if (OPS.length) {
      var id = ctx.getImageData(0, 0, w, h);
      applyOps(id.data, w, h, OPS);
      ctx.putImageData(id, 0, 0);
    }
    var out = c.toDataURL('image/jpeg', 0.92);
    // An over-limit canvas encodes to "data:," instead of throwing.
    if (out.indexOf('data:image/jpeg') !== 0) { post('BAKE_ERROR:encode'); return; }
    post(out);
  } catch (e) {
    post('BAKE_ERROR:' + (e && e.message ? e.message : 'unknown'));
  }
};
if (img.complete && img.naturalWidth) setTimeout(function () { img.onload(); }, 0);
</script>
</body>
</html>`;
}

/**
 * Shape of a filter tile's preview (height / width). The tiles show the TOP of
 * the page's content — title and first lines — across its full width, which is
 * where Enhanced, Grayscale and Black & white visibly differ (ink weight,
 * colour, grey). A whole-page tile made all three look like the same white
 * sheet; a fixed zoom used to cut words in half at the tile edges.
 */
export const PREVIEW_ASPECT = 0.85;

/**
 * JavaScript source of `previewCrop(d, w, h, aspect)`: on an RGBA buffer of a
 * filtered page (white paper, dark ink) it returns the {x, y, w, h} rectangle
 * to show in a tile — the content's full width (every inked column, so no word
 * is cut at the sides) plus a small margin, from just above the first line
 * down, at `aspect`. A sparse page is never zoomed past half the page width.
 * Columns and rows need a few inked pixels to count, so a speck of dust in a
 * margin does not widen the crop; a thin band at each edge is ignored, where
 * the table around a page can survive cropping.
 */
export const PREVIEW_CROP_JS = String.raw`
function previewCrop(d, w, h, aspect) {
  var cols = new Uint32Array(w), rows = new Uint32Array(h), x, y, i;
  var ex = Math.round(w * 0.02), ey = Math.round(h * 0.02);
  for (y = ey; y < h - ey; y++) {
    for (x = ex, i = (y * w + ex) * 4; x < w - ex; x++, i += 4) {
      if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 150) { cols[x]++; rows[y]++; }
    }
  }
  var tc = Math.max(2, Math.round(h * 0.002)), tr = Math.max(2, Math.round(w * 0.002));
  var left = -1, right = -1, top = -1;
  for (x = 0; x < w; x++) if (cols[x] >= tc) { if (left < 0) left = x; right = x; }
  for (y = 0; y < h; y++) if (rows[y] >= tr) { top = y; break; }
  if (left < 0 || top < 0) { left = 0; right = w - 1; top = 0; }
  var pad = Math.round(w * 0.03);
  var x0 = Math.max(0, left - pad), x1 = Math.min(w, right + pad + 1);
  var minW = Math.round(w * 0.5);
  if (x1 - x0 < minW) {
    var mid = (x0 + x1) / 2;
    x0 = Math.max(0, Math.round(mid - minW / 2)); x1 = Math.min(w, x0 + minW); x0 = Math.max(0, x1 - minW);
  }
  var cw = x1 - x0, ch = Math.min(h, Math.round(cw * aspect));
  var y0 = Math.max(0, top - pad);
  if (y0 + ch > h) y0 = Math.max(0, h - ch);
  return { x: x0, y: y0, w: cw, h: ch };
}
`;

/**
 * HTML that renders ONE small preview per entry in `opsList` from a single image
 * load, posting back `PREVIEWS:` followed by a JSON array of JPEG data URLs.
 *
 * The filter picker needs to show what each filter WOULD look like. Doing that as
 * four separate bakes would mean four WebView round-trips through a queue that
 * processes one job at a time; this does it in one, at thumbnail resolution.
 *
 * Every filter runs on the WHOLE page (the document filters estimate lighting
 * and ink across the page, so running them on a crop would change the result),
 * at a working size big enough for the crop to stay sharp; then each preview
 * is the same content crop (PREVIEW_CROP_JS, measured on the first filtered
 * result), `width` px wide at PREVIEW_ASPECT. A page wider than the crop's
 * shape is letterboxed on white rather than cut at the sides.
 */
export function buildPreviewHtml(fileSrc: string, opsList: BakeOp[][], width: number): string {
  return `<!DOCTYPE html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#000;">
<img id="src" src="${fileSrc}" crossorigin="anonymous" style="display:none" />
<script>
var LIST = ${JSON.stringify(opsList)};
var W = ${width};
var ASPECT = ${PREVIEW_ASPECT};
function post(msg) {
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(msg);
  else setTimeout(function () { post(msg); }, 30);
}
${PIXEL_KERNELS_JS}
${PREVIEW_CROP_JS}
var img = document.getElementById('src');
img.onerror = function () { post('BAKE_ERROR:load'); };
img.onload = function () {
  try {
    var nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh) { post('BAKE_ERROR:empty'); return; }
    // Working size: the crop is at least half the page wide, so twice the
    // tile width keeps it at full tile resolution.
    var pw = Math.min(nw, W * 2), ph = Math.max(1, Math.round(pw * nh / nw));
    var pages = [], crop = null;
    for (var k = 0; k < LIST.length; k++) {
      var c = document.createElement('canvas');
      c.width = pw; c.height = ph;
      var ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, pw, ph);
      if (LIST[k].length) {
        var id = ctx.getImageData(0, 0, pw, ph);
        applyOps(id.data, pw, ph, LIST[k]);
        ctx.putImageData(id, 0, 0);
        if (!crop) crop = previewCrop(id.data, pw, ph, ASPECT);
      }
      pages.push(c);
    }
    if (!crop) {
      var probe = pages[0].getContext('2d').getImageData(0, 0, pw, ph);
      crop = previewCrop(probe.data, pw, ph, ASPECT);
    }
    var ow = Math.max(1, Math.min(W, crop.w)), oh = Math.max(1, Math.round(ow * ASPECT));
    var dh = Math.min(oh, Math.round(ow * crop.h / crop.w));
    var out = [];
    for (var j = 0; j < pages.length; j++) {
      var o = document.createElement('canvas');
      o.width = ow; o.height = oh;
      var octx = o.getContext('2d');
      octx.imageSmoothingQuality = 'high';
      octx.fillStyle = '#fff';
      octx.fillRect(0, 0, ow, oh);
      octx.drawImage(pages[j], crop.x, crop.y, crop.w, crop.h, 0, 0, ow, dh);
      out.push(o.toDataURL('image/jpeg', 0.8));
    }
    post('PREVIEWS:' + JSON.stringify(out));
  } catch (e) {
    post('BAKE_ERROR:' + (e && e.message ? e.message : 'unknown'));
  }
};
if (img.complete && img.naturalWidth) setTimeout(function () { img.onload(); }, 0);
</script>
</body>
</html>`;
}
