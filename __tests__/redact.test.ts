// Redact (lib/redact.ts, lib/stamp.ts 'redact'): box maths on the preview,
// finding a term / an email / a phone number in OCR lines and mapping the
// match to a box on the page, merging proposals, the leftover check after
// redacting, and the opaque pixel rectangles the canvas fills.
jest.mock('expo-file-system/legacy', () => ({ readAsStringAsync: jest.fn(), deleteAsync: jest.fn() }));
jest.mock('expo-print', () => ({ printToFileAsync: jest.fn() }));
jest.mock('expo-image-manipulator', () => ({ manipulateAsync: jest.fn(), SaveFormat: { JPEG: 'jpeg' } }));
jest.mock('../lib/ocr', () => ({ recognizeLines: jest.fn() }));

import {
  addProposals,
  boxAt,
  boxFromPoints,
  boxesSummary,
  charWeight,
  cornerAt,
  covers,
  findInText,
  findOnPage,
  findPattern,
  findSummary,
  foldWithMap,
  grow,
  leftoverMatches,
  matchBox,
  resizeFreeBox,
  spanOfLine,
  toFractions,
  toPoints,
  type RedactBox,
} from '../lib/redact';
import {
  STAMP_CANVAS_JS,
  cleanRedactRects,
  redactPixelRect,
  resolveStamp,
  stampIsDrawable,
  buildStampHtml,
} from '../lib/stamp';

const bounds = { width: 300, height: 400 };
const img = { width: 1000, height: 1400 };
const line = (text: string, left = 100, top = 200, width = 800, height = 40) => ({ text, left, top, width, height });

describe('boxes on the preview', () => {
  test('a drag in any direction spans its two points, kept on the page', () => {
    expect(boxFromPoints(50, 60, 10, 20, bounds)).toEqual({ x: 10, y: 20, w: 40, h: 40 });
    expect(boxFromPoints(280, 390, 350, 450, bounds)).toEqual({ x: 280, y: 390, w: 20, h: 10 });
    expect(boxFromPoints(-20, -5, 10, 10, bounds)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });

  test('a corner resizes to any shape with the opposite corner pinned', () => {
    const start = { x: 100, y: 100, w: 50, h: 20 };
    expect(resizeFreeBox(start, 'br', 30, 40, bounds)).toEqual({ x: 100, y: 100, w: 80, h: 60 });
    expect(resizeFreeBox(start, 'tl', -10, -30, bounds)).toEqual({ x: 90, y: 70, w: 60, h: 50 });
  });

  test('a corner stops at the page edge and never closer than the minimum to the pinned one', () => {
    const start = { x: 100, y: 100, w: 50, h: 20 };
    const out = resizeFreeBox(start, 'br', 500, 500, bounds);
    expect(out.x + out.w).toBe(300);
    expect(out.y + out.h).toBe(400);
    const tiny = resizeFreeBox(start, 'br', -200, -200, bounds, 10);
    expect(tiny).toEqual({ x: 100, y: 100, w: 10, h: 10 });
    const flipped = resizeFreeBox(start, 'tl', 200, 200, bounds, 10);
    expect(flipped).toEqual({ x: 140, y: 110, w: 10, h: 10 });
  });

  test('hit tests pick the topmost box and the nearest corner', () => {
    const boxes = [{ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 50, w: 100, h: 100 }];
    expect(boxAt(boxes, 60, 60)).toBe(1);
    expect(boxAt(boxes, 10, 10)).toBe(0);
    expect(boxAt(boxes, 200, 200)).toBe(-1);
    expect(boxAt(boxes, 153, 100, 5)).toBe(1);
    expect(cornerAt(boxes[1], 148, 152, 22)).toBe('br');
    expect(cornerAt(boxes[1], 100, 100, 22)).toBeNull();
  });

  test('points and fractions round-trip', () => {
    const b = { x: 30, y: 40, w: 60, h: 80 };
    expect(toPoints(toFractions(b, bounds), bounds)).toEqual(b);
    expect(toFractions(b, { width: 0, height: 10 })).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('finding a term in a line', () => {
  test('case- and accent-insensitive, every occurrence', () => {
    expect(findInText('José Smith paid JOSE', 'jose')).toEqual([
      { start: 0, end: 4 },
      { start: 16, end: 20 },
    ]);
  });

  test('a run of spaces in the text matches one space in the term', () => {
    expect(findInText('Call  John   Smith today', 'john smith')).toEqual([{ start: 6, end: 18 }]);
  });

  test('one-letter terms find nothing', () => {
    expect(findInText('a a a', 'a')).toEqual([]);
    expect(findInText('abc', '  ')).toEqual([]);
  });

  test('folding keeps a map back to the original characters', () => {
    const { folded, owner } = foldWithMap('Ébc');
    expect(folded).toBe('ebc');
    expect(owner).toEqual([0, 1, 2]);
  });
});

describe('emails and phone numbers', () => {
  test('finds email addresses', () => {
    const t = 'Contact: jane.doe+bills@example.co.uk or info@acme.com.';
    const hits = findPattern(t, 'email').map(h => t.slice(h.start, h.end));
    expect(hits).toEqual(['jane.doe+bills@example.co.uk', 'info@acme.com']);
  });

  test('finds phone numbers with 9 to 15 digits, not dates or short numbers', () => {
    const t = 'Tel +44 20 7946 0958, mobile (555) 123-4567. Date 18/11/2026, invoice 1234, 2026-11-18.';
    const hits = findPattern(t, 'phone').map(h => t.slice(h.start, h.end));
    expect(hits).toEqual(['+44 20 7946 0958', '(555) 123-4567']);
  });
});

describe('a match inside a line becomes part of the line box', () => {
  test('a whole-line match covers the whole line, padded above and below', () => {
    const r = matchBox(line('Smith'), 0, 5, img);
    expect(r.x).toBeCloseTo(0.1);
    expect(r.w).toBeCloseTo(0.8);
    expect(r.y).toBeLessThan(200 / 1400);
    expect(r.y + r.h).toBeGreaterThan(240 / 1400);
  });

  test('a word in the middle covers roughly its share of the line, a little wider', () => {
    const text = 'Paid by John Smith on Monday';
    const [m] = findInText(text, 'john smith');
    const { from, to } = spanOfLine(text, m.start, m.end);
    // Unpadded proportional share, by character count: 8/28 to 18/28.
    expect(from).toBeLessThan(8 / 28);
    expect(to).toBeGreaterThan(18 / 28);
    expect(from).toBeGreaterThan(0.15);
    expect(to).toBeLessThan(0.8);
  });

  test('narrow letters weigh less than wide ones', () => {
    expect(charWeight('i')).toBeLessThan(charWeight('a'));
    expect(charWeight('M')).toBeGreaterThan(charWeight('a'));
    // "iiii" then "MMMM": the M's take far more than half the line.
    expect(spanOfLine('iiiiMMMM', 4, 8).from).toBeLessThan(0.3);
  });

  test('every match on a page, skipping lines without a box', () => {
    const lines = [line('Name: Smith', 100, 100), line('Smith & Smith', 100, 300), { ...line('Smith'), width: 0 }];
    const boxes = findOnPage(lines, img, { kind: 'term', term: 'smith' });
    expect(boxes).toHaveLength(3);
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(1);
    }
    expect(findOnPage(lines, null, { kind: 'term', term: 'smith' })).toEqual([]);
  });
});

describe('proposals', () => {
  const box = (x: number, y: number, w: number, h: number): RedactBox => ({ x, y, w, h, id: `${x}`, source: 'drawn' });

  test('a proposal already covered by a box is not added again', () => {
    const existing = [box(0.1, 0.1, 0.5, 0.1)];
    const { boxes, added } = addProposals(existing, [{ x: 0.2, y: 0.12, w: 0.1, h: 0.05 }, { x: 0.7, y: 0.5, w: 0.1, h: 0.05 }], 'search');
    expect(added).toBe(1);
    expect(boxes).toHaveLength(2);
    expect(boxes[1].source).toBe('search');
    expect(covers(existing[0], { x: 0.55, y: 0.12, w: 0.1, h: 0.05 })).toBe(false);
  });

  test('summaries', () => {
    expect(boxesSummary([1])).toBe('1 box');
    expect(boxesSummary([2, 0, 1])).toBe('3 boxes on 2 pages');
    expect(findSummary({ kind: 'term', term: ' Smith ' }, 0, 0, 0)).toBe('No matches for “Smith”');
    expect(findSummary({ kind: 'email' }, 0, 0, 0)).toBe('No email addresses found');
    expect(findSummary({ kind: 'phone' }, 4, 2, 0)).toBe('Found 4 matches on 2 pages');
    expect(findSummary({ kind: 'term', term: 'x1' }, 0, 0, 2)).toBe('Every match for “x1” is already covered');
  });

  test('grow widens a box on every side, on the page', () => {
    expect(grow({ x: 0.5, y: 0.5, w: 0.2, h: 0.1 }, 0.25)).toEqual({ x: 0.45, y: 0.475, w: expect.closeTo(0.3), h: expect.closeTo(0.15) });
    expect(grow({ x: 0, y: 0, w: 1, h: 1 }, 0.5)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('after redacting', () => {
  test('a term still readable under an applied box is reported; one outside every box is not', () => {
    const lines = [line('Account Smith 1234', 100, 100), line('Smith', 100, 800)];
    const applied = [{ x: 0.3, y: 0.05, w: 0.3, h: 0.05 }];
    const left = leftoverMatches(lines, img, [{ kind: 'term', term: 'smith' }], applied);
    expect(left).toHaveLength(1);
    expect(left[0].y).toBeLessThan(0.2);
    expect(leftoverMatches([], img, [{ kind: 'term', term: 'smith' }], applied)).toEqual([]);
  });
});

describe('the redaction stamp', () => {
  test('boxes are clamped to the page and empty ones dropped', () => {
    expect(cleanRedactRects([
      { x: -0.1, y: 0.9, w: 0.3, h: 0.3 },
      { x: 0.5, y: 0.5, w: 0, h: 0.1 },
      { x: NaN, y: 0, w: 1, h: 1 },
    ])).toEqual([{ x: 0, y: 0.9, w: expect.closeTo(0.2), h: expect.closeTo(0.1) }]);
    expect(stampIsDrawable({ kind: 'redact', boxes: [] })).toBe(false);
    expect(stampIsDrawable({ kind: 'redact', boxes: [{ x: 0, y: 0, w: 0.1, h: 0.1 }] })).toBe(true);
  });

  test('pixel rects round outward so no sliver is left at an edge', () => {
    expect(redactPixelRect({ x: 0.1005, y: 0.2005, w: 0.1, h: 0.1 }, 1000, 1000)).toEqual({ x: 100, y: 200, w: 101, h: 101 });
    expect(redactPixelRect({ x: 0.9, y: 0.9, w: 0.2, h: 0.2 }, 1000, 1000)).toEqual({ x: 900, y: 900, w: 100, h: 100 });
  });

  test('the canvas painter uses the same rounding as redactPixelRect', () => {
    const canvasRect = new Function(`${STAMP_CANVAS_JS}; return redactRect;`)() as (r: unknown, w: number, h: number) => unknown;
    for (const r of [{ x: 0.1005, y: 0.2005, w: 0.1, h: 0.1 }, { x: 0.333, y: 0.777, w: 0.111, h: 0.05 }]) {
      expect(canvasRect(r, 2481, 3508)).toEqual(redactPixelRect(r, 2481, 3508));
    }
  });

  test('the canvas fills every box in opaque black', () => {
    const resolved = resolveStamp({ kind: 'redact', boxes: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }] });
    expect(resolved).toEqual({ kind: 'redact', fill: '#000000', rects: expect.any(Array) });
    const draw = new Function(`${STAMP_CANVAS_JS}; return drawStamp;`)() as (...a: unknown[]) => void;
    const calls: unknown[][] = [];
    const ctx: any = {
      save() {}, restore() {},
      fillRect: (...a: unknown[]) => calls.push([ctx.fillStyle, ctx.globalAlpha, ...a]),
    };
    draw(ctx, 1000, 2000, resolved, null);
    expect(calls).toEqual([
      ['#000000', 1, 100, 200, 200, 200],
      ['#000000', 1, 500, 1000, 100, 200],
    ]);
  });

  test('the stamp page needs no signature for a redaction', () => {
    const html = buildStampHtml('file:///p.jpg', 'file:///p.orig.jpg', { kind: 'redact', boxes: [{ x: 0, y: 0, w: 1, h: 0.1 }] });
    expect(html).toContain('"sig":null');
    expect(html).toContain('"kind":"redact"');
  });
});
