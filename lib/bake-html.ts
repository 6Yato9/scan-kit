// lib/bake-html.ts

/** A single filter primitive, e.g. `{ grayscale: 1 }` or `{ contrast: 1.3 }`. */
export type BakeOp = Record<string, number>;

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
    var w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) { post('BAKE_ERROR:empty'); return; }
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    if (OPS.length) {
      var id = ctx.getImageData(0, 0, w, h);
      apply(id.data);
      ctx.putImageData(id, 0, 0);
    }
    post(c.toDataURL('image/jpeg', 0.92));
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
