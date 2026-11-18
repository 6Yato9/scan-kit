// lib/markup-html.ts
// The page Markup (app/annotate.tsx) runs in its LocalWebView: the page image
// as a zoomable layer, the highlight / ink / guide canvases over it, touch
// handling, and the save (getResult). The drawing engine is lib/markup-core.ts.
//
// Messages to the app: READY:{w,h} · LOAD_ERROR · STATE:{canUndo,canRedo,count}
//   · TEXT_NEW:{x,y} · TEXT_EDIT:{id,text,color,size} · RESULT:{page,orig} · ERROR:<reason>
// Calls from the app: setConfig({...}) · addText(x,y,text,color,size) ·
//   updateText(id,text,color,size) · deleteText(id) · undo() · redo() · clearAll() · getResult()
// Sizes from the app (pen widths, text size) are in screen points at the
// page's fitted size; the page converts them to page pixels.
import { MARKUP_CORE_JS } from './markup-core';

/** Largest canvas the save draws (iOS WebKit refuses canvases above 4096², see lib/bake-html.ts). */
export const MARKUP_MAX_PIXELS = 16_000_000;

export type MarkupConfig = {
  tool: 'pen' | 'highlighter' | 'text' | 'shape' | 'eraser';
  color: string;
  width: number;
  hlColor: string;
  hlWidth: number;
  eraserWidth: number;
  shape: 'rect' | 'ellipse' | 'line' | 'arrow';
  shapeWidth: number;
};

export function buildMarkupHtml(
  imageSrc: string,
  origSrc: string | null,
  opts: { background: string; guide: string; config: MarkupConfig },
): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
* { margin:0; padding:0; box-sizing:border-box; -webkit-user-select:none; user-select:none; -webkit-touch-callout:none; }
html, body { background:${opts.background}; overflow:hidden; width:100%; height:100%; }
#stage { position:fixed; left:0; top:0; right:0; bottom:0; overflow:hidden; touch-action:none; }
#bg { position:absolute; left:0; top:0; transform-origin:0 0; pointer-events:none; visibility:hidden; }
canvas { position:absolute; left:0; top:0; pointer-events:none; }
#hl { mix-blend-mode:multiply; }
</style>
</head>
<body>
<div id="stage">
  <img id="bg" src="${imageSrc}" />
  <canvas id="hl"></canvas>
  <canvas id="ink"></canvas>
  <canvas id="ui"></canvas>
</div>
${origSrc ? `<img id="orig" src="${origSrc}" style="display:none" />` : ''}
<script>
${MARKUP_CORE_JS}
var GUIDE = ${JSON.stringify(opts.guide)};
var MAXPX = ${MARKUP_MAX_PIXELS};
var PAD = 12, MAX_ZOOM = 6, TAP_SLOP = 8;
var stage = document.getElementById('stage');
var bg = document.getElementById('bg');
var C = { hl: document.getElementById('hl'), ink: document.getElementById('ink'), ui: document.getElementById('ui') };
var X = { hl: C.hl.getContext('2d'), ink: C.ink.getContext('2d'), ui: C.ui.getContext('2d') };
var mctx = document.createElement('canvas').getContext('2d');
function measure(font, line) { mctx.font = font; return mctx.measureText(line).width; }
var dpr = window.devicePixelRatio || 1;
var VW = 1, VH = 1, IW = 1, IH = 1, fit = { k: 1, x: 0, y: 0 }, view = fit, ready = false;
var hist = new MK.History();
var cfg = ${JSON.stringify(opts.config)};
var mode = null, live = null, start = null, dragOp = null, dragPos = null, pinch = null;
var seq = 0;

function post(m) { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(m); }
function postState() { post('STATE:' + JSON.stringify(hist.state())); }

function layout() {
  VW = window.innerWidth; VH = window.innerHeight;
  for (var n in C) {
    C[n].width = Math.round(VW * dpr); C[n].height = Math.round(VH * dpr);
    C[n].style.width = VW + 'px'; C[n].style.height = VH + 'px';
  }
  bg.style.width = IW + 'px'; bg.style.height = IH + 'px';
  fit = MK.fitView(VW, VH, IW, IH, PAD);
  view = fit;
  applyView();
}

function applyView() {
  bg.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')';
  render();
}

/** Clears a layer and sets it to draw in page pixels, clipped to the page. */
function prep(name, clip) {
  var c = X[name];
  c.restore(); c.restore();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'source-over';
  c.clearRect(0, 0, C[name].width, C[name].height);
  c.save();
  c.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);
  if (clip) { c.beginPath(); c.rect(0, 0, IW, IH); c.clip(); }
  c.save();
}

function currentOps() {
  var ops = hist.ops;
  if (dragOp && dragPos) {
    ops = ops.map(function (op) {
      if (op.id !== dragOp.id) return op;
      var o = {}; for (var k in op) o[k] = op[k];
      o.x = dragPos.x; o.y = dragPos.y; return o;
    });
  }
  if (live && live.type === 'shape') ops = ops.concat([live]);
  return ops;
}

function render() {
  if (!ready) return;
  prep('hl', true); prep('ink', true); prep('ui', false);
  MK.renderOps(currentOps(), X.hl, X.ink);
  if (live && live.type === 'stroke') MK.renderOps([live], X.hl, X.ink);
  drawGuides();
}

/** Dashed outlines round text boxes while the Text tool is on: they can be moved and edited. */
function drawGuides() {
  if (cfg.tool !== 'text') return;
  var u = X.ui;
  var ops = currentOps();
  u.strokeStyle = GUIDE;
  u.lineWidth = 1 / view.k;
  u.setLineDash([4 / view.k, 3 / view.k]);
  for (var i = 0; i < ops.length; i++) {
    if (ops[i].type !== 'text') continue;
    var b = MK.textBox(ops[i], measure);
    var p = ops[i].size * 0.2;
    u.strokeRect(b.x - p, b.y - p, b.w + 2 * p, b.h + 2 * p);
  }
  u.setLineDash([]);
}

function point(t) { return { x: t.clientX, y: t.clientY }; }

function strokeWidth() {
  var w = cfg.tool === 'highlighter' ? cfg.hlWidth : cfg.tool === 'eraser' ? cfg.eraserWidth : cfg.width;
  return w / view.k;
}

function liveLayers() {
  if (live.tool === 'eraser') return [X.hl, X.ink];
  return [live.tool === 'highlighter' ? X.hl : X.ink];
}

stage.addEventListener('touchstart', function (e) {
  e.preventDefault();
  if (!ready) return;
  if (e.touches.length >= 2) {
    // A second finger: zoom / pan. Whatever the first finger began is dropped.
    live = null; dragOp = null; dragPos = null;
    pinch = { view: view, a: point(e.touches[0]), b: point(e.touches[1]) };
    mode = 'pinch';
    render();
    return;
  }
  if (mode === 'pinch') return;
  var s = point(e.touches[0]);
  var p = MK.toImage(view, s.x, s.y);
  start = { x: s.x, y: s.y, p: p };
  if (cfg.tool === 'text') {
    dragOp = MK.hitText(hist.ops, p.x, p.y, measure, TAP_SLOP / view.k);
    mode = dragOp ? 'text-hit' : 'text-tap';
    return;
  }
  if (cfg.tool === 'shape') {
    mode = 'shape';
    live = { type: 'shape', shape: cfg.shape, color: cfg.color, width: cfg.shapeWidth / view.k, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    return;
  }
  mode = 'draw';
  live = { type: 'stroke', tool: cfg.tool, color: cfg.tool === 'highlighter' ? cfg.hlColor : cfg.color, width: strokeWidth(), points: [[p.x, p.y]] };
}, { passive: false });

stage.addEventListener('touchmove', function (e) {
  e.preventDefault();
  if (!ready) return;
  if (mode === 'pinch') {
    if (e.touches.length < 2) return;
    var v = MK.pinchView(pinch.view, pinch.a, pinch.b, point(e.touches[0]), point(e.touches[1]));
    view = MK.clampView(v, fit, VW, VH, IW, IH, MAX_ZOOM);
    applyView();
    return;
  }
  var s = point(e.touches[0]);
  var p = MK.toImage(view, s.x, s.y);
  var movedFar = Math.hypot(s.x - start.x, s.y - start.y) > TAP_SLOP;
  if (mode === 'draw' && live) {
    var pts = live.points, last = pts[pts.length - 1];
    if (Math.hypot(p.x - last[0], p.y - last[1]) * view.k < 1.5) return;
    pts.push([p.x, p.y]);
    var layers = liveLayers();
    for (var i = 0; i < layers.length; i++) {
      MK.styleStroke(layers[i], live);
      MK.traceSegment(layers[i], pts, pts.length - 1, false);
    }
  } else if (mode === 'shape' && live) {
    live.x2 = p.x; live.y2 = p.y;
    render();
  } else if ((mode === 'text-hit' || mode === 'text-drag') && dragOp) {
    if (mode === 'text-hit' && !movedFar) return;
    mode = 'text-drag';
    dragPos = { x: dragOp.x + (p.x - start.p.x), y: dragOp.y + (p.y - start.p.y) };
    render();
  } else if (mode === 'text-tap' && movedFar) {
    mode = 'text-none'; // a swipe over empty page isn't a tap
  }
}, { passive: false });

function finish(cancelled) {
  if (mode === 'draw' && live) {
    if (!cancelled) hist.add(live);
  } else if (mode === 'shape' && live) {
    if (!cancelled && !MK.isTinyShape(live, 6 / view.k)) hist.add(live);
  } else if (mode === 'text-drag' && dragOp && dragPos && !cancelled) {
    var moved = {}; for (var k in dragOp) moved[k] = dragOp[k];
    moved.x = dragPos.x; moved.y = dragPos.y;
    hist.update(dragOp.id, MK.clampTextPos(moved, IW, IH, measure));
  } else if (mode === 'text-hit' && dragOp && !cancelled) {
    post('TEXT_EDIT:' + JSON.stringify({ id: dragOp.id, text: dragOp.text, color: dragOp.color, size: Math.round(dragOp.size * fit.k) }));
  } else if (mode === 'text-tap' && !cancelled) {
    post('TEXT_NEW:' + JSON.stringify({ x: start.p.x, y: start.p.y }));
  }
  live = null; dragOp = null; dragPos = null;
  render();
  postState();
}

stage.addEventListener('touchend', function (e) {
  e.preventDefault();
  if (mode === 'pinch') { if (e.touches.length === 0) { mode = null; pinch = null; } return; }
  if (e.touches.length === 0) { finish(false); mode = null; }
}, { passive: false });
stage.addEventListener('touchcancel', function () { if (mode !== 'pinch') finish(true); mode = null; pinch = null; });

// ── Calls from the app ──────────────────────────────────────────────────────
function setConfig(c) { for (var k in c) cfg[k] = c[k]; render(); }
function addText(x, y, text, color, size) {
  var op = { type: 'text', id: 't' + (++seq), text: text, color: color, size: size / fit.k, x: x, y: 0 };
  op.y = y - (op.size * MK.LINE_HEIGHT) / 2;
  var pos = MK.clampTextPos(op, IW, IH, measure);
  op.x = pos.x; op.y = pos.y;
  hist.add(op); render(); postState();
}
function updateText(id, text, color, size) {
  var cur = null;
  for (var i = 0; i < hist.ops.length; i++) if (hist.ops[i].id === id) cur = hist.ops[i];
  if (!cur) return;
  var next = {}; for (var k in cur) next[k] = cur[k];
  next.text = text; next.color = color; next.size = size / fit.k;
  var pos = MK.clampTextPos(next, IW, IH, measure);
  hist.update(id, { text: text, color: color, size: next.size, x: pos.x, y: pos.y });
  render(); postState();
}
function deleteText(id) { hist.remove(id); render(); postState(); }
function undo() { if (hist.undo()) { render(); postState(); } }
function redo() { if (hist.redo()) { render(); postState(); } }
function clearAll() { hist.clear(); render(); postState(); }

function makeCanvas(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function free(c) { if (c) { c.width = 0; c.height = 0; } }

/** The page 'base' with every mark drawn at its natural size (capped at MAXPX). */
function compose(base, bw, bh) {
  var size = MK.outputSize(bw, bh, MAXPX);
  var ops = hist.ops;
  var out = makeCanvas(size.w, size.h), o = out.getContext('2d');
  var inkL = makeCanvas(size.w, size.h), ic = inkL.getContext('2d');
  var hlL = MK.hasHighlights(ops) ? makeCanvas(size.w, size.h) : makeCanvas(1, 1);
  var hc = hlL.getContext('2d');
  if (!o || !ic || !hc) throw new Error('canvas');
  var sx = size.w / IW, sy = size.h / IH;
  ic.setTransform(sx, 0, 0, sy, 0, 0);
  hc.setTransform(sx, 0, 0, sy, 0, 0);
  MK.renderOps(ops, hc, ic);
  o.drawImage(base, 0, 0, size.w, size.h);
  if (MK.hasHighlights(ops)) { o.globalCompositeOperation = 'multiply'; o.drawImage(hlL, 0, 0); }
  o.globalCompositeOperation = 'source-over';
  o.drawImage(inkL, 0, 0);
  free(inkL); free(hlL);
  var url = out.toDataURL('image/jpeg', 0.92);
  free(out);
  if (!url || url.length < 64) throw new Error('encode');
  return url;
}

function getResult() {
  try {
    // The same marks go onto the unfiltered .orig shadow, which every later
    // filter change re-derives from — otherwise the next filter erases them.
    var orig = document.getElementById('orig');
    var result = { page: compose(bg, IW, IH), orig: null };
    if (orig && orig.naturalWidth) result.orig = compose(orig, orig.naturalWidth, orig.naturalHeight);
    post('RESULT:' + JSON.stringify(result));
  } catch (e) {
    post('ERROR:' + (e && e.message ? e.message : 'unknown'));
  }
}

function onImage() {
  if (ready) return;
  IW = bg.naturalWidth; IH = bg.naturalHeight;
  if (!IW || !IH) { post('LOAD_ERROR'); return; }
  ready = true;
  layout();
  bg.style.visibility = 'visible';
  post('READY:' + JSON.stringify({ w: IW, h: IH }));
  postState();
}
bg.onload = onImage;
bg.onerror = function () { post('LOAD_ERROR'); };
if (bg.complete && bg.naturalWidth) onImage();
window.addEventListener('resize', function () { if (ready) layout(); });
</script>
</body>
</html>`;
}
