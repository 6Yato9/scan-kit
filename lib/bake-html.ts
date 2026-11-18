// lib/bake-html.ts

/** A single filter primitive, e.g. `{ grayscale: 1 }` or `{ contrast: 1.3 }`. */
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
 * The transform is done with explicit per-pixel maths rather than the canvas
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
function clamp(v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }
function apply(d) {
  for (var o = 0; o < OPS.length; o++) {
    var op = OPS[o];
    for (var key in op) {
      var a = op[key];
      for (var i = 0; i < d.length; i += 4) {
        var r = d[i], g = d[i + 1], b = d[i + 2], lum;
        if (key === 'grayscale') {
          lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          d[i] = clamp(r + (lum - r) * a);
          d[i + 1] = clamp(g + (lum - g) * a);
          d[i + 2] = clamp(b + (lum - b) * a);
        } else if (key === 'saturate') {
          lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          d[i] = clamp(lum + (r - lum) * a);
          d[i + 1] = clamp(lum + (g - lum) * a);
          d[i + 2] = clamp(lum + (b - lum) * a);
        } else if (key === 'contrast') {
          d[i] = clamp((r - 128) * a + 128);
          d[i + 1] = clamp((g - 128) * a + 128);
          d[i + 2] = clamp((b - 128) * a + 128);
        } else if (key === 'brightness') {
          d[i] = clamp(r * a);
          d[i + 1] = clamp(g * a);
          d[i + 2] = clamp(b * a);
        }
      }
    }
  }
}
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
      apply(id.data);
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
function clamp(v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }
function applyOps(d, ops) {
  for (var o = 0; o < ops.length; o++) {
    var op = ops[o];
    for (var key in op) {
      var a = op[key];
      for (var i = 0; i < d.length; i += 4) {
        var r = d[i], g = d[i + 1], b = d[i + 2], lum;
        if (key === 'grayscale') {
          lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          d[i] = clamp(r + (lum - r) * a); d[i + 1] = clamp(g + (lum - g) * a); d[i + 2] = clamp(b + (lum - b) * a);
        } else if (key === 'saturate') {
          lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          d[i] = clamp(lum + (r - lum) * a); d[i + 1] = clamp(lum + (g - lum) * a); d[i + 2] = clamp(lum + (b - lum) * a);
        } else if (key === 'contrast') {
          d[i] = clamp((r - 128) * a + 128); d[i + 1] = clamp((g - 128) * a + 128); d[i + 2] = clamp((b - 128) * a + 128);
        } else if (key === 'brightness') {
          d[i] = clamp(r * a); d[i + 1] = clamp(g * a); d[i + 2] = clamp(b * a);
        }
      }
    }
  }
}
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
        applyOps(id.data, LIST[k]);
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
