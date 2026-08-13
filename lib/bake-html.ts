// lib/bake-html.ts
//
// Pure HTML builder for baking a CSS filter into a JPEG's actual pixels via a
// WebView + canvas, mirroring the one working pixel pipeline in this app
// (see app/annotate.tsx: load into an <img>, draw to a canvas, read back
// toDataURL). RN's iOS filter style only honors brightness/opacity — grayscale,
// contrast and saturate are silently dropped — so those effects must be baked
// into the JPEG bytes instead of applied at render time.
//
// This module returns HTML only; it does not touch the WebView or the queue
// that feeds it (see lib/bake-queue.ts / a future WebView host component).

// Escapes a string so it can be embedded inside a single-quoted JS string
// literal without breaking out of it. Backslashes must be escaped first so a
// css value ending in `\` doesn't eat the following escaped quote.
function escapeJsSingleQuoted(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Builds HTML that loads `fileSrc` into a hidden <img>, draws it to an
 * offscreen canvas at natural pixel size with `css` applied as ctx.filter,
 * and posts the resulting JPEG data URL back via
 * window.ReactNativeWebView.postMessage. On image load failure, or on any
 * error while drawing, posts 'BAKE_ERROR:<reason>' instead of hanging.
 */
export function buildBakeHtml(fileSrc: string, css: string): string {
  const safeCss = escapeJsSingleQuoted(css);

  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<style>
* { margin:0; padding:0; }
body { background:#000; }
</style>
</head>
<body>
<img id="src" crossorigin="anonymous" style="display:none;" src="${fileSrc}" />
<script>
var img = document.getElementById('src');

img.onerror = function () {
  window.ReactNativeWebView.postMessage('BAKE_ERROR:image failed to load');
};

function bake() {
  try {
    var natW = img.naturalWidth;
    var natH = img.naturalHeight;
    var canvas = document.createElement('canvas');
    canvas.width = natW;
    canvas.height = natH;
    var ctx = canvas.getContext('2d');
    ctx.filter = '${safeCss}';
    ctx.drawImage(img, 0, 0, natW, natH);
    window.ReactNativeWebView.postMessage(canvas.toDataURL('image/jpeg', 0.92));
  } catch (err) {
    window.ReactNativeWebView.postMessage('BAKE_ERROR:' + (err && err.message ? err.message : String(err)));
  }
}

img.onload = bake;
if (img.complete && img.naturalWidth > 0) {
  bake();
}
</script>
</body>
</html>`;
}
