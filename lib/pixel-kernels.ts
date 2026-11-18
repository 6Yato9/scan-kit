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
//             white and shadows vanish, then a tone curve for crisp text on
//             luminance while colour (stamps, logos, highlighter, blue ink)
//             keeps its hue and printed shade.
//   docgray - the same flattening on luminance, as gray.
//   Both run a stroke guard (strokeGuard) so faint pencil, light signature
//   lines and thin rules are not whitened away with the paper.
//   docbw   - flattened gray, then a Sauvola adaptive threshold, capped at
//             each stroke's own ink/paper midpoint so small text keeps its
//             weight and its counters open. Optional
//             `bias` (-1..1, brighter = fewer dark pixels) and `crisp`
//             (-1..1, edge hardness) come from the Adjust sliders.
//   All three measure the paper's own grain (paperSpread) and set their
//   white point under it, then erase isolated specks (despeckle) without
//   touching punctuation, i-dots or pencil that sit next to real ink.
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

// The outermost ring of a block grid is the least reliable part of it: the
// last row and column of blocks are usually partial (a few pixels wide), and a
// page's outermost pixels are often an artefact of the crop (a bright or dark
// 1-2 px line where the warp sampled past the paper). Averaged into a narrow
// block, that line skews the estimate at the very edge, and dividing by it
// drew a grey seam down the side of a shadowed page. The ring takes its value
// from the blocks just inside (lighting changes far too slowly for one block
// to matter).
function ringFromInside(a, w, h) {
  var x, y;
  if (w >= 4) for (y = 0; y < h; y++) { a[y * w] = a[y * w + 1]; a[y * w + w - 1] = a[y * w + w - 2]; }
  if (h >= 4) for (x = 0; x < w; x++) { a[x] = a[w + x]; a[(h - 1) * w + x] = a[(h - 2) * w + x]; }
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
  ringFromInside(R, gw, gh); ringFromInside(G, gw, gh); ringFromInside(B, gw, gh);

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
// darkens mid-tones so anti-aliased text edges go solid. Colour uses a gentler
// curve (gamma 1): a stamp or logo keeps the shade it was printed in.
var WHITE = 0.94;
function toneLut(bp, gamma, white) {
  var lut = new Float32Array(LUT_SIZE), wp = white || WHITE;
  for (var i = 0; i < LUT_SIZE; i++) {
    var t = (i / LUT_SCALE - bp) / (wp - bp);
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    lut[i] = Math.pow(t, gamma);
  }
  return lut;
}

// Paper grain. On textured or noisy paper (recycled stock, a dim photo's
// sensor noise) flattened paper is not a flat 1 but a spread around it, and a
// fixed white point left the darker half of that spread as grey grain all over
// the page. The spread is measured on the bright side of the paper (no ink is
// brighter than paper): median and sigma (84th percentile - median) of the
// flattened luminance above 0.8, sampled. The white point then sits just under
// the bulk of the paper, median - 2.5 sigma, so grain clips to white with it.
// Clean paper keeps WHITE; the floor keeps faint pencil (far below the paper's
// spread) from being lifted away on very rough paper.
function paperSpread(d, w, h, s) {
  var hist = new Uint32Array(LUT_SIZE), total = 0, step = Math.max(1, Math.round(Math.sqrt(w * h / 250000)));
  for (var y = 0; y < h; y += step) {
    s.row(y);
    for (var x = 0, i = y * w * 4; x < w; x += step, i += 4 * step) {
      var v = lumOf(d[i], d[i + 1], d[i + 2]) * s.L[x];
      if (v >= 0.8) { hist[lutIndex(v)]++; total++; }
    }
  }
  if (!total) return { white: WHITE, median: 1, sigma: 0 };
  var acc = 0, med = -1, p84 = -1;
  for (var b = 0; b < LUT_SIZE; b++) {
    acc += hist[b];
    if (med < 0 && acc * 2 >= total) med = b;
    if (acc >= total * 0.84) { p84 = b; break; }
  }
  var m = (med + 0.5) / LUT_SCALE, sg = Math.max(0, p84 - med) / LUT_SCALE;
  var wp = m - 2.5 * sg;
  return { white: wp < 0.82 ? 0.82 : (wp > WHITE ? WHITE : wp), median: m, sigma: sg };
}

// Speckle. Whatever survives the white point on grainy paper (the deepest
// grain, paper fibres, dust) is a scatter of small, isolated marks, while
// everything worth keeping that is as small (a full stop, an i-dot, a decimal
// point, the dot of a pencilled i) sits right next to bigger ink. So:
//  - marked pixels (output < 250) are grouped into 8-connected components by
//    run-length labelling (memory per run of marked pixels, not per pixel);
//  - BIG ink is any component of at least SPECK = (long side / 500)^2 px whose
//    darkest pixel is darker than bigDark;
//  - a component smaller than SPECK is erased to white when it is isolated (no
//    big ink within about 1% of the long side) and its darkest pixel is at
//    least isoDark, or anywhere when even its darkest pixel is at least
//    lightAny (a faint fleck too light to be ink);
//  - a faint one (darkest >= lightAny) up to 4 x SPECK goes too when isolated:
//    a paper fibre is longer than a speck but just as light;
//  - with rel > 0 (Enhanced, Grayscale) a small speck NEAR big ink goes too
//    when it is much lighter than that ink: on grainy paper the gaps between
//    lines of text are all "near", and grey grain flecks (output 150-215)
//    survived there. A full stop or an i-dot is about as dark as the ink it
//    belongs to, so the speck is compared with the LIGHTEST big ink nearby:
//    it goes when its darkness (255 - darkest) is under rel x that ink's
//    darkness. Next to pencil the lightest ink is the pencil, so pencilled
//    i-dots stay; next to print only, a grey fleck goes.
// "Darkest" is read from depth (the pre-threshold gray, for Black & white) or
// from the output itself. Pathological pages (millions of runs) are left as
// they are rather than risk the WebView's memory.
var MAX_RUNS = 3000000;
// Enhanced / Grayscale thresholds, on output levels: big ink is darker than
// SPECK_INK (pencil lands around 110-150); isolated specks lighter than
// SPECK_ISOLATED go, and any small speck lighter than SPECK_FAINT.
var SPECK_INK = 170, SPECK_ISOLATED = 90, SPECK_FAINT = 215, SPECK_REL = 0.32;
// Black & white, on the flattened gray before thresholding (paper ~255): a
// grain speck thresholds to solid black but was light before (200+), while a
// printed dot (a leader, an ellipsis) was dark, so an isolated speck goes only
// when it was lighter than BW_ISOLATED.
var BW_INK = 190, BW_ISOLATED = 120, BW_FAINT = 205;
function despeckle(d, w, h, depth, isoDark, lightAny, bigDark, rel) {
  var long = w > h ? w : h, speck = Math.max(4, Math.round((long / 500) * (long / 500)));
  var cap = 65536, nr = 0;
  var X0 = new Int32Array(cap), X1 = new Int32Array(cap), RY = new Int32Array(cap), P = new Int32Array(cap), MN = new Uint8Array(cap);
  function grow() {
    cap *= 2;
    var a = new Int32Array(cap); a.set(X0); X0 = a;
    a = new Int32Array(cap); a.set(X1); X1 = a;
    a = new Int32Array(cap); a.set(RY); RY = a;
    a = new Int32Array(cap); a.set(P); P = a;
    var u = new Uint8Array(cap); u.set(MN); MN = u;
  }
  function find(a) { while (P[a] !== a) { P[a] = P[P[a]]; a = P[a]; } return a; }
  var prevS = 0, prevE = 0, x, y, i, v, j;
  for (y = 0; y < h; y++) {
    var rowS = nr, pp = prevS;
    x = 0; i = y * w * 4; j = y * w;
    while (x < w) {
      v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (v >= 250) { x++; i += 4; j++; continue; }
      var x0 = x, mn = 255;
      while (x < w) {
        v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (v >= 250) break;
        if (depth) v = depth[j];
        if (v < mn) mn = v;
        x++; i += 4; j++;
      }
      if (nr === cap) { if (cap * 2 > MAX_RUNS) return; grow(); }
      var r = nr++;
      X0[r] = x0; X1[r] = x - 1; RY[r] = y; P[r] = r; MN[r] = mn;
      for (var p = pp; p < prevE; p++) {
        if (X1[p] < x0 - 1) { pp = p + 1; continue; }
        if (X0[p] > x) break;
        var ra = find(p), rb = find(r);
        if (ra !== rb) { if (ra < rb) P[rb] = ra; else P[ra] = rb; }
      }
    }
    prevS = rowS; prevE = nr;
  }
  if (!nr) return;
  // Component size and darkest pixel, gathered on the root (its first run).
  var A = new Int32Array(nr), k;
  for (k = 0; k < nr; k++) {
    var rt = find(k); P[k] = rt;
    A[rt] += X1[k] - X0[k] + 1;
    if (MN[k] < MN[rt]) MN[rt] = MN[k];
  }
  // Big ink on a coarse grid, grown by the "nearby" radius. Each cell holds
  // 1 + the darkest level of the LIGHTEST big ink touching it (0 = none), so
  // the max filter that grows it keeps the lightest ink in reach.
  var cs = Math.max(2, Math.round(long / 400)), gw = Math.ceil(w / cs), gh = Math.ceil(h / cs);
  var G = new Float32Array(gw * gh), any = false;
  for (k = 0; k < nr; k++) {
    var q = P[k];
    if (A[q] < speck || MN[q] >= bigDark) continue;
    var gr = ((RY[k] / cs) | 0) * gw;
    for (var c = (X0[k] / cs) | 0, ce = (X1[k] / cs) | 0; c <= ce; c++) if (G[gr + c] < MN[q] + 1) G[gr + c] = MN[q] + 1;
    any = true;
  }
  if (any) morph(G, gw, gh, Math.max(1, Math.round(long / 100 / cs)), true);
  for (k = 0; k < nr; k++) {
    var o = P[k], a = A[o];
    if (a >= 4 * speck) continue;
    var gi = G[((RY[o] / cs) | 0) * gw + ((X0[o] / cs) | 0)], near = gi > 0, m = MN[o];
    var faint = near && rel > 0 && 255 - m < rel * (256 - gi);
    if (a < speck ? (m >= lightAny || faint || (!near && m >= isoDark)) : (!near && m >= lightAny)) {
      for (x = X0[k], i = (RY[k] * w + x) * 4; x <= X1[k]; x++, i += 4) { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; }
    }
  }
}

// Stroke guard. Whitening clips everything within a few percent of the paper
// to white, which also erases what is only a little darker than the paper:
// faint pencil, a light signature line, thin table rules. Shadows and paper
// texture must still go, so the guard looks at the SHAPE of the darkening:
//  - a fine "local paper" level (block means at ~1/400 of the long edge, then
//    a closing, which erases anything narrower than ~5 blocks): leftover
//    shading and big shapes are part of it, thin strokes are not;
//  - the noise of the paper around that level (robust MAD), so grain and JPEG
//    noise stay under the guard's threshold;
//  - the darkest pixel near each block, so the edges of real (dark) ink are
//    left alone and printed text does not get bolder.
// A pixel noticeably darker than its local paper (beyond the noise floor) is
// then pushed further from it, by at most CAP, before the tone curve: a faint
// stroke lands in visible grey instead of the clipped white.
var GUARD_GAIN = 1.6, GUARD_CAP = 0.2;
function strokeGuard(d, w, h, s) {
  var long = w > h ? w : h;
  var b = Math.max(2, Math.round(long / 400));
  var gw = Math.ceil(w / b), gh = Math.ceil(h / b), n = gw * gh;
  var P = new Float32Array(n), C = new Float32Array(n), MN = new Float32Array(n), x, y, i, k, v, gb;
  var cx = new Int32Array(w);
  for (x = 0; x < w; x++) cx[x] = (x / b) | 0;
  for (k = 0; k < n; k++) MN[k] = 4;
  for (y = 0; y < h; y++) {
    s.row(y); gb = ((y / b) | 0) * gw;
    for (x = 0, i = y * w * 4; x < w; x++, i += 4) {
      v = lumOf(d[i], d[i + 1], d[i + 2]) * s.L[x]; k = gb + cx[x];
      P[k] += v; C[k] += 1; if (v < MN[k]) MN[k] = v;
    }
  }
  for (k = 0; k < n; k++) P[k] /= C[k];
  ringFromInside(P, gw, gh);
  morph(P, gw, gh, 2, true); morph(P, gw, gh, 2, false);
  boxBlur(P, gw, gh, 1);
  morph(MN, gw, gh, 1, false);
  // Noise floor: median distance of paper-like pixels from the local paper.
  var hist = new Uint32Array(200), total = 0, step = Math.max(1, Math.round(Math.sqrt(w * h / 120000)));
  for (y = 0; y < h; y += step) {
    s.row(y); gb = ((y / b) | 0) * gw;
    for (x = 0, i = y * w * 4; x < w; x += step, i += 4 * step) {
      k = gb + cx[x];
      var r = Math.abs(P[k] - lumOf(d[i], d[i + 1], d[i + 2]) * s.L[x]);
      if (r < 0.1 && P[k] > 0.6) { hist[(r * 2000) | 0]++; total++; }
    }
  }
  var acc = 0, med = 0;
  for (; med < 200 && total; med++) { acc += hist[med]; if (acc * 2 >= total) break; }
  var sigma = 1.4826 * (med + 0.5) / 2000;
  var floor = Math.min(0.1, Math.max(0.03, 4 * sigma));
  var row = new Float32Array(w), x0 = new Int32Array(w), x1 = new Int32Array(w), wx = new Float32Array(w), g;
  for (x = 0; x < w; x++) {
    g = (x + 0.5) / b - 0.5; if (g < 0) g = 0; if (g > gw - 1) g = gw - 1;
    x0[x] = g | 0; x1[x] = Math.min(gw - 1, x0[x] + 1); wx[x] = g - x0[x];
  }
  var cur = 0;
  return {
    // Local paper level per pixel of row y (bilinear) -> guard.P.
    P: row,
    row: function (y) {
      var gy = (y + 0.5) / b - 0.5; if (gy < 0) gy = 0; if (gy > gh - 1) gy = gh - 1;
      var a = (gy | 0) * gw, c = Math.min(gh - 1, (gy | 0) + 1) * gw, t = gy - (gy | 0);
      cur = ((y / b) | 0) * gw;
      for (var xx = 0; xx < w; xx++) {
        var p0 = P[a + x0[xx]] + (P[a + x1[xx]] - P[a + x0[xx]]) * wx[xx];
        var p1 = P[c + x0[xx]] + (P[c + x1[xx]] - P[c + x0[xx]]) * wx[xx];
        row[xx] = p0 + (p1 - p0) * t;
      }
    },
    // How much to darken flattened luminance v at column x (0 = nothing), for
    // a pixel whose neutrality is 0..1 (colour is never pushed).
    boost: function (v, xx, neutral) {
      var lp = row[xx];
      if (lp <= 0 || neutral <= 0) return 0;
      var e = 1 - v / lp - floor;
      if (e <= 0) return 0;
      var ink = 1 - MN[cur + cx[xx]] / lp;          // darkest pixel nearby
      var keep = (ink - 0.5) / 0.2; keep = keep < 0 ? 0 : (keep > 1 ? 1 : keep);
      e *= GUARD_GAIN; if (e > GUARD_CAP) e = GUARD_CAP;
      return lp * e * (1 - keep) * neutral;
    },
    floor: floor,
    // Darkest flattened luminance near column xx of the current row (R12,
    // read by Faint text; the filters above never call it).
    ink: function (xx) { return MN[cur + cx[xx]]; },
  };
}

// Colour weight of a flattened pixel (channels relative to paper, 1 = paper):
// 0 for neutral ink, pencil, grain and faint casts, 1 for real colour.
function colourWeight(r, g, b) {
  var mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
  var c = (mx - mn - 0.05) / 0.1;
  return c < 0 ? 0 : (c > 1 ? 1 : c);
}

// Colour keeps more of its own shade than text does: half the black point.
var COLOUR_BP = 0.5, CHROMA_GAIN = 1.3, CHROMA_KEEP = 0.85;

// Enhanced: luminance and colour are toned separately so hue survives. Neutral
// pixels follow the text curve; coloured ones keep their own channel ratios
// (so hue and saturation match the print: measured on the R5 colour invoice,
// stamp 0.61 printed -> 0.63, teal 0.88 -> 0.90, where adding the opponent
// colour on top of a darkened luminance gave teal 1.00 and blue ink 0.91) on
// the gentle colour curve, with pixels in between blended by colour weight.
function docMagic(d, w, h) {
  var s = makeSampler(estimateBackground(d, w, h), w, h);
  var bp = blackPoint(d, w, h, s), wp = paperSpread(d, w, h, s).white;
  var lutN = toneLut(bp, 1.7, wp), lutC = toneLut(bp * COLOUR_BP, 1.0, wp);
  var guard = strokeGuard(d, w, h, s);
  for (var y = 0; y < h; y++) {
    s.row(y); guard.row(y);
    for (var x = 0, i = y * w * 4; x < w; x++, i += 4) {
      var r = d[i] * s.R[x], g = d[i + 1] * s.G[x], b = d[i + 2] * s.B[x];
      var l = 0.299 * r + 0.587 * g + 0.114 * b;
      var k = colourWeight(r, g, b);
      var yn = lutN[lutIndex(l - guard.boost(l, x, 1 - k))];
      if (k > 0) {
        // Colour: every channel scaled by the same factor, so hue and
        // saturation are the flattened pixel's own; then a little chroma back
        // (the camera's blur mixes thin coloured strokes with the paper),
        // capped so the weakest channel keeps CHROMA_KEEP of itself: already
        // vivid colour (a logo) gains almost nothing and never turns neon.
        var cl = lutC[lutIndex(l)], q = cl / (l > 0.01 ? l : 0.01);
        var cr = r * q, cg = g * q, cb = b * q, mn = cr < cg ? (cr < cb ? cr : cb) : (cg < cb ? cg : cb);
        var sg = CHROMA_GAIN;
        if (cl - mn > 1e-4) { var cap = (cl - CHROMA_KEEP * mn) / (cl - mn); if (cap < sg) sg = cap < 1 ? 1 : cap; }
        cr = cl + (cr - cl) * sg; cg = cl + (cg - cl) * sg; cb = cl + (cb - cl) * sg;
        d[i] = 255 * (yn + (cr - yn) * k); d[i + 1] = 255 * (yn + (cg - yn) * k); d[i + 2] = 255 * (yn + (cb - yn) * k);
      } else {
        d[i] = d[i + 1] = d[i + 2] = 255 * yn;
      }
    }
  }
  despeckle(d, w, h, null, SPECK_ISOLATED, SPECK_FAINT, SPECK_INK, SPECK_REL);
}

function docGray(d, w, h) {
  var s = makeSampler(estimateBackground(d, w, h), w, h);
  var lut = toneLut(blackPoint(d, w, h, s), 1.8, paperSpread(d, w, h, s).white);
  var guard = strokeGuard(d, w, h, s);
  for (var y = 0; y < h; y++) {
    s.row(y); guard.row(y);
    for (var x = 0, i = y * w * 4; x < w; x++, i += 4) {
      var r = d[i] * s.R[x], g = d[i + 1] * s.G[x], b = d[i + 2] * s.B[x];
      var l = 0.299 * r + 0.587 * g + 0.114 * b;
      var v = 255 * lut[lutIndex(l - guard.boost(l, x, 1 - colourWeight(r, g, b)))];
      d[i] = v; d[i + 1] = v; d[i + 2] = v;
    }
  }
  despeckle(d, w, h, null, SPECK_ISOLATED, SPECK_FAINT, SPECK_INK, SPECK_REL);
}

// Sauvola threshold T = m * (1 + k * (sd / 128 - 1)) over a square window, on
// the flattened gray, capped at m - BETA * sd. The small k keeps faint pencil
// (low sd) above the line; the cap stops strong text (high sd, where Sauvola
// sits close to the mean) from swelling into bold blobs on a soft photo. m and sd come from running sums of a vertical strip per
// column plus a horizontal running sum per row: O(1) per pixel, O(w) memory.
function docBW(d, w, h, op) {
  var bias = op.bias || 0, crisp = op.crisp || 0;
  var s = makeSampler(estimateBackground(d, w, h), w, h);
  var sp = paperSpread(d, w, h, s);
  var n = w * h, gray = new Uint8ClampedArray(n), x, y, i, j;
  for (y = 0; y < h; y++) {
    s.row(y);
    for (x = 0, i = y * w * 4, j = y * w; x < w; x++, i += 4, j++) {
      var l = lumOf(d[i], d[i + 1], d[i + 2]) * s.L[x];
      // A light colour fill (highlighter, a tinted table header) is paper,
      // not ink: thresholding its luminance left dotted outlines along its
      // edges. Light coloured pixels take their brightest channel instead;
      // dark colour (stamps, blue ink, text on the fill) is unaffected.
      if (l > 0.7) {
        var cr = d[i] * s.R[x], cg = d[i + 1] * s.G[x], cb = d[i + 2] * s.B[x];
        var k = colourWeight(cr, cg, cb) * Math.min(1, (l - 0.7) / 0.1);
        if (k > 0) { var mx = cr > cg ? (cr > cb ? cr : cb) : (cg > cb ? cg : cb); l += (mx - l) * k; }
      }
      gray[j] = l * 255;
    }
  }
  var long = w > h ? w : h;
  var r = Math.max(4, Math.round(long / 90));
  var K = 0.1, BETA = 0.55, MID = 0.5;
  // Brightness slider: shifts the threshold, never past bare paper (which stays
  // white whatever the setting) — brighter drops faint marks, darker keeps more.
  var tShift = -25 * bias;
  var half = Math.max(2, 10 * (1 - 0.8 * crisp));
  // Flattened paper sits at 255, so anything under half of it is ink whatever
  // its neighbourhood: Sauvola alone turns the inside of a large dark area
  // white (its local mean is dark too).
  var dark = 120 - 30 * bias;
  // Bare paper: always white. On grainy paper the cut follows the paper's
  // spread down (as Enhanced's white point does), so grain is paper too.
  var cut = 255 * (sp.median - 2.5 * sp.sigma);
  cut = cut > 242 ? 242 : (cut < 209 ? 209 : cut);
  // Stroke-width guard. Sauvola's threshold sits well above the midpoint
  // between ink and paper wherever the window is mostly paper, so the blurred
  // rim of every stroke turned black: small serif text came out bold and the
  // holes of e, a, o and 8 filled in. The true edge of a blurred stroke is
  // where it is halfway between its own ink and the paper, so the threshold is
  // also capped at that midpoint, with the ink level read as the darkest pixel
  // within a stroke's reach (about 1/800 of the long side). Faint pencil
  // and thin rules are measured against their own (light) ink, so they keep
  // their width instead of vanishing; bare paper is still cut to white above.
  // On big pages the minimum is taken on cells of a few pixels (block minima,
  // then a min filter over the cells), which keeps the cost per pixel small.
  var mr = Math.max(1, Math.round(long / 800)), ms = Math.max(1, Math.round(mr / 3));
  var mgw = Math.ceil(w / ms), mgh = Math.ceil(h / ms), MINS = new Uint8Array(mgw * mgh).fill(255);
  var mcx = new Int32Array(w);
  for (x = 0; x < w; x++) mcx[x] = (x / ms) | 0;
  for (y = 0; y < h; y++) {
    var mrow = ((y / ms) | 0) * mgw;
    for (x = 0, j = y * w; x < w; x++, j++) if (gray[j] < MINS[mrow + mcx[x]]) MINS[mrow + mcx[x]] = gray[j];
  }
  morph(MINS, mgw, mgh, Math.ceil(mr / ms), false);
  var paperL = sp.median < 1 ? 255 * sp.median : 255;
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
    var minRow = ((y / ms) | 0) * mgw;
    var S = 0, Q = 0, cols = 0;
    for (x = 0; x < r && x < w; x++) { S += colS[x]; Q += colQ[x]; cols++; }
    for (x = 0, j = y * w, i = y * w * 4; x < w; x++, j++, i += 4) {
      if (x + r < w) { S += colS[x + r]; Q += colQ[x + r]; cols++; }
      if (x - r - 1 >= 0) { S -= colS[x - r - 1]; Q -= colQ[x - r - 1]; cols--; }
      var cnt = rows * cols, m = S / cnt, va = Q / cnt - m * m;
      var sd = va > 0 ? Math.sqrt(va) : 0;
      var T = m * (1 + K * (sd / 128 - 1));
      var T2 = m - BETA * sd;
      if (T2 < T) T = T2;
      var ink = MINS[minRow + mcx[x]], T3 = ink + MID * (paperL - ink);
      T = (T3 < T ? T3 : T) + tShift;
      v = gray[j];
      var o;
      if (v >= cut) o = 255;                 // bare paper
      else if (v < dark) o = 0;              // clearly ink: black, so big dark areas never go hollow
      else o = clamp((v - T + half) * (255 / (2 * half)));
      d[i] = o; d[i + 1] = o; d[i + 2] = o;
    }
  }
  despeckle(d, w, h, gray, BW_ISOLATED, BW_FAINT, BW_INK, 0);
}

// ── R12 filters ─────────────────────────────────────────────────────────────
// Added alongside the four originals, which must keep producing exactly the
// pixels they always have (stored filter ids are re-applied on every re-bake;
// see __tests__/filters-legacy-snapshot.test.ts). New maths goes in new
// functions; the shared helpers above are only read.

// No shadow: the lighting is flattened per channel exactly as Enhanced does
// (shadows, uneven light and the paper's yellow go), but the tone stays the
// photo's own: a gentle curve that only sets white just under the paper and
// eases the black point, with no ink darkening, no colour boost and no grain
// clipping. Text keeps its printed weight, photos on the page their mid-tones.
function docNoShadow(d, w, h) {
  var s = makeSampler(estimateBackground(d, w, h), w, h);
  var bp = blackPoint(d, w, h, s) * 0.5, sp = paperSpread(d, w, h, s);
  // White just under the paper's median: bare paper is white.
  // On grainy paper it follows the grain down (as Enhanced's does), else
  // the darker half of the grain is left as a grey mottle.
  var wp = sp.median - 2 * sp.sigma, wmax = sp.median * 0.965;
  if (wp > wmax) wp = wmax; if (wp > 1) wp = 1; if (wp < 0.8) wp = 0.8;
  var lut = toneLut(bp, 1.1, wp);
  for (var y = 0; y < h; y++) {
    s.row(y);
    for (var x = 0, i = y * w * 4; x < w; x++, i += 4) {
      d[i] = 255 * lut[lutIndex(d[i] * s.R[x])];
      d[i + 1] = 255 * lut[lutIndex(d[i + 1] * s.G[x])];
      d[i + 2] = 255 * lut[lutIndex(d[i + 2] * s.B[x])];
    }
  }
  // Only lone flecks of grain go; nothing next to real ink is touched.
  despeckle(d, w, h, null, SPECK_ISOLATED, SPECK_FAINT, SPECK_INK, 0);
}

// Luminance histogram (256 bins), sampled to about 250k pixels.
function lumHist(d, w, h) {
  var hist = new Uint32Array(256), total = 0, step = Math.max(1, Math.round(Math.sqrt(w * h / 250000)));
  for (var y = 0; y < h; y += step) {
    for (var x = 0, i = y * w * 4; x < w; x += step, i += 4 * step) {
      hist[(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0]++; total++;
    }
  }
  return { hist: hist, total: total };
}
function histPct(hh, p) {
  var target = hh.total * p, acc = 0;
  for (var b = 0; b < 256; b++) { acc += hh.hist[b]; if (acc >= target) return b; }
  return 255;
}

// Photo: no flattening (a photo's light and shade are part of it). Levels are
// stretched on luminance, the same map on every channel so hue is kept: the
// darkest 0.3% to black and the brightest 0.5% to white, never by more than
// a sensible amount on an already full-range picture. Then a soft S-curve,
// a little more saturation, and light sharpening.
function docPhoto(d, w, h) {
  var hh = lumHist(d, w, h);
  var lo = histPct(hh, 0.002), hi = histPct(hh, 0.998);
  if (lo > 50) lo = 50; if (hi < 215) hi = 215; if (hi - lo < 64) { lo = 0; hi = 255; }
  var lut = new Float32Array(256), k;
  for (k = 0; k < 256; k++) {
    var t = (k - lo) / (hi - lo); t = t < 0 ? 0 : (t > 1 ? 1 : t);
    var sm = t * t * (3 - 2 * t);
    lut[k] = 255 * (t + (sm - t) * 0.3);
  }
  var SAT = 1.18;
  for (var i = 0; i < d.length; i += 4) {
    var r = lut[d[i]], g = lut[d[i + 1]], b = lut[d[i + 2]];
    var l = 0.299 * r + 0.587 * g + 0.114 * b;
    d[i] = l + (r - l) * SAT; d[i + 1] = l + (g - l) * SAT; d[i + 2] = l + (b - l) * SAT;
  }
  sharpen(d, w, h, 0.35);
}

// Whiteboard: the board's glare, reflections and ghosting of old writing are
// flattened and clipped to white harder than on paper, and marker strokes are
// made bold and saturated (a photo of a whiteboard shows them dull and thin).
function docBoard(d, w, h) {
  var s = makeSampler(estimateBackground(d, w, h), w, h);
  var bp = blackPoint(d, w, h, s), sp = paperSpread(d, w, h, s);
  var wp = sp.white < 0.88 ? sp.white : 0.88;
  var lutN = toneLut(bp, 1.8, wp), lutC = toneLut(bp * COLOUR_BP, 1.35, wp);
  // No stroke guard here: the faint strokes it would save are exactly the
  // ghosts of erased writing a whiteboard photo is full of.
  var SAT = 1.9;
  for (var y = 0; y < h; y++) {
    s.row(y);
    for (var x = 0, i = y * w * 4; x < w; x++, i += 4) {
      var r = d[i] * s.R[x], g = d[i + 1] * s.G[x], b = d[i + 2] * s.B[x];
      var l = 0.299 * r + 0.587 * g + 0.114 * b;
      var mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      // Marker colour is weak in a photo: a lower bar than Enhanced's.
      var k = (mx - mn - 0.03) / 0.07; k = k < 0 ? 0 : (k > 1 ? 1 : k);
      var yn = lutN[lutIndex(l)];
      if (k > 0) {
        var cl = lutC[lutIndex(l)], q = cl / (l > 0.01 ? l : 0.01);
        var cr = r * q, cg = g * q, cb = b * q, cm = cr < cg ? (cr < cb ? cr : cb) : (cg < cb ? cg : cb);
        var sg = SAT;
        // Never past zero on the weakest channel (that would shift the hue).
        if (cl - cm > 1e-4 && cl / (cl - cm) < sg) sg = cl / (cl - cm);
        cr = cl + (cr - cl) * sg; cg = cl + (cg - cl) * sg; cb = cl + (cb - cl) * sg;
        d[i] = 255 * (yn + (cr - yn) * k); d[i + 1] = 255 * (yn + (cg - yn) * k); d[i + 2] = 255 * (yn + (cb - yn) * k);
      } else {
        d[i] = d[i + 1] = d[i + 2] = 255 * yn;
      }
    }
  }
  despeckle(d, w, h, null, SPECK_ISOLATED, SPECK_FAINT, SPECK_INK, SPECK_REL);
}

// Faint text: for pencil, faded print and thermal receipts. Lighting is
// flattened as for Grayscale; then every stroke is darkened relative to the
// darkest ink near it (strokeGuard's local paper and local ink), so a stroke
// only a little darker than the paper is stretched towards black while print
// that is already black stays as it is. The stretch is capped (a faint
// stroke can gain at most FAINT_GAIN times its contrast) and starts above the
// paper's own noise, so grain, JPEG noise and the shading of a shadow edge are
// not "found" as writing. Output is gray.
var FAINT_GAIN = 6, FAINT_NORM = 0.8, FAINT_SPECK = 228;
function docFaint(d, w, h) {
  var s = makeSampler(estimateBackground(d, w, h), w, h);
  var guard = strokeGuard(d, w, h, s), fl = guard.floor;
  // Large shapes (a logo, a photo, a filled box) are part of the guard's
  // "local paper", so on their own they would come out as hollow outlines:
  // every pixel is also toned exactly as Grayscale tones it, and the darker
  // wins. That Grayscale tone is kept as the despeckle depth, too.
  var lut = toneLut(blackPoint(d, w, h, s), 1.8, paperSpread(d, w, h, s).white);
  var depth = new Uint8ClampedArray(w * h);
  for (var y = 0, j = 0; y < h; y++) {
    s.row(y); guard.row(y);
    for (var x = 0, i = y * w * 4; x < w; x++, i += 4, j++) {
      var r = d[i] * s.R[x], gg = d[i + 1] * s.G[x], b = d[i + 2] * s.B[x];
      var v = 0.299 * r + 0.587 * gg + 0.114 * b, lp = guard.P[x];
      var o = 255 * lut[lutIndex(v - guard.boost(v, x, 1 - colourWeight(r, gg, b)))];
      depth[j] = o;
      if (lp > 0.05) {
        var t = 1 - v / lp - fl;
        if (t > 0) {
          // The darkest ink nearby maps to (just past) black: print stays
          // black, a pencil stroke is stretched towards it, by at most GAIN.
          var ink = (1 - guard.ink(x) / lp - fl) * FAINT_NORM;
          var g = 1 / (ink > 0.02 ? ink : 0.02);
          if (g > FAINT_GAIN) g = FAINT_GAIN; if (g < 1) g = 1;
          var dk = t * g;
          dk = dk >= 1 ? 1 : Math.pow(dk, 0.85);
          if (255 * (1 - dk) < o) o = 255 * (1 - dk);
        }
      }
      d[i] = o; d[i + 1] = o; d[i + 2] = o;
    }
  }
  // The stretch also turns the odd fleck of grain or a paper fibre black. A
  // small mark goes when Grayscale would have shown it barely or not at all
  // (FAINT_SPECK), or when it is isolated and was not dark there; a pencil
  // i-dot or a full stop shows in Grayscale and sits next to its word.
  despeckle(d, w, h, depth, SPECK_INK, FAINT_SPECK, SPECK_INK, 0);
}

// Ink saver: Grayscale's clean page, then ink is printed lighter. Text becomes
// a dark gray that still reads crisply, and large solid areas (a photo, a
// filled box, a dark header bar) are lightened much more, since that is where
// the toner goes. "Solid" is the share of dark pixels around each point on a
// coarse grid (about 1.5% of the long side), bilinear so there are no blocks.
function docEco(d, w, h) {
  docGray(d, w, h);
  var long = w > h ? w : h, cs = Math.max(2, Math.round(long / 300));
  var gw = Math.ceil(w / cs), gh = Math.ceil(h / cs), n = gw * gh;
  var C = new Float32Array(n), N = new Float32Array(n), x, y, i, k;
  var cx = new Int32Array(w);
  for (x = 0; x < w; x++) cx[x] = (x / cs) | 0;
  for (y = 0; y < h; y++) {
    var gb = ((y / cs) | 0) * gw;
    for (x = 0, i = y * w * 4; x < w; x++, i += 4) { k = gb + cx[x]; C[k] += 255 - d[i]; N[k] += 255; }
  }
  for (k = 0; k < n; k++) C[k] /= N[k];
  boxBlur(C, gw, gh, Math.max(1, Math.round(long / 70 / cs)));
  var x0 = new Int32Array(w), x1 = new Int32Array(w), wx = new Float32Array(w), row = new Float32Array(w), g;
  for (x = 0; x < w; x++) {
    g = (x + 0.5) / cs - 0.5; if (g < 0) g = 0; if (g > gw - 1) g = gw - 1;
    x0[x] = g | 0; x1[x] = Math.min(gw - 1, x0[x] + 1); wx[x] = g - x0[x];
  }
  var TEXT = 0.7, SOLID = 0.28;
  for (y = 0; y < h; y++) {
    var gy = (y + 0.5) / cs - 0.5; if (gy < 0) gy = 0; if (gy > gh - 1) gy = gh - 1;
    var a = (gy | 0) * gw, c = Math.min(gh - 1, (gy | 0) + 1) * gw, t = gy - (gy | 0);
    for (x = 0; x < w; x++) {
      var p0 = C[a + x0[x]] + (C[a + x1[x]] - C[a + x0[x]]) * wx[x];
      var p1 = C[c + x0[x]] + (C[c + x1[x]] - C[c + x0[x]]) * wx[x];
      row[x] = p0 + (p1 - p0) * t;
    }
    for (x = 0, i = y * w * 4; x < w; x++, i += 4) {
      var dk = 255 - d[i];
      if (!dk) continue;
      var sol = (row[x] - 0.35) / 0.3; sol = sol < 0 ? 0 : (sol > 1 ? 1 : sol);
      var o = 255 - dk * (TEXT + (SOLID - TEXT) * sol);
      d[i] = o; d[i + 1] = o; d[i + 2] = o;
    }
  }
}

// Sharpness (Adjust slider, -1..1) and Photo's built-in crispness: an unsharp
// mask on luminance (the same offset added to every channel, so no colour
// fringes), radius about 1/1500 of the long side. Positive sharpens, negative
// softens (a box blur blended in, for noisy pages). Differences under 2 levels
// are left alone so paper grain and JPEG noise are not sharpened, and the
// offset is capped so edges get crisper without bright or dark halos.
// Streams the image: the box sums keep (2r + 2) rows of original luminance in
// a ring, so memory is O(w * r) whatever the page size.
function sharpen(d, w, h, amt) {
  if (!amt || w < 3 || h < 3) return;
  var long = w > h ? w : h, r = Math.max(1, Math.round(long / 1500));
  var R = 2 * r + 2, ring = new Uint8Array(R * w), col = new Int32Array(w), x, y, i;
  function load(yy) {
    var base = (yy % R) * w;
    for (var xx = 0, ii = yy * w * 4; xx < w; xx++, ii += 4) {
      var v = (0.299 * d[ii] + 0.587 * d[ii + 1] + 0.114 * d[ii + 2] + 0.5) | 0;
      ring[base + xx] = v; col[xx] += v;
    }
  }
  function drop(yy) {
    var base = (yy % R) * w;
    for (var xx = 0; xx < w; xx++) col[xx] -= ring[base + xx];
  }
  for (y = 0; y <= r && y < h; y++) load(y);
  var gain = amt > 0 ? amt * 1.6 : amt, CAP = 48;
  for (y = 0; y < h; y++) {
    if (y > 0) {
      if (y + r < h) load(y + r);
      if (y - r - 1 >= 0) drop(y - r - 1);
    }
    var rows = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1, base = (y % R) * w;
    var S = 0, cols = 0;
    for (x = 0; x < r && x < w; x++) { S += col[x]; cols++; }
    for (x = 0, i = y * w * 4; x < w; x++, i += 4) {
      if (x + r < w) { S += col[x + r]; cols++; }
      if (x - r - 1 >= 0) { S -= col[x - r - 1]; cols--; }
      var v = ring[base + x], diff = v - S / (rows * cols);
      if (amt > 0 && diff < 2 && diff > -2) continue;
      var off = diff * gain;
      if (off > CAP) off = CAP; else if (off < -CAP) off = -CAP;
      d[i] += off; d[i + 1] += off; d[i + 2] += off;
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
    else if (op.noshadow) docNoShadow(d, w, h);
    else if (op.photo) docPhoto(d, w, h);
    else if (op.board) docBoard(d, w, h);
    else if (op.faint) docFaint(d, w, h);
    else if (op.eco) docEco(d, w, h);
    else if ('sharpen' in op) sharpen(d, w, h, op.sharpen);
    else for (var key in op) applyPrimitive(d, key, op[key]);
  }
}
`;
