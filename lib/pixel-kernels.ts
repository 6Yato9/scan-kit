// lib/pixel-kernels.ts
//
// The per-pixel maths behind every filter, as JavaScript SOURCE that the bake
// WebView evaluates (lib/bake-html.ts embeds it in both the bake and the preview
// page). It is a string, not real functions, because Hermes compiles the app to
// bytecode: `fn.toString()` would hand WebKit "[bytecode]", not code.
//
// The jest tests evaluate this exact string with `new Function` and run it on
// small synthetic RGBA arrays, so what is tested is what WebKit runs.
//
// Entry point: `applyOps(d, w, h, ops)` transforms an RGBA Uint8ClampedArray
// (canvas ImageData) in place. `ops` is a list such as
//   [{ magic: 1 }, { brightness: 1.1 }]
// applied in order. Document filters (whole-image, they need w/h):
//   magic   - "Enhanced": lighting flattened per channel so paper becomes
//             white and shadows vanish, ink and colour keep their hue, then a
//             tone curve for crisp text.
//   docgray - the same flattening on luminance, as gray.
//   docbw   - flattened gray, then a Sauvola adaptive threshold. Optional
//             `bias` (-1..1, brighter = fewer dark pixels) and `crisp`
//             (-1..1, edge hardness) come from the Adjust sliders.
// Pixel primitives (CSS filter semantics): grayscale, saturate, contrast,
// brightness.
//
// Performance: pages are at most 16 MP. Background estimation works on a grid
// of about 200 cells on the long edge; full-resolution work is a few linear
// passes with typed arrays, and the threshold uses running window sums (O(1)
// per pixel whatever the window size) instead of a 16 MP integral image, which
// would need hundreds of MB of Float64 memory.
export const PIXEL_KERNELS_JS = String.raw`
function clamp(v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }
function lumOf(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

// Separable max (isMax) or min filter of radius r over a w*h grid, in place.
function morph(a, w, h, r, isMax) {
  var tmp = new Float32Array(a.length), x, y, k, lo, hi, m, v, row;
  for (y = 0; y < h; y++) {
    row = y * w;
    for (x = 0; x < w; x++) {
      lo = x - r < 0 ? 0 : x - r; hi = x + r >= w ? w - 1 : x + r;
      m = a[row + lo];
      for (k = lo + 1; k <= hi; k++) { v = a[row + k]; if (isMax ? v > m : v < m) m = v; }
      tmp[row + x] = m;
    }
  }
  for (x = 0; x < w; x++) {
    for (y = 0; y < h; y++) {
      lo = y - r < 0 ? 0 : y - r; hi = y + r >= h ? h - 1 : y + r;
      m = tmp[lo * w + x];
      for (k = lo + 1; k <= hi; k++) { v = tmp[k * w + x]; if (isMax ? v > m : v < m) m = v; }
      a[y * w + x] = m;
    }
  }
}

// Separable box mean of radius r over a w*h grid, in place. Windows are clipped
// at the borders and divided by the cells they actually cover, so edges are
// not darkened.
function boxBlur(a, w, h, r) {
  var tmp = new Float32Array(a.length), x, y, s, c, row;
  for (y = 0; y < h; y++) {
    row = y * w; s = 0; c = 0;
    for (x = 0; x <= r && x < w; x++) { s += a[row + x]; c++; }
    for (x = 0; x < w; x++) {
      tmp[row + x] = s / c;
      if (x + r + 1 < w) { s += a[row + x + r + 1]; c++; }
      if (x - r >= 0) { s -= a[row + x - r]; c--; }
    }
  }
  for (x = 0; x < w; x++) {
    s = 0; c = 0;
    for (y = 0; y <= r && y < h; y++) { s += tmp[y * w + x]; c++; }
    for (y = 0; y < h; y++) {
      a[y * w + x] = s / c;
      if (y + r + 1 < h) { s += tmp[(y + r + 1) * w + x]; c++; }
      if (y - r >= 0) { s -= tmp[(y - r) * w + x]; c--; }
    }
  }
}

function chromaOf(r, g, b) {
  var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
  var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
  return mx > 1 ? (mx - mn) / mx : 0;
}

// Estimates the bare-paper colour at every point of the page: the "illumination
// field" (lighting x paper tint). Works on a coarse grid:
//  1. block means (~200 cells on the long edge);
//  2. a morphological closing per channel, which erases anything dark that is
//     narrower than a few cells (text, lines, stamps) and leaves the paper;
//  3. cells that are not paper (a photo, a grey box, a big coloured logo, the
//     table outside the page: anything that meets the paper with a sharp step
//     or has another colour) are filled in from the surrounding paper, so a
//     large dark or coloured area is not "flattened" into white;
//  4. a final blur so the field is smooth (no blocky seams).
function estimateBackground(d, w, h) {
  var long = w > h ? w : h;
  var f = Math.max(1, Math.ceil(long / 200));
  var gw = Math.ceil(w / f), gh = Math.ceil(h / f), n = gw * gh;
  var R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), C = new Float32Array(n);
  var cx = new Int32Array(w), x, y, i, k, gb;
  for (x = 0; x < w; x++) cx[x] = (x / f) | 0;
  for (y = 0; y < h; y++) {
    gb = ((y / f) | 0) * gw; i = y * w * 4;
    for (x = 0; x < w; x++, i += 4) {
      k = gb + cx[x];
      R[k] += d[i]; G[k] += d[i + 1]; B[k] += d[i + 2]; C[k] += 1;
    }
  }
  for (k = 0; k < n; k++) { R[k] /= C[k]; G[k] /= C[k]; B[k] /= C[k]; }

  var gmax = gw > gh ? gw : gh;
  var rc = Math.max(1, Math.round(gmax / 40));
  morph(R, gw, gh, rc, true); morph(R, gw, gh, rc, false);
  morph(G, gw, gh, rc, true); morph(G, gw, gh, rc, false);
  morph(B, gw, gh, rc, true); morph(B, gw, gh, rc, false);

  // Paper colour: the mean of the brighter cells (80th-98th percentile of
  // luminance), so a little glare or a dark border doesn't skew it.
  var L = new Float32Array(n);
  for (k = 0; k < n; k++) L[k] = lumOf(R[k], G[k], B[k]);
  var sorted = Float32Array.from(L).sort();
  var lo = sorted[Math.floor((n - 1) * 0.8)], hi = sorted[Math.floor((n - 1) * 0.98)];
  var pr = 0, pg = 0, pb = 0, pc = 0;
  for (k = 0; k < n; k++) {
    if (L[k] >= lo && L[k] <= hi) { pr += R[k]; pg += G[k]; pb += B[k]; pc++; }
  }
  if (!pc) { pr = R[0]; pg = G[0]; pb = B[0]; pc = 1; }
  pr /= pc; pg /= pc; pb /= pc;
  var pl = lumOf(pr, pg, pb), pch = chromaOf(pr, pg, pb);

  // Paper = what is connected to the brightest paper through gentle steps.
  // Lighting changes smoothly (a shadow's edge spans many cells), while a
  // photo, a grey box or the table beside the page meets the paper with a
  // sharp step, so a flood fill that refuses sharp steps stops at objects and
  // still walks into shadows. Cells it never reaches are filled from paper.
  var CH = new Float32Array(n), M = new Float32Array(n), queue = new Int32Array(n), qh = 0, qt = 0, anyHole = false;
  for (k = 0; k < n; k++) CH[k] = chromaOf(R[k], G[k], B[k]);
  var minL = 0.3 * pl, stepL = 0.06 * pl;
  for (k = 0; k < n; k++) {
    if (L[k] >= lo && Math.abs(CH[k] - pch) < 0.12) { M[k] = 1; queue[qt++] = k; }
  }
  while (qh < qt) {
    var c = queue[qh++], cxk = c % gw, nb, q;
    for (q = 0; q < 4; q++) {
      if (q === 0) { if (cxk === 0) continue; nb = c - 1; }
      else if (q === 1) { if (cxk === gw - 1) continue; nb = c + 1; }
      else if (q === 2) { if (c < gw) continue; nb = c - gw; }
      else { nb = c + gw; if (nb >= n) continue; }
      if (M[nb] || L[nb] < minL) continue;
      if (Math.abs(L[nb] - L[c]) > stepL || Math.abs(CH[nb] - CH[c]) > 0.05) continue;
      if (Math.abs(CH[nb] - pch) >= 0.15) continue;
      M[nb] = 1; queue[qt++] = nb;
    }
  }
  for (k = 0; k < n; k++) if (!M[k]) { anyHole = true; break; }
  if (anyHole) {
    // Grow the holes a little: the cells along a big object's edge are a mix
    // of object and paper, and would otherwise leave a bright rim.
    morph(M, gw, gh, 1, false);
    var NR = new Float32Array(n), NG = new Float32Array(n), NB = new Float32Array(n), D = Float32Array.from(M);
    for (k = 0; k < n; k++) { NR[k] = R[k] * M[k]; NG[k] = G[k] * M[k]; NB[k] = B[k] * M[k]; }
    var ri = Math.max(2, Math.round(gmax / 10));
    for (var p = 0; p < 3; p++) {
      boxBlur(NR, gw, gh, ri); boxBlur(NG, gw, gh, ri); boxBlur(NB, gw, gh, ri); boxBlur(D, gw, gh, ri);
    }
    for (k = 0; k < n; k++) {
      if (M[k] > 0) continue;
      if (D[k] > 1e-3) { R[k] = NR[k] / D[k]; G[k] = NG[k] / D[k]; B[k] = NB[k] / D[k]; }
      else { R[k] = pr; G[k] = pg; B[k] = pb; }
    }
  }

  boxBlur(R, gw, gh, rc); boxBlur(R, gw, gh, rc);
  boxBlur(G, gw, gh, rc); boxBlur(G, gw, gh, rc);
  boxBlur(B, gw, gh, rc); boxBlur(B, gw, gh, rc);
  return { f: f, gw: gw, gh: gh, R: R, G: G, B: B, paper: [pr, pg, pb] };
}

// Bilinear upsampling of the background grid, one image row at a time. Returns
// the reciprocal (1 / background) per channel, so callers multiply instead of
// dividing per pixel.
function makeSampler(bg, w, h) {
  var f = bg.f, gw = bg.gw, gh = bg.gh;
  var x0 = new Int32Array(w), x1 = new Int32Array(w), wx = new Float32Array(w), x, g;
  for (x = 0; x < w; x++) {
    g = (x + 0.5) / f - 0.5;
    if (g < 0) g = 0; if (g > gw - 1) g = gw - 1;
    x0[x] = g | 0; x1[x] = Math.min(gw - 1, x0[x] + 1); wx[x] = g - x0[x];
  }
  var iR = new Float32Array(gw), iG = new Float32Array(gw), iB = new Float32Array(gw), iL = new Float32Array(gw);
  var oR = new Float32Array(w), oG = new Float32Array(w), oB = new Float32Array(w), oL = new Float32Array(w);
  return {
    R: oR, G: oG, B: oB, L: oL,
    row: function (y) {
      var gy = (y + 0.5) / f - 0.5;
      if (gy < 0) gy = 0; if (gy > gh - 1) gy = gh - 1;
      var y0 = gy | 0, y1 = Math.min(gh - 1, y0 + 1), t = gy - y0, a = y0 * gw, b = y1 * gw, k, r, gg, bb;
      for (k = 0; k < gw; k++) {
        r = bg.R[a + k] + (bg.R[b + k] - bg.R[a + k]) * t;
        gg = bg.G[a + k] + (bg.G[b + k] - bg.G[a + k]) * t;
        bb = bg.B[a + k] + (bg.B[b + k] - bg.B[a + k]) * t;
        iR[k] = r; iG[k] = gg; iB[k] = bb; iL[k] = lumOf(r, gg, bb);
      }
      for (var xx = 0; xx < w; xx++) {
        var k0 = x0[xx], k1 = x1[xx], s = wx[xx];
        oR[xx] = 1 / Math.max(8, iR[k0] + (iR[k1] - iR[k0]) * s);
        oG[xx] = 1 / Math.max(8, iG[k0] + (iG[k1] - iG[k0]) * s);
        oB[xx] = 1 / Math.max(8, iB[k0] + (iB[k1] - iB[k0]) * s);
        oL[xx] = 1 / Math.max(8, iL[k0] + (iL[k1] - iL[k0]) * s);
      }
    },
  };
}

// Normalised value v (1 = bare paper) -> LUT index. 1024 steps cover 0..2.
var LUT_SCALE = 512, LUT_SIZE = 1024;
function lutIndex(v) { var i = (v * LUT_SCALE) | 0; return i < 0 ? 0 : (i >= LUT_SIZE ? LUT_SIZE - 1 : i); }

// Black point: a low percentile of the flattened luminance (sampled), so the
// darkest ink maps to black. Capped so a page of faint pencil isn't stretched
// into heavy strokes.
function blackPoint(d, w, h, s) {
  var hist = new Uint32Array(256), total = 0, step = Math.max(1, Math.round(Math.sqrt(w * h / 250000)));
  for (var y = 0; y < h; y += step) {
    s.row(y);
    for (var x = 0, i = y * w * 4; x < w; x += step, i += 4 * step) {
      var v = lumOf(d[i], d[i + 1], d[i + 2]) * s.L[x];
      hist[v >= 1 ? 255 : (v * 255) | 0]++; total++;
    }
  }
  var target = total * 0.005, acc = 0, b = 0;
  for (; b < 256; b++) { acc += hist[b]; if (acc >= target) break; }
  return Math.min(0.3, (b / 255) * 0.85);
}

// Tone curve for flattened values: black point -> 0, WHITE (just under bare
// paper, so paper grain clips to clean white) -> 255, with a gamma that
// darkens mid-tones: anti-aliased text edges go solid and faint pencil stays
// visible instead of fading into the newly white paper.
var WHITE = 0.94;
function toneLut(bp, gamma) {
  var lut = new Uint8ClampedArray(LUT_SIZE);
  for (var i = 0; i < LUT_SIZE; i++) {
    var t = (i / LUT_SCALE - bp) / (WHITE - bp);
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    lut[i] = Math.round(255 * Math.pow(t, gamma));
  }
  return lut;
}

function docMagic(d, w, h) {
  var s = makeSampler(estimateBackground(d, w, h), w, h);
  var lut = toneLut(blackPoint(d, w, h, s), 1.7);
  var SAT = 1.25;
  for (var y = 0; y < h; y++) {
    s.row(y);
    for (var x = 0, i = y * w * 4; x < w; x++, i += 4) {
      var r = lut[lutIndex(d[i] * s.R[x])];
      var g = lut[lutIndex(d[i + 1] * s.G[x])];
      var b = lut[lutIndex(d[i + 2] * s.B[x])];
      // Colour: boosted where it is real (stamps, highlighter, photos), cored
      // to neutral where it is only a faint cast — grey pencil on cream paper
      // would otherwise come out bluish once the cream is divided away.
      var l = 0.299 * r + 0.587 * g + 0.114 * b;
      var mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      var c = (mx - mn - 10) / 20, k = (c < 0 ? 0 : (c > 1 ? 1 : c)) * SAT;
      d[i] = l + (r - l) * k; d[i + 1] = l + (g - l) * k; d[i + 2] = l + (b - l) * k;
    }
  }
}

function docGray(d, w, h) {
  var s = makeSampler(estimateBackground(d, w, h), w, h);
  var lut = toneLut(blackPoint(d, w, h, s), 1.8);
  for (var y = 0; y < h; y++) {
    s.row(y);
    for (var x = 0, i = y * w * 4; x < w; x++, i += 4) {
      var v = lut[lutIndex(lumOf(d[i], d[i + 1], d[i + 2]) * s.L[x])];
      d[i] = v; d[i + 1] = v; d[i + 2] = v;
    }
  }
}

// Sauvola threshold T = m * (1 + k * (sd / 128 - 1)) over a square window, on
// the flattened gray, capped at m - BETA * sd. The small k keeps faint pencil
// (low sd) above the line; the cap stops strong text (high sd, where Sauvola
// sits close to the mean) from swelling into bold blobs on a soft photo. m and sd come from running sums of a vertical strip per
// column plus a horizontal running sum per row: O(1) per pixel, O(w) memory.
function docBW(d, w, h, op) {
  var bias = op.bias || 0, crisp = op.crisp || 0;
  var s = makeSampler(estimateBackground(d, w, h), w, h);
  var n = w * h, gray = new Uint8ClampedArray(n), x, y, i, j;
  for (y = 0; y < h; y++) {
    s.row(y);
    for (x = 0, i = y * w * 4, j = y * w; x < w; x++, i += 4, j++) {
      gray[j] = lumOf(d[i], d[i + 1], d[i + 2]) * s.L[x] * 255;
    }
  }
  var long = w > h ? w : h;
  var r = Math.max(4, Math.round(long / 90));
  var K = 0.1, BETA = 0.55;
  // Brightness slider: shifts the threshold, never past bare paper (which stays
  // white whatever the setting) — brighter drops faint marks, darker keeps more.
  var tShift = -25 * bias;
  var half = Math.max(2, 10 * (1 - 0.8 * crisp));
  // Flattened paper sits at 255, so anything under half of it is ink whatever
  // its neighbourhood: Sauvola alone turns the inside of a large dark area
  // white (its local mean is dark too).
  var dark = 120 - 30 * bias;
  var colS = new Float64Array(w), colQ = new Float64Array(w), rows = 0, v;
  // Prime the strip with rows 0..r-1; row y+r is added at the top of each step.
  for (y = 0; y < r && y < h; y++) {
    for (x = 0, j = y * w; x < w; x++, j++) { v = gray[j]; colS[x] += v; colQ[x] += v * v; }
    rows++;
  }
  for (y = 0; y < h; y++) {
    var add = y + r, sub = y - r - 1;
    if (add < h) { for (x = 0, j = add * w; x < w; x++, j++) { v = gray[j]; colS[x] += v; colQ[x] += v * v; } rows++; }
    if (sub >= 0) { for (x = 0, j = sub * w; x < w; x++, j++) { v = gray[j]; colS[x] -= v; colQ[x] -= v * v; } rows--; }
    var S = 0, Q = 0, cols = 0;
    for (x = 0; x < r && x < w; x++) { S += colS[x]; Q += colQ[x]; cols++; }
    for (x = 0, j = y * w, i = y * w * 4; x < w; x++, j++, i += 4) {
      if (x + r < w) { S += colS[x + r]; Q += colQ[x + r]; cols++; }
      if (x - r - 1 >= 0) { S -= colS[x - r - 1]; Q -= colQ[x - r - 1]; cols--; }
      var cnt = rows * cols, m = S / cnt, va = Q / cnt - m * m;
      var sd = va > 0 ? Math.sqrt(va) : 0;
      var T = m * (1 + K * (sd / 128 - 1));
      var T2 = m - BETA * sd;
      T = (T2 < T ? T2 : T) + tShift;
      v = gray[j];
      var o;
      if (v >= 242) o = 255;                 // bare paper: always white, no speckle
      else if (v < dark) o = 0;              // clearly ink: black, so big dark areas never go hollow
      else o = clamp((v - T + half) * (255 / (2 * half)));
      d[i] = o; d[i + 1] = o; d[i + 2] = o;
    }
  }
}

function applyPrimitive(d, key, a) {
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

function applyOps(d, w, h, ops) {
  for (var o = 0; o < ops.length; o++) {
    var op = ops[o];
    if (op.magic) docMagic(d, w, h);
    else if (op.docgray) docGray(d, w, h);
    else if (op.docbw) docBW(d, w, h, op);
    else for (var key in op) applyPrimitive(d, key, op[key]);
  }
}
`;
