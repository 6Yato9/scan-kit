// Round 16 — formatting the stamp tools: the shared colour palette and its
// maths (lib/stamp-colors.ts), the Timestamp's text and look
// (lib/timestamp-style.ts, lib/stamp.ts), Watermark colour and weight, Sign
// ink and strength, Redact colour and label — and, above all, that every
// default resolves to exactly what the tools drew before, that a redaction
// stays opaque whatever its colour, and that old remembered choices load.
const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItem: jest.fn(async (k: string, v: string) => {
    mockStore.set(k, v);
  }),
}));
jest.mock('expo-file-system/legacy', () => ({ readAsStringAsync: jest.fn(), deleteAsync: jest.fn() }));
jest.mock('expo-print', () => ({ printToFileAsync: jest.fn() }));
jest.mock('expo-image-manipulator', () => ({ manipulateAsync: jest.fn(), SaveFormat: { JPEG: 'jpeg' } }));
jest.mock('../lib/ocr', () => ({ recognizeLines: jest.fn() }));

import {
  DEFAULT_CUSTOM_HEX,
  HIGHLIGHT_IDS,
  INK_PALETTE,
  TOOL_INKS,
  contrastOn,
  cssColor,
  customFromSliders,
  hexToHsl,
  highlightHex,
  hslToHex,
  inkHex,
  isLight,
  normalizeHex,
  parseHighlightChoice,
  parseInkChoice,
  slidersFromCustom,
} from '../lib/stamp-colors';
import {
  REDACT_LABEL,
  REDACT_LABEL_EM,
  SIGNATURE_INK,
  STAMP_CANVAS_JS,
  STAMP_RGB,
  TIMESTAMP_FONT_FRACTION,
  WATERMARK_REF_WIDTH_PT,
  redactFill,
  redactLabelSize,
  resolveStamp,
  resolveTimestampLook,
  signatureTint,
  type StampSpec,
} from '../lib/stamp';
import {
  DEFAULT_TIMESTAMP_PREFS,
  formatStampDate,
  formatStampTime,
  formatTimestampText,
  loadTimestampPrefs,
  parseTimestampPrefs,
  saveTimestampPrefs,
  stampWord,
  timestampAdvancedIsDefault,
  timestampLookSpec,
  type TimestampText,
} from '../lib/timestamp-style';
import {
  DEFAULT_REDACT_PREFS,
  DEFAULT_SIGN_PREFS,
  loadRedactPrefs,
  loadSignPrefs,
  parseRedactPrefs,
  parseSignPrefs,
  saveRedactPrefs,
  saveSignPrefs,
} from '../lib/stamp-prefs';
import { formatDateTime } from '../lib/format';
import { labelSpans, leftoverMatches } from '../lib/redact';

type Ctx = Record<string, unknown> & { calls: unknown[][] };

/** A canvas context that records every call with the state it was made in. */
function recordingCtx(): Ctx {
  const calls: unknown[][] = [];
  const ctx: Ctx = { calls, globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '' };
  const rec = (name: string) => (...a: unknown[]) => {
    calls.push([name, { fill: ctx.fillStyle, stroke: ctx.strokeStyle, alpha: ctx.globalAlpha, font: ctx.font, lw: ctx.lineWidth }, ...a]);
  };
  for (const n of ['save', 'restore', 'fillRect', 'fillText', 'beginPath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'closePath', 'fill', 'stroke', 'rect', 'clip', 'translate', 'rotate', 'drawImage']) {
    ctx[n] = rec(n);
  }
  ctx.measureText = (t: string) => ({ width: t.length * 10 });
  return ctx;
}
const drawStamp = new Function(`${STAMP_CANVAS_JS}; return drawStamp;`)() as (...a: unknown[]) => void;
const named = (ctx: Ctx, n: string) => ctx.calls.filter(c => c[0] === n);

beforeEach(() => mockStore.clear());

// ── Palette and colour maths ────────────────────────────────────────────────

describe('stamp colours', () => {
  test('hex strings are normalised, anything else is refused', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex(' #1450BE ')).toBe('#1450be');
    expect(normalizeHex('red')).toBeNull();
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex(42)).toBeNull();
    expect(normalizeHex('url(x)')).toBeNull();
  });

  test('the watermark’s original inks are palette colours, exactly', () => {
    for (const id of ['gray', 'red', 'blue'] as const) {
      const hex = INK_PALETTE.find(p => p.id === id)!.hex;
      expect([1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))).toEqual(STAMP_RGB[id]);
    }
  });

  test('each tool keeps its own historic shades', () => {
    expect(inkHex('black', null, TOOL_INKS.timestamp)).toBe('#222222');
    expect(inkHex('black', null, TOOL_INKS.sign)).toBe(SIGNATURE_INK.black);
    expect(inkHex('blue', null, TOOL_INKS.sign)).toBe(SIGNATURE_INK.blue);
    expect(inkHex('black', null, TOOL_INKS.redact)).toBe('#000000');
    expect(inkHex('green', null)).toBe('#1f8a3b');
  });

  test('custom and unknown choices', () => {
    expect(inkHex('custom', '#FF8800')).toBe('#ff8800');
    // Custom before a slider moved (or with a broken hex) is what its swatch shows.
    expect(inkHex('custom', null, {}, 'gray')).toBe(DEFAULT_CUSTOM_HEX);
    expect(inkHex('custom', 'nope', {}, 'gray')).toBe(DEFAULT_CUSTOM_HEX);
    // An id from a later build: the fallback.
    expect(inkHex('magenta', null, {}, 'gray')).toBe('#707070');
    expect(parseInkChoice('teal', 'black')).toBe('teal');
    expect(parseInkChoice('magenta', 'black')).toBe('black');
    expect(parseHighlightChoice('none', 'white')).toBe('none');
    expect(parseHighlightChoice('neon', 'white')).toBe('white');
    expect(HIGHLIGHT_IDS[0]).toBe('none');
  });

  test('highlight colours, and none', () => {
    expect(highlightHex('white', null)).toBe('#ffffff');
    expect(highlightHex('yellow', null)).toBe('#ffe45e');
    expect(highlightHex('none', '#123456')).toBeNull();
    expect(highlightHex('custom', '#123456')).toBe('#123456');
    expect(highlightHex('custom', null)).toBe(DEFAULT_CUSTOM_HEX);
  });

  test('CSS for a colour at an opacity: opaque stays the plain hex', () => {
    expect(cssColor('#222222', 1)).toBe('#222222');
    expect(cssColor('#ffffff', 0.85)).toBe('rgba(255,255,255,0.85)');
    expect(cssColor('#c81e1e', 0.333333)).toBe('rgba(200,30,30,0.333)');
    expect(cssColor('#c81e1e', 7)).toBe('#c81e1e');
    expect(cssColor('#c81e1e', -1)).toBe('rgba(200,30,30,0)');
  });

  test('contrast: dark marks on light colours, light marks on dark ones', () => {
    expect(isLight('#ffffff')).toBe(true);
    expect(isLight('#ffe45e')).toBe(true);
    expect(isLight('#111111')).toBe(false);
    expect(contrastOn('#000000')).toBe('#ffffff');
    expect(contrastOn('#ffffff')).toBe('#000000');
    expect(contrastOn('#808080')).toBe('#ffffff');
  });

  test('HSL round trip and the custom sliders', () => {
    for (const hex of ['#1450be', '#c81e1e', '#1f8a3b', '#6b2fb3', DEFAULT_CUSTOM_HEX]) {
      const { h, s, l } = hexToHsl(hex);
      const back = hslToHex(h, s, l);
      const d = [1, 3, 5].map(i => Math.abs(parseInt(back.slice(i, i + 2), 16) - parseInt(hex.slice(i, i + 2), 16)));
      expect(Math.max(...d)).toBeLessThanOrEqual(1);
    }
    expect(hslToHex(0, 0, 0)).toBe('#000000');
    expect(hslToHex(0, 0, 1)).toBe('#ffffff');
    expect(hslToHex(120, 1, 0.5)).toBe('#00ff00');
    expect(hslToHex(-120, 1, 0.5)).toBe('#0000ff');
    for (const [hue, shade] of [[0, 0], [200, 0.5], [300, 1], [45, 0.3]]) {
      const hex = customFromSliders(hue, shade);
      const back = slidersFromCustom(hex);
      expect(Math.abs(back.shade - shade)).toBeLessThan(0.02);
      // Hue is meaningful (the colour is saturated): it comes back within a degree or two.
      expect(Math.min(Math.abs(back.hue - hue), 360 - Math.abs(back.hue - hue))).toBeLessThanOrEqual(2);
    }
  });
});

// ── Timestamp text ──────────────────────────────────────────────────────────

describe('timestamp text', () => {
  const ts = new Date(2026, 10, 7, 14, 5).getTime();
  const morning = new Date(2026, 0, 3, 0, 9).getTime();
  const t = (o: Partial<TimestampText> = {}): TimestampText => ({
    content: 'datetime',
    dateStyle: 'device',
    clock: 'device',
    word: 'none',
    customWord: '',
    ...o,
  });

  test('the default is the text the tool always printed', () => {
    for (const locale of ['en-US', 'en-GB', 'fr-FR', 'de-DE', undefined]) {
      expect(formatTimestampText(ts, t(), locale)).toBe(formatDateTime(ts, locale));
    }
  });

  test('date orders, with live examples', () => {
    expect(formatStampDate(ts, 'dmy')).toBe('07/11/2026');
    expect(formatStampDate(ts, 'mdy')).toBe('11/07/2026');
    expect(formatStampDate(ts, 'iso')).toBe('2026-11-07');
    expect(formatStampDate(ts, 'long', 'en-US')).toBe('November 7, 2026');
    expect(formatStampDate(ts, 'long', 'en-GB')).toBe('7 November 2026');
    expect(formatStampDate(ts, 'device', 'en-US')).toBe('Nov 7, 2026');
  });

  test('clocks', () => {
    expect(formatStampTime(ts, '24h')).toBe('14:05');
    expect(formatStampTime(ts, '12h')).toBe('2:05 PM');
    expect(formatStampTime(morning, '24h')).toBe('00:09');
    expect(formatStampTime(morning, '12h')).toBe('12:09 AM');
    expect(formatStampTime(new Date(2026, 0, 3, 12, 0).getTime(), '12h')).toBe('12:00 PM');
  });

  test('date only, time only, and combinations', () => {
    expect(formatTimestampText(ts, t({ content: 'date' }), 'en-US')).toBe('Nov 7, 2026');
    expect(formatTimestampText(ts, t({ content: 'time', clock: '24h' }))).toBe('14:05');
    expect(formatTimestampText(ts, t({ dateStyle: 'iso', clock: '24h' }))).toBe('2026-11-07 14:05');
    expect(formatTimestampText(ts, t({ dateStyle: 'dmy', clock: '12h' }))).toBe('07/11/2026 2:05 PM');
    expect(formatTimestampText(ts, t({ dateStyle: 'long', clock: '24h' }), 'en-GB')).toBe('7 November 2026, 14:05');
    expect(formatTimestampText(ts, t({ dateStyle: 'device', clock: '24h' }), 'en-US')).toBe('Nov 7, 2026, 14:05');
  });

  test('a word in front: presets, custom, empty', () => {
    expect(formatTimestampText(ts, t({ content: 'date', word: 'paid' }), 'en-US')).toBe('Paid Nov 7, 2026');
    expect(formatTimestampText(ts, t({ content: 'date', word: 'received', dateStyle: 'iso' }))).toBe('Received 2026-11-07');
    expect(formatTimestampText(ts, t({ content: 'date', word: 'custom', customWord: '  Checked   by  ', dateStyle: 'iso' }))).toBe(
      'Checked by 2026-11-07',
    );
    expect(formatTimestampText(ts, t({ content: 'date', word: 'custom', customWord: '   ', dateStyle: 'iso' }))).toBe('2026-11-07');
    expect(stampWord({ word: 'custom', customWord: 'x'.repeat(60) })).toHaveLength(24);
  });
});

// ── Timestamp look ──────────────────────────────────────────────────────────

describe('timestamp look', () => {
  const base = { kind: 'timestamp' as const, text: 'Nov 7, 2026, 2:05 PM', corner: 'bottom-right' as const };

  test('the default look resolves to exactly the original stamp', () => {
    const legacy = resolveStamp(base);
    const now = resolveStamp({ ...base, anchor: { x: 1, y: 1 }, ...timestampLookSpec(DEFAULT_TIMESTAMP_PREFS) });
    expect(now).toEqual(legacy);
    expect(now).toMatchObject({
      fontFrac: TIMESTAMP_FONT_FRACTION,
      padV: 0.35,
      padH: 0.6,
      radius: 0.3,
      weight: '500',
      ink: '#222222',
      bg: 'rgba(255,255,255,0.85)',
      border: null,
    });
  });

  test('size in points on an A4-wide page, clamped; null is automatic', () => {
    expect(resolveTimestampLook({ sizePt: 20 }).fontFrac).toBeCloseTo(20 / WATERMARK_REF_WIDTH_PT);
    expect(resolveTimestampLook({ sizePt: 500 }).sizePt).toBe(48);
    expect(resolveTimestampLook({ sizePt: 1 }).sizePt).toBe(6);
    expect(resolveTimestampLook({ sizePt: null })).toMatchObject({ autoSize: true, fontFrac: TIMESTAMP_FONT_FRACTION, sizePt: 10 });
  });

  test('colour, strength, weight, highlight and border', () => {
    const look = timestampLookSpec({
      ...DEFAULT_TIMESTAMP_PREFS,
      color: 'red',
      strength: 50,
      bold: true,
      highlight: 'yellow',
      highlightStrength: 100,
      border: true,
    });
    expect(resolveTimestampLook(look)).toMatchObject({
      weight: '700',
      ink: 'rgba(200,30,30,0.5)',
      bg: '#ffe45e',
      border: 'rgba(200,30,30,0.5)',
    });
    expect(resolveTimestampLook(timestampLookSpec({ ...DEFAULT_TIMESTAMP_PREFS, highlight: 'none' })).bg).toBeNull();
    // A broken colour is the original ink, never a crash.
    expect(resolveTimestampLook({ color: 'javascript:x' }).ink).toBe('#222222');
  });

  test('the canvas paints the box, the border and the text as resolved', () => {
    const r = resolveStamp({ ...base, ...timestampLookSpec({ ...DEFAULT_TIMESTAMP_PREFS, bold: true, border: true, highlight: 'yellow' }) });
    const ctx = recordingCtx();
    drawStamp(ctx, 1000, 1400, r, null);
    const fills = named(ctx, 'fill');
    expect(fills).toHaveLength(1);
    expect((fills[0][1] as { fill: string }).fill).toBe('rgba(255,228,94,0.85)');
    const strokes = named(ctx, 'stroke');
    expect(strokes).toHaveLength(1);
    expect((strokes[0][1] as { lw: number }).lw).toBeCloseTo(1.6); // 0.1 × 16 px
    const text = named(ctx, 'fillText');
    expect(text).toHaveLength(1);
    expect((text[0][1] as { font: string }).font).toBe('700 16px Helvetica, Arial, sans-serif');
  });

  test('no highlight and no border: the text alone', () => {
    const r = resolveStamp({ ...base, highlight: null });
    const ctx = recordingCtx();
    drawStamp(ctx, 1000, 1400, r, null);
    expect(named(ctx, 'fill')).toHaveLength(0);
    expect(named(ctx, 'stroke')).toHaveLength(0);
    expect((named(ctx, 'fillText')[0][1] as { font: string }).font).toBe('500 16px Helvetica, Arial, sans-serif');
  });
});

describe('timestamp prefs', () => {
  test('nothing stored, or something unreadable, gives the defaults', () => {
    for (const raw of [null, '', 'not json', '[1]', '"x"', '{}']) expect(parseTimestampPrefs(raw)).toEqual(DEFAULT_TIMESTAMP_PREFS);
    expect(timestampAdvancedIsDefault(DEFAULT_TIMESTAMP_PREFS)).toBe(true);
  });

  test('field by field: valid values kept, broken ones defaulted, numbers clamped', () => {
    const p = parseTimestampPrefs(
      JSON.stringify({
        when: 'now',
        content: 'time',
        dateStyle: 'klingon',
        clock: '24h',
        word: 'paid',
        customWord: 'y'.repeat(40),
        sizePt: 300,
        color: 'custom',
        customColor: '#ABCDEF',
        bold: 'yes',
        strength: 3,
        highlight: 'none',
        highlightStrength: 64.6,
        border: true,
        anchor: { x: 9, y: 'down' },
        later: { field: 1 },
      }),
    );
    expect(p).toEqual({
      ...DEFAULT_TIMESTAMP_PREFS,
      when: 'now',
      content: 'time',
      clock: '24h',
      word: 'paid',
      customWord: 'y'.repeat(24),
      sizePt: 48,
      color: 'custom',
      customColor: '#abcdef',
      strength: 10,
      highlight: 'none',
      highlightStrength: 65,
      border: true,
      anchor: { x: 1, y: 1 },
    });
    expect(timestampAdvancedIsDefault(p)).toBe(false);
  });

  test('saved and loaded again unchanged; storage failures never throw', async () => {
    expect(await loadTimestampPrefs()).toEqual(DEFAULT_TIMESTAMP_PREFS);
    const prefs = { ...DEFAULT_TIMESTAMP_PREFS, word: 'approved' as const, color: 'blue' as const, anchor: { x: 0.5, y: 0 } };
    await saveTimestampPrefs(prefs);
    expect(await loadTimestampPrefs()).toEqual(prefs);
    const AS = jest.requireMock('@react-native-async-storage/async-storage');
    AS.getItem.mockRejectedValueOnce(new Error('disk'));
    expect(await loadTimestampPrefs()).toEqual(DEFAULT_TIMESTAMP_PREFS);
    AS.setItem.mockRejectedValueOnce(new Error('disk'));
    await expect(saveTimestampPrefs(prefs)).resolves.toBeUndefined();
  });
});

// ── Watermark colour and weight ─────────────────────────────────────────────

describe('watermark colour and weight', () => {
  const wm = (o: Partial<Extract<StampSpec, { kind: 'watermark' }>>) =>
    resolveStamp({ kind: 'watermark', text: 'DRAFT', style: 'diagonal', color: 'gray', ...o });

  test('the original three inks and bold are unchanged', () => {
    expect(wm({})).toMatchObject({ ink: 'rgba(112,112,112,0.28)', weight: '700' });
    expect(wm({ color: 'red' })).toMatchObject({ ink: 'rgba(200,30,30,0.28)' });
    expect(wm({ color: 'blue', bold: true })).toMatchObject({ ink: 'rgba(20,80,190,0.28)', weight: '700' });
  });

  test('palette, custom and regular', () => {
    expect(wm({ color: 'purple' })).toMatchObject({ ink: 'rgba(107,47,179,0.28)' });
    expect(wm({ color: 'custom', customColor: '#00FF00', strength: 50 })).toMatchObject({ ink: 'rgba(0,255,0,0.5)' });
    expect(wm({ color: 'custom', customColor: 'bad' })).toMatchObject({ ink: cssColor(DEFAULT_CUSTOM_HEX, 0.28) });
    expect(wm({ bold: false })).toMatchObject({ weight: '400' });
  });

  test('the canvas draws in the resolved weight', () => {
    const ctx = recordingCtx();
    drawStamp(ctx, 595, 842, wm({ bold: false, sizePt: 60 }), null);
    const t = named(ctx, 'fillText');
    expect(t.length).toBeGreaterThan(0);
    expect((t[0][1] as { font: string }).font).toBe('400 60px Helvetica, Arial, sans-serif');
  });
});

// ── Sign ink and strength ───────────────────────────────────────────────────

describe('signature ink and strength', () => {
  const sig = { dataUri: 'data:image/png;base64,AA==', width: 2, height: 1 };
  const placement = { x: 0.1, y: 0.2, w: 0.3 };

  test('black needs no recolouring; the old inks still resolve', () => {
    expect(signatureTint({})).toBeNull();
    expect(signatureTint({ ink: 'blue' })).toBe(SIGNATURE_INK.blue);
    expect(signatureTint({ inkHex: SIGNATURE_INK.black })).toBeNull();
    expect(signatureTint({ inkHex: '#C81E1E', ink: 'blue' })).toBe('#c81e1e');
    expect(signatureTint({ inkHex: 'bad', ink: 'blue' })).toBe(SIGNATURE_INK.blue);
  });

  test('opacity is only present below 1, and the canvas applies it', () => {
    expect(resolveStamp({ kind: 'signature', signature: sig, placement, opacity: 1 })).toEqual({
      kind: 'signature',
      ...placement,
      tint: null,
    });
    const r = resolveStamp({ kind: 'signature', signature: sig, placement, opacity: 0.6, inkHex: '#1f8a3b' });
    expect(r).toMatchObject({ tint: '#1f8a3b', alpha: 0.6 });
    const ctx = recordingCtx();
    drawStamp(ctx, 1000, 1000, r, { naturalWidth: 200, naturalHeight: 100 });
    expect((named(ctx, 'drawImage')[0][1] as { alpha: number }).alpha).toBe(0.6);
  });

  test('prefs: defaults, field by field, round trip', async () => {
    expect(parseSignPrefs(null)).toEqual(DEFAULT_SIGN_PREFS);
    expect(parseSignPrefs(JSON.stringify({ ink: 'purple', customInk: '#zzz', strength: 5 }))).toEqual({
      ink: 'purple',
      customInk: null,
      strength: 30,
    });
    await saveSignPrefs({ ink: 'custom', customInk: '#123456', strength: 70 });
    expect(await loadSignPrefs()).toEqual({ ink: 'custom', customInk: '#123456', strength: 70 });
  });
});

// ── Redact colour and label ─────────────────────────────────────────────────

describe('redaction colour and label', () => {
  const boxes = [
    { x: 0.1, y: 0.1, w: 0.4, h: 0.05 },
    { x: 0.5, y: 0.5, w: 0.004, h: 0.002 },
  ];

  test('the default is still opaque black with no label', () => {
    expect(resolveStamp({ kind: 'redact', boxes })).toEqual({ kind: 'redact', fill: '#000000', rects: expect.any(Array) });
    expect(redactFill(undefined)).toBe('#000000');
    expect(redactFill('rgba(0,0,0,0.1)')).toBe('#000000'); // never a see-through fill
    expect(redactFill('#FFF')).toBe('#ffffff');
  });

  test('any colour is burned in fully opaque, every box before any label', () => {
    for (const fill of ['#ffffff', '#808080', '#c81e1e']) {
      const r = resolveStamp({ kind: 'redact', boxes, fill, label: true });
      const ctx = recordingCtx();
      drawStamp(ctx, 1000, 2000, r, null);
      const rects = named(ctx, 'fillRect');
      expect(rects).toHaveLength(2);
      for (const c of rects) expect(c[1]).toMatchObject({ fill, alpha: 1 });
      // The label comes after every box: the pixels under it are already gone.
      const firstText = ctx.calls.findIndex(c => c[0] === 'fillText');
      const lastRect = ctx.calls.map(c => c[0]).lastIndexOf('fillRect');
      expect(firstText).toBeGreaterThan(lastRect);
      // One label: the tiny second box (4 × 4 px) is too small to carry one.
      const texts = named(ctx, 'fillText');
      expect(texts).toHaveLength(1);
      expect(texts[0][2]).toBe(REDACT_LABEL);
      expect((texts[0][1] as { fill: string }).fill).toBe(contrastOn(fill));
    }
  });

  test('the label fits the box', () => {
    // 400 × 100 px: limited by the width (0.86 × 400 / 5.555 em).
    expect(redactLabelSize(400, 100)).toBeCloseTo((400 * 0.86) / REDACT_LABEL_EM);
    // 400 × 20 px: limited by the height.
    expect(redactLabelSize(400, 20)).toBeCloseTo(12.4);
    expect(redactLabelSize(20, 4)).toBe(0);
    expect(redactLabelSize(0, 10)).toBe(0);
    const r = resolveStamp({ kind: 'redact', boxes, label: true });
    expect(r).toMatchObject({ label: { text: 'REDACTED', ink: '#ffffff' } });
  });

  test('the label read back after redacting is not a leftover', () => {
    expect(labelSpans('Name REDACTED here')).toEqual([{ start: 5, end: 13 }]);
    expect(labelSpans('REDACTE')).toEqual([{ start: 0, end: 7 }]);
    expect(labelSpans('nothing')).toEqual([]);
    const img = { width: 1000, height: 1000 };
    const applied = [{ x: 0, y: 0, w: 1, h: 0.2 }];
    const labelLine = { text: 'REDACTED', left: 100, top: 50, width: 300, height: 40 };
    // Searching "red" or "act" finds them inside the printed label: ignored.
    expect(leftoverMatches([labelLine], img, [{ kind: 'term', term: 'red' }, { kind: 'term', term: 'act' }], applied)).toEqual([]);
    // A real leftover beside the label is still caught.
    const leaked = { text: 'REDACTED Fred', left: 100, top: 50, width: 400, height: 40 };
    expect(leftoverMatches([leaked], img, [{ kind: 'term', term: 'red' }], applied)).toHaveLength(1);
  });

  test('prefs: defaults, field by field, round trip', async () => {
    expect(parseRedactPrefs('garbage')).toEqual(DEFAULT_REDACT_PREFS);
    expect(parseRedactPrefs(JSON.stringify({ color: 'white', label: 1 }))).toEqual({ ...DEFAULT_REDACT_PREFS, color: 'white' });
    await saveRedactPrefs({ color: 'gray', customColor: null, label: true });
    expect(await loadRedactPrefs()).toEqual({ color: 'gray', customColor: null, label: true });
  });
});
