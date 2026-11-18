// __tests__/markup-core.test.ts
// The Markup engine (lib/markup-core.ts) is a JS string run inside the
// WebView; it is evaluated here as-is, so these tests cover the exact code the
// page runs: zoom geometry, text boxes, the undo history, and which layer each
// mark is drawn on (what makes the saved page match the preview).
import { MARKUP_CORE_JS } from '../lib/markup-core';
import { buildMarkupHtml, MARKUP_MAX_PIXELS, type MarkupConfig } from '../lib/markup-html';

const MK = new Function(`${MARKUP_CORE_JS}; return MK;`)() as any;

/** Every glyph 10px wide per font-size unit / 20: 'abc' at 20px -> 30px. */
const measure = (font: string, line: string) => {
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)![1]);
  return line.length * size * 0.5;
};

/** A canvas context that records what is drawn and with which composite mode. */
function recorder() {
  const calls: string[] = [];
  const ctx: any = {
    globalCompositeOperation: 'source-over',
    strokeStyle: '', fillStyle: '', lineWidth: 1, lineCap: '', lineJoin: '', font: '', textBaseline: '', textAlign: '',
  };
  for (const m of ['beginPath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'arc', 'rect', 'ellipse', 'stroke', 'fill', 'fillText']) {
    ctx[m] = (...args: unknown[]) => calls.push(`${m}(${args.map(a => (typeof a === 'number' ? Math.round(a * 100) / 100 : a)).join(',')})|${ctx.globalCompositeOperation}|${m === 'stroke' ? ctx.strokeStyle : ''}`);
  }
  return { ctx, calls };
}

describe('view geometry', () => {
  test('fitView centres the page inside the padded view', () => {
    const v = MK.fitView(400, 600, 1000, 2000, 10);
    expect(v.k).toBeCloseTo(580 / 2000);
    expect(v.x).toBeCloseTo((400 - 1000 * v.k) / 2);
    expect(v.y).toBeCloseTo(10);
  });

  test('toImage inverts the view transform', () => {
    const v = { k: 0.5, x: 20, y: 40 };
    expect(MK.toImage(v, 20 + 0.5 * 300, 40 + 0.5 * 700)).toEqual({ x: 300, y: 700 });
  });

  test('a pinch keeps the page point under the fingers under them', () => {
    const start = { k: 0.5, x: 10, y: 10 };
    const a0 = { x: 100, y: 200 }, b0 = { x: 200, y: 200 };
    const a1 = { x: 50, y: 220 }, b1 = { x: 250, y: 220 }; // spread x2, moved down 20
    const v = MK.pinchView(start, a0, b0, a1, b1);
    expect(v.k).toBeCloseTo(1);
    const before = MK.toImage(start, 150, 200);
    const after = MK.toImage(v, 150, 220);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  test('clampView keeps the zoom between fit and max and the page on screen', () => {
    const fit = MK.fitView(400, 600, 1000, 1500, 0);
    // Zoomed out past fit: snaps back to fit exactly.
    expect(MK.clampView({ k: fit.k / 2, x: 0, y: 0 }, fit, 400, 600, 1000, 1500, 6)).toEqual(fit);
    // Too far in: capped at 6x.
    expect(MK.clampView({ k: fit.k * 50, x: 0, y: 0 }, fit, 400, 600, 1000, 1500, 6).k).toBeCloseTo(fit.k * 6);
    // Dragged too far right: the left edge can't leave the view's left edge.
    const z = MK.clampView({ k: fit.k * 2, x: 300, y: -10 }, fit, 400, 600, 1000, 1500, 6);
    expect(z.x).toBe(0);
    // ...nor the right edge come inside the view.
    const r = MK.clampView({ k: fit.k * 2, x: -5000, y: -10 }, fit, 400, 600, 1000, 1500, 6);
    expect(r.x).toBeCloseTo(400 - 1000 * fit.k * 2);
  });

  test('outputSize keeps natural size under the canvas limit and scales above it', () => {
    expect(MK.outputSize(1500, 2000, MARKUP_MAX_PIXELS)).toEqual({ w: 1500, h: 2000 });
    const big = MK.outputSize(5712, 4284, MARKUP_MAX_PIXELS);
    expect(big.w * big.h).toBeLessThanOrEqual(MARKUP_MAX_PIXELS);
    expect(big.w / big.h).toBeCloseTo(5712 / 4284, 2);
  });
});

describe('shapes and text', () => {
  test('the arrow head points back along the line, symmetric about it', () => {
    const [a, b] = MK.arrowHead(0, 0, 100, 0, 4);
    expect(a[0]).toBeLessThan(100);
    expect(b[0]).toBeCloseTo(a[0]);
    expect(a[1]).toBeCloseTo(-b[1]);
    expect(Math.hypot(100 - a[0], a[1])).toBeCloseTo(18); // 4.5 x width
  });

  test('a tap with the shape tool is not a shape', () => {
    expect(MK.isTinyShape({ x1: 10, y1: 10, x2: 12, y2: 11 }, 6)).toBe(true);
    expect(MK.isTinyShape({ x1: 10, y1: 10, x2: 40, y2: 10 }, 6)).toBe(false);
  });

  test('text boxes measure every line and are hit by a tap on them', () => {
    const op = { type: 'text', id: 't1', text: 'Paid\nin full', color: '#000', size: 20, x: 100, y: 50 };
    const box = MK.textBox(op, measure);
    expect(box).toEqual({ x: 100, y: 50, w: 70, h: 50 }); // 'in full' = 7 x 10; 2 lines x 25
    expect(MK.hitText([op], 120, 60, measure, 0)).toBe(op);
    expect(MK.hitText([op], 400, 60, measure, 0)).toBeNull();
    // The topmost of two overlapping boxes wins.
    const top = { ...op, id: 't2' };
    expect(MK.hitText([op, top], 120, 60, measure, 0).id).toBe('t2');
  });

  test('a text box is kept inside the page', () => {
    const op = { type: 'text', id: 't', text: 'abcd', color: '#000', size: 20, x: 980, y: -30 };
    expect(MK.clampTextPos(op, 1000, 800, measure)).toEqual({ x: 960, y: 0 });
  });
});

describe('history', () => {
  test('every action is undoable and redoable', () => {
    const h = new MK.History();
    const s1 = { type: 'stroke', tool: 'pen', points: [[0, 0]] };
    const t1 = { type: 'text', id: 't1', text: 'a', x: 1, y: 1 };
    h.add(s1);
    h.add(t1);
    expect(h.update('t1', { x: 50, y: 60 })).toBe(true);
    expect(h.ops[1]).toMatchObject({ x: 50, y: 60 });
    expect(t1.x).toBe(1); // ops are never mutated
    h.remove('t1');
    expect(h.ops).toEqual([s1]);
    h.clear();
    expect(h.ops).toEqual([]);

    h.undo(); expect(h.ops).toEqual([s1]); // clear undone
    h.undo(); expect(h.ops[1]).toMatchObject({ x: 50 }); // delete undone
    h.undo(); expect(h.ops[1]).toBe(t1); // move undone
    expect(h.state()).toEqual({ canUndo: true, canRedo: true, count: 2 });
    h.redo(); expect(h.ops[1]).toMatchObject({ x: 50 });
    // A new action drops the redo branch.
    h.add({ type: 'shape' });
    expect(h.state().canRedo).toBe(false);
  });

  test('a no-op edit adds no history step', () => {
    const h = new MK.History();
    h.add({ type: 'text', id: 't1', text: 'a', x: 1, y: 1 });
    expect(h.update('t1', { x: 1 })).toBe(false);
    h.remove('nope');
    h.clear();
    h.clear();
    expect(h.past.length).toBe(2); // add + one clear
  });
});

describe('rendering layers', () => {
  test('highlights on their layer, pen/shape/text on ink, the eraser on both', () => {
    const hl = recorder(), ink = recorder();
    MK.renderOps([
      { type: 'stroke', tool: 'highlighter', color: '#ffe45e', width: 20, points: [[0, 0], [10, 0], [20, 0]] },
      { type: 'stroke', tool: 'pen', color: '#e53935', width: 2, points: [[0, 5], [10, 5]] },
      { type: 'shape', shape: 'rect', color: '#1565c0', width: 3, x1: 5, y1: 5, x2: 50, y2: 40 },
      { type: 'text', id: 't', text: 'Hi', color: '#000', size: 20, x: 3, y: 4 },
      { type: 'stroke', tool: 'eraser', color: '', width: 10, points: [[2, 2]] },
    ], hl.ctx, ink.ctx);
    expect(hl.calls.filter(c => c.startsWith('stroke'))).toEqual(['stroke()|source-over|#ffe45e']);
    expect(ink.calls.filter(c => c.startsWith('stroke'))).toEqual(['stroke()|source-over|#e53935', 'stroke()|source-over|#1565c0']);
    expect(ink.calls.some(c => c.startsWith('fillText(Hi,3,6.5)'))).toBe(true);
    // A one-sample eraser stroke is a dot, cut out of both layers.
    expect(hl.calls.filter(c => c.startsWith('fill(')).pop()).toContain('destination-out');
    expect(ink.calls.filter(c => c.startsWith('fill(')).pop()).toContain('destination-out');
    expect(hl.ctx.globalCompositeOperation).toBe('source-over');
    expect(ink.ctx.globalCompositeOperation).toBe('source-over');
    expect(MK.hasHighlights([{ tool: 'pen' }])).toBe(false);
  });

  test('the pieces drawn while the finger moves trace the same curve as the finished stroke', () => {
    const pts = [[0, 0], [10, 4], [20, 0], [30, 6], [40, 0]];
    const whole = recorder();
    MK.tracePath(whole.ctx, pts, 2);
    const live = recorder();
    for (let i = 1; i < pts.length; i++) MK.traceSegment(live.ctx, pts, i, i === pts.length - 1);
    const curves = (calls: string[]) => calls.filter(c => /^(lineTo|quadraticCurveTo)/.test(c)).map(c => c.split('|')[0]);
    const w = curves(whole.calls);
    const l = curves(live.calls);
    // Everything in the finished stroke is drawn live (live repeats the last
    // quad once with the tail; opaque ink makes that invisible).
    for (const c of w) expect(l).toContain(c);
    for (const c of l) expect(w).toContain(c);
  });
});

describe('page', () => {
  const config: MarkupConfig = {
    tool: 'pen', color: '#000000', width: 4, hlColor: '#ffe45e', hlWidth: 24, eraserWidth: 32, shape: 'rect', shapeWidth: 3,
  };

  test('embeds the engine, the config and the page images', () => {
    const html = buildMarkupHtml('file:///a/page-0.jpg?t=1', 'file:///a/page-0.orig.jpg?t=1', { background: '#111', guide: '#4cc', config });
    expect(html).toContain('var MK = (function');
    expect(html).toContain('<img id="bg" src="file:///a/page-0.jpg?t=1"');
    expect(html).toContain('<img id="orig" src="file:///a/page-0.orig.jpg?t=1"');
    expect(html).toContain(JSON.stringify(config));
    expect(html).toContain('mix-blend-mode:multiply');
    expect(html).toContain(`var MAXPX = ${MARKUP_MAX_PIXELS}`);
    // The saved page multiplies highlights exactly like the preview does.
    expect(html).toContain("o.globalCompositeOperation = 'multiply'");
  });

  test('without an .orig shadow there is no second image', () => {
    const html = buildMarkupHtml('file:///a/page-0.jpg', null, { background: '#111', guide: '#4cc', config });
    expect(html).not.toContain('id="orig"');
  });

  test('the page script parses', () => {
    const html = buildMarkupHtml('file:///a/page-0.jpg', null, { background: '#111', guide: '#4cc', config });
    const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
    expect(() => new Function(script)).not.toThrow();
  });
});
