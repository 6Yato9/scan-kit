// lib/markup-core.ts
//
// The drawing engine of Markup (app/annotate.tsx), as plain JavaScript that
// runs inside its WebView. It lives in a string so the exact same code is
// injected into the page and evaluated by jest (__tests__/markup-core.test.ts);
// Hermes keeps no function source, so `fn.toString()` can't be used for that.
//
// Model. Every mark is an immutable "op" in PAGE PIXELS (the image's natural
// size), never screen points:
//   { type: 'stroke', tool: 'pen' | 'highlighter' | 'eraser', color, width, points: [[x, y], …] }
//   { type: 'shape',  shape: 'rect' | 'ellipse' | 'line' | 'arrow', color, width, x1, y1, x2, y2 }
//   { type: 'text',   id, text, color, size, x, y }       (x, y: top-left of the first line)
// The same renderOps() draws them on screen (through the zoom transform) and
// into the saved page (at natural size), so the result is exactly what was
// previewed.
//
// Layers. Highlighter strokes go on their own layer, drawn opaque and then
// MULTIPLIED onto the page (CSS mix-blend-mode on screen, canvas 'multiply' on
// save) — print under a highlight stays dark, overlapping highlights don't
// build up. Pen, shapes and text go on the ink layer above it. The eraser
// clears both layers (never the page itself) along its path.
//
// History. A list of ops states: every action (stroke, shape, text added,
// edited, moved or deleted, Erase all) pushes one, so Undo / Redo cover all
// of them.

export const MARKUP_CORE_JS = String.raw`
var MK = (function () {
  var FONT = '-apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif';
  var LINE_HEIGHT = 1.25;

  function fitView(vw, vh, iw, ih, pad) {
    pad = pad || 0;
    var k = Math.min(Math.max(vw - 2 * pad, 1) / iw, Math.max(vh - 2 * pad, 1) / ih);
    return { k: k, x: (vw - iw * k) / 2, y: (vh - ih * k) / 2 };
  }

  /** Screen point -> page pixels. */
  function toImage(view, sx, sy) {
    return { x: (sx - view.x) / view.k, y: (sy - view.y) / view.k };
  }

  /**
   * Keeps the zoom between the fitted size and maxZoom times it, and the page
   * on screen: centred along an axis where it is smaller than the view, its
   * edges never pulled inside the view where it is larger.
   */
  function clampView(view, fit, vw, vh, iw, ih, maxZoom) {
    var k = Math.max(fit.k, Math.min(fit.k * maxZoom, view.k));
    var w = iw * k, h = ih * k;
    var x = view.x, y = view.y;
    if (k !== view.k) {
      // Re-anchor on the view's centre when the zoom was clamped.
      var c = toImage(view, vw / 2, vh / 2);
      x = vw / 2 - c.x * k;
      y = vh / 2 - c.y * k;
    }
    if (k <= fit.k + 1e-9) return { k: fit.k, x: fit.x, y: fit.y };
    x = w <= vw ? (vw - w) / 2 : Math.min(0, Math.max(vw - w, x));
    y = h <= vh ? (vh - h) / 2 : Math.min(0, Math.max(vh - h, y));
    return { k: k, x: x, y: y };
  }

  /**
   * Two-finger pinch and pan: the page point that was under the fingers'
   * midpoint at the start stays under their midpoint now.
   */
  function pinchView(start, a0, b0, a1, b1) {
    var d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y);
    var d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
    var f = d0 > 0 ? d1 / d0 : 1;
    var m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
    var m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
    var p = toImage(start, m0.x, m0.y);
    var k = start.k * f;
    return { k: k, x: m1.x - p.x * k, y: m1.y - p.y * k };
  }

  /** The two barbs of an arrow pointing at (x2, y2), sized to its line width. */
  function arrowHead(x1, y1, x2, y2, width) {
    var len = Math.max(width * 4.5, 10);
    var ang = Math.atan2(y2 - y1, x2 - x1);
    var spread = Math.PI / 7;
    return [
      [x2 - len * Math.cos(ang - spread), y2 - len * Math.sin(ang - spread)],
      [x2 - len * Math.cos(ang + spread), y2 - len * Math.sin(ang + spread)],
    ];
  }

  function fontFor(size) {
    return '600 ' + size + 'px ' + FONT;
  }

  /**
   * The box a text op covers, in page pixels. 'measure(font, line)' returns a
   * line's width (a canvas measureText in the page, a stub in tests).
   */
  function textBox(op, measure) {
    var lines = String(op.text).split('\n');
    var w = 0;
    for (var i = 0; i < lines.length; i++) w = Math.max(w, measure(fontFor(op.size), lines[i]));
    return { x: op.x, y: op.y, w: w, h: lines.length * op.size * LINE_HEIGHT };
  }

  /** The topmost text op at page point (x, y) (with a little slop), or null. */
  function hitText(ops, x, y, measure, slop) {
    for (var i = ops.length - 1; i >= 0; i--) {
      var op = ops[i];
      if (op.type !== 'text') continue;
      var b = textBox(op, measure);
      var s = (slop || 0) + op.size * 0.25;
      if (x >= b.x - s && x <= b.x + b.w + s && y >= b.y - s && y <= b.y + b.h + s) return op;
    }
    return null;
  }

  /** Keeps a text box inside the page (as far as it fits). */
  function clampTextPos(op, iw, ih, measure) {
    var b = textBox(op, measure);
    var x = Math.min(Math.max(op.x, 0), Math.max(0, iw - b.w));
    var y = Math.min(Math.max(op.y, 0), Math.max(0, ih - b.h));
    return { x: x, y: y };
  }

  // ── History ───────────────────────────────────────────────────────────────
  function History() {
    this.ops = [];
    this.past = [];
    this.future = [];
  }
  History.prototype.commit = function (ops) {
    this.past.push(this.ops);
    if (this.past.length > 200) this.past.shift();
    this.ops = ops;
    this.future = [];
  };
  History.prototype.undo = function () {
    if (!this.past.length) return false;
    this.future.push(this.ops);
    this.ops = this.past.pop();
    return true;
  };
  History.prototype.redo = function () {
    if (!this.future.length) return false;
    this.past.push(this.ops);
    this.ops = this.future.pop();
    return true;
  };
  History.prototype.add = function (op) { this.commit(this.ops.concat([op])); };
  /** Replaces the op with id (patch merged); no-op when nothing changes. */
  History.prototype.update = function (id, patch) {
    var changed = false;
    var next = this.ops.map(function (op) {
      if (op.id !== id) return op;
      var out = {};
      for (var k in op) out[k] = op[k];
      for (var p in patch) { if (out[p] !== patch[p]) changed = true; out[p] = patch[p]; }
      return out;
    });
    if (changed) this.commit(next);
    return changed;
  };
  History.prototype.remove = function (id) {
    var next = this.ops.filter(function (op) { return op.id !== id; });
    if (next.length !== this.ops.length) this.commit(next);
  };
  History.prototype.clear = function () { if (this.ops.length) this.commit([]); };
  History.prototype.state = function () {
    return { canUndo: this.past.length > 0, canRedo: this.future.length > 0, count: this.ops.length };
  };

  // ── Drawing ───────────────────────────────────────────────────────────────
  function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }

  function styleStroke(ctx, op) {
    ctx.globalCompositeOperation = op.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = op.tool === 'eraser' ? '#000' : op.color;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = op.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  /** A freehand path, smoothed through the midpoints of its samples. */
  function tracePath(ctx, pts, width) {
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0][0], pts[0][1], width / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    var m = mid(pts[0], pts[1]);
    ctx.lineTo(m[0], m[1]);
    for (var i = 1; i < pts.length - 1; i++) {
      var n = mid(pts[i], pts[i + 1]);
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], n[0], n[1]);
    }
    var last = pts[pts.length - 1];
    ctx.lineTo(last[0], last[1]);
    ctx.stroke();
  }

  /**
   * The piece of a freehand path that sample 'i' (just added) completes, drawn
   * while the finger moves. Opaque colours on their own layers make the union
   * of the pieces identical to tracePath of the whole stroke.
   */
  function traceSegment(ctx, pts, i, final) {
    ctx.beginPath();
    if (i === 1) {
      ctx.moveTo(pts[0][0], pts[0][1]);
      var m1 = mid(pts[0], pts[1]);
      ctx.lineTo(m1[0], m1[1]);
    } else {
      var a = mid(pts[i - 2], pts[i - 1]);
      var b = mid(pts[i - 1], pts[i]);
      ctx.moveTo(a[0], a[1]);
      ctx.quadraticCurveTo(pts[i - 1][0], pts[i - 1][1], b[0], b[1]);
    }
    if (final) {
      var l = pts[pts.length - 1];
      ctx.lineTo(l[0], l[1]);
    }
    ctx.stroke();
  }

  function drawShape(ctx, op) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = op.color;
    ctx.fillStyle = op.color;
    ctx.lineWidth = op.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    var x = Math.min(op.x1, op.x2), y = Math.min(op.y1, op.y2);
    var w = Math.abs(op.x2 - op.x1), h = Math.abs(op.y2 - op.y1);
    ctx.beginPath();
    if (op.shape === 'rect') {
      ctx.rect(x, y, w, h);
    } else if (op.shape === 'ellipse') {
      ctx.ellipse(x + w / 2, y + h / 2, Math.max(w / 2, 0.5), Math.max(h / 2, 0.5), 0, 0, Math.PI * 2);
    } else {
      ctx.moveTo(op.x1, op.y1);
      ctx.lineTo(op.x2, op.y2);
      if (op.shape === 'arrow') {
        var hd = arrowHead(op.x1, op.y1, op.x2, op.y2, op.width);
        ctx.moveTo(hd[0][0], hd[0][1]);
        ctx.lineTo(op.x2, op.y2);
        ctx.lineTo(hd[1][0], hd[1][1]);
      }
    }
    ctx.stroke();
  }

  function drawText(ctx, op) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = op.color;
    ctx.font = fontFor(op.size);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    var lines = String(op.text).split('\n');
    for (var i = 0; i < lines.length; i++) {
      // Half the extra line height above each line, like CSS line-height.
      ctx.fillText(lines[i], op.x, op.y + i * op.size * LINE_HEIGHT + op.size * (LINE_HEIGHT - 1) / 2);
    }
  }

  /**
   * Draws 'ops' in order onto the highlight and ink layers (contexts already
   * transformed so that one unit is one page pixel, and cleared).
   */
  function renderOps(ops, hl, ink) {
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (op.type === 'stroke') {
        if (op.tool === 'eraser') {
          styleStroke(hl, op); tracePath(hl, op.points, op.width);
          styleStroke(ink, op); tracePath(ink, op.points, op.width);
        } else {
          var c = op.tool === 'highlighter' ? hl : ink;
          styleStroke(c, op); tracePath(c, op.points, op.width);
        }
      } else if (op.type === 'shape') {
        drawShape(ink, op);
      } else if (op.type === 'text') {
        drawText(ink, op);
      }
    }
    hl.globalCompositeOperation = 'source-over';
    ink.globalCompositeOperation = 'source-over';
  }

  function hasHighlights(ops) {
    for (var i = 0; i < ops.length; i++) if (ops[i].tool === 'highlighter') return true;
    return false;
  }

  /** Output size for a page: natural size, scaled down only past the canvas pixel limit. */
  function outputSize(w, h, maxPixels) {
    var f = w * h > maxPixels ? Math.sqrt(maxPixels / (w * h)) : 1;
    return { w: Math.max(1, Math.floor(w * f)), h: Math.max(1, Math.floor(h * f)) };
  }

  /** A shape too small to mean anything (a tap with the shape tool). */
  function isTinyShape(op, minLen) {
    return Math.hypot(op.x2 - op.x1, op.y2 - op.y1) < minLen;
  }

  return {
    fitView: fitView, toImage: toImage, clampView: clampView, pinchView: pinchView,
    arrowHead: arrowHead, fontFor: fontFor, textBox: textBox, hitText: hitText, clampTextPos: clampTextPos,
    History: History, styleStroke: styleStroke, tracePath: tracePath, traceSegment: traceSegment,
    drawShape: drawShape, drawText: drawText, renderOps: renderOps, hasHighlights: hasHighlights,
    outputSize: outputSize, isTinyShape: isTinyShape, LINE_HEIGHT: LINE_HEIGHT,
  };
})();
`;
