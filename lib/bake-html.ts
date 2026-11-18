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
 * HTML that renders ONE small preview per entry in `opsList` from a single image
 * load, posting back `PREVIEWS:` followed by a JSON array of JPEG data URLs.
 *
 * The filter picker needs to show what each filter WOULD look like. Doing that as
 * four separate bakes would mean four WebView round-trips through a queue that
 * processes one job at a time; this does it in one, at thumbnail resolution.
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
function post(msg) {
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(msg);
  else setTimeout(function () { post(msg); }, 30);
}
${PIXEL_KERNELS_JS}
var img = document.getElementById('src');
img.onerror = function () { post('BAKE_ERROR:load'); };
img.onload = function () {
  try {
    var nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh) { post('BAKE_ERROR:empty'); return; }
    var h = Math.max(1, Math.round(W * nh / nw));
    var out = [];
    for (var k = 0; k < LIST.length; k++) {
      var c = document.createElement('canvas');
      c.width = W; c.height = h;
      var ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, W, h);
      if (LIST[k].length) {
        var id = ctx.getImageData(0, 0, W, h);
        applyOps(id.data, W, h, LIST[k]);
        ctx.putImageData(id, 0, 0);
      }
      out.push(c.toDataURL('image/jpeg', 0.7));
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
