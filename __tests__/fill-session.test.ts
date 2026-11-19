// __tests__/fill-session.test.ts
// Round 13b, Fill & sign usability: the zoom maths (lib/placement.ts), the
// session rules (lib/fill-session.ts: marks dropped on a form field, Next /
// Previous order, where a signature lands, initials on every page, recently
// used signatures) and what Fill & sign may do with a PDF before it is opened
// (lib/fill-access.ts).
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}) }));
jest.mock('expo-file-system', () => ({ File: class { exists = false; size = 0; }, Directory: class {}, Paths: {} }));
jest.mock('../modules/vision-ocr/src', () => ({ VisionOcr: {} }));
jest.mock('../lib/pdf-edit', () => ({ PdfEditError: class extends Error {} }));
jest.mock('../contexts/theme-context', () => ({ useTheme: () => ({ colors: {} }) }));

import {
  MAX_ZOOM,
  clampView,
  fittedView,
  hitSlopFor,
  liveTransform,
  revealRect,
  zoomViewAbout,
} from '../lib/placement';
import { copyToPages, coveredField, fieldOrder, isPlaceholderChoice, keyboardForField, placeInkMark, pushRecent } from '../lib/fill-session';
import { fillAccessOf, fillBlockedReason, signBlockedReason, withFilled } from '../lib/fill-access';
import { convertWarning } from '../components/pdf-convert-banner';
import type { FillMark } from '../lib/pdf-fill';
import type { NativeFillField } from '../modules/vision-ocr/src';

const fit = { w: 370, h: 479 };
const viewport = { w: 402, h: 600 };
const margin = { w: 16, h: 24 };

describe('zoom and pan', () => {
  it('centres a fitted page', () => {
    expect(fittedView(fit, viewport)).toEqual({ z: 1, x: 16, y: (600 - 479) / 2 });
  });

  it('keeps the zoom between 1 and 4', () => {
    expect(clampView({ z: 0.3, x: 0, y: 0 }, fit, viewport).z).toBe(1);
    expect(clampView({ z: 9, x: 0, y: 0 }, fit, viewport).z).toBe(MAX_ZOOM);
  });

  it('never pulls a zoomed page further in than the margin', () => {
    const v = clampView({ z: 2, x: 500, y: -5000 }, fit, viewport, margin);
    expect(v.x).toBe(16);
    expect(v.y).toBe(600 - 479 * 2 - 24);
  });

  it('zooms about the fingers: the page point under them stays put', () => {
    const v = { z: 1, x: 16, y: 60 };
    const f = { x: 200, y: 300 };
    const z = zoomViewAbout(v, 2, f.x, f.y);
    // The page point under the focal point, in page fractions, is the same before and after.
    const before = { x: (f.x - v.x) / (fit.w * v.z), y: (f.y - v.y) / (fit.h * v.z) };
    const after = { x: (f.x - z.x) / (fit.w * z.z), y: (f.y - z.y) / (fit.h * z.z) };
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
  });

  it('the live transform shows exactly where the committed zoom lays the page out', () => {
    const v = { z: 1.5, x: -40, y: 10 };
    const size = { w: fit.w * v.z, h: fit.h * v.z };
    const t = liveTransform(v, size, 1.8, 150, 250, 12, -7);
    const z = zoomViewAbout(v, 1.8, 150, 250, 12, -7);
    // RN scales about the view's centre after translating: the top-left corner lands at…
    const cx = v.x + size.w / 2;
    const cy = v.y + size.h / 2;
    expect(cx + t.tx + t.s * (v.x - cx)).toBeCloseTo(z.x, 8);
    expect(cy + t.ty + t.s * (v.y - cy)).toBeCloseTo(z.y, 8);
  });

  it('moves a zoomed page just enough to show a field', () => {
    const v = { z: 3, x: 16, y: 24 };
    // A field near the bottom right of the page, off screen.
    const next = revealRect(v, fit, viewport, { x: 0.8, y: 0.9, w: 0.1, h: 0.03 }, undefined, 16, margin);
    const W = fit.w * 3;
    const H = fit.h * 3;
    expect(next.z).toBe(3);
    expect(next.x + 0.9 * W).toBeLessThanOrEqual(viewport.w - 16 + 0.001);
    expect(next.y + 0.93 * H).toBeLessThanOrEqual(viewport.h - 16 + 0.001);
    // Already visible: unchanged.
    const again = revealRect(next, fit, viewport, { x: 0.8, y: 0.9, w: 0.1, h: 0.03 }, undefined, 16, margin);
    expect(again.x).toBeCloseTo(next.x, 6);
    expect(again.y).toBeCloseTo(next.y, 6);
  });

  it('gives small targets 44 points', () => {
    expect(hitSlopFor(10, 4)).toBe(17); // a 10-pt checkbox reaches 17 pt out: 44 across
    expect(hitSlopFor(60, 4)).toBe(4);
    expect(hitSlopFor(40, 8)).toBe(8);
  });
});

const field = (over: Partial<NativeFillField>): NativeFillField =>
  ({ id: 'f', page: 0, name: 'f', kind: 'text', rect: [0, 0, 0, 0], readOnly: false, fontSize: 0, ...over }) as NativeFillField;

describe('marks dropped on a form field', () => {
  const email = { field: field({ id: 'email', name: 'email' }), rect: { x: 0.26, y: 0.22, w: 0.49, h: 0.025 } };
  const sig = { field: field({ id: 'sig', name: 'sig', kind: 'signature' }), rect: { x: 0.1, y: 0.5, w: 0.3, h: 0.05 } };

  it('finds the text field a mark mostly covers', () => {
    expect(coveredField({ x: 0.3, y: 0.222, w: 0.17, h: 0.018 }, [email, sig])?.field.id).toBe('email');
  });

  it('ignores a mark only touching a field, and signature fields', () => {
    expect(coveredField({ x: 0.1, y: 0.2, w: 0.17, h: 0.03 }, [email])).toBeNull();
    expect(coveredField({ x: 0.15, y: 0.51, w: 0.1, h: 0.03 }, [sig])).toBeNull();
  });
});

describe('Next / Previous order', () => {
  it('reads page by page, row by row, left to right, text fields only', () => {
    const v = (id: string, page: number, x: number, y: number, kind: NativeFillField['kind'] = 'text', readOnly = false) =>
      ({ field: field({ id, page, kind, readOnly }), rect: { x, y, w: 0.2, h: 0.03 } });
    const order = fieldOrder([
      v('p2', 1, 0.1, 0.1),
      v('city', 0, 0.6, 0.301),
      v('zip', 0, 0.1, 0.3),
      v('name', 0, 0.1, 0.1),
      v('box', 0, 0.1, 0.05, 'checkbox'),
      v('locked', 0, 0.1, 0.2, 'text', true),
    ]).map(x => x.field.id);
    expect(order).toEqual(['name', 'zip', 'city', 'p2']);
  });
});

describe('choice placeholders', () => {
  it('knows "Choose…" isn’t a value', () => {
    expect(isPlaceholderChoice('Choose')).toBe(true);
    expect(isPlaceholderChoice('Select one')).toBe(true);
    expect(isPlaceholderChoice('--')).toBe(true);
    expect(isPlaceholderChoice('France')).toBe(false);
  });
});

describe('where a signature lands', () => {
  const page = { width: 612, height: 792 };
  const ink = { width: 300, height: 100 };

  it('sits on the tapped line, centred across the tap', () => {
    const r = placeInkMark('signature', ink, page, { x: 0.3, y: 0.6 });
    expect((r.x + r.w / 2)).toBeCloseTo(0.3, 10);
    const bottom = r.y + r.h;
    // Its bottom just below the tap (descenders cross the line), most of it above.
    expect(bottom).toBeGreaterThan(0.6);
    expect(bottom - 0.6).toBeLessThan(r.h * 0.2);
  });

  it('initials are smaller', () => {
    expect(placeInkMark('initials', ink, page, { x: 0.5, y: 0.5 }).w).toBeLessThan(placeInkMark('signature', ink, page, { x: 0.5, y: 0.5 }).w);
  });

  it('fits inside a signature field', () => {
    const into = { x: 0.1, y: 0.5, w: 0.4, h: 0.05 };
    const r = placeInkMark('signature', ink, page, { x: 0, y: 0 }, into);
    expect(r.x).toBeGreaterThanOrEqual(into.x - 1e-9);
    expect(r.x + r.w).toBeLessThanOrEqual(into.x + into.w + 1e-9);
    expect(r.y).toBeGreaterThanOrEqual(into.y - 1e-9);
    expect(r.y + r.h).toBeLessThanOrEqual(into.y + into.h + 1e-9);
  });
});

describe('initials on every page', () => {
  const sig = { dataUri: 'data:image/png;base64,AA', width: 10, height: 10 };
  const m: FillMark = { id: 'a', page: 0, kind: 'initials', x: 0.8, y: 0.9, w: 0.1, h: 0.05, ink: 'black', signature: sig };
  let n = 0;
  const id = () => `n${++n}`;

  it('puts them on every other page, the same size on paper and at the same spot', () => {
    const sizes = [{ width: 600, height: 800 }, { width: 600, height: 800 }, { width: 800, height: 600 }];
    const out = copyToPages(m, [m], sizes, id);
    expect(out.map(x => x.page)).toEqual([1, 2]);
    expect(out[0]).toMatchObject({ x: 0.8, y: 0.9, w: 0.1, h: 0.05 });
    // The landscape page: 60 × 40 points still.
    expect(out[1].w * 800).toBeCloseTo(60, 6);
    expect(out[1].h * 600).toBeCloseTo(40, 6);
    expect(new Set(out.map(x => x.id)).size).toBe(2);
  });

  it('skips pages that already have initials there', () => {
    const sizes = [{ width: 600, height: 800 }, { width: 600, height: 800 }];
    const there: FillMark = { ...m, id: 'b', page: 1 };
    expect(copyToPages(m, [m, there], sizes, id)).toEqual([]);
  });
});

describe('recently used signatures', () => {
  const a = { dataUri: 'data:a', width: 1, height: 1 };
  const b = { dataUri: 'data:b', width: 1, height: 1 };
  it('newest first, each once, at most three', () => {
    expect(pushRecent([a, b], b)).toEqual([b, a]);
    expect(pushRecent([a, b, { ...a, dataUri: 'data:c' }], { ...a, dataUri: 'data:d' })).toHaveLength(3);
  });
});

describe('what Fill & sign may do with a PDF', () => {
  const f = (kind: NativeFillField['kind']) => field({ kind });
  it('reads the permissions and whether there is a form', () => {
    expect(fillAccessOf({ canAnnotate: true, canFillForms: true, fields: [f('text')] })).toEqual({ kind: 'full', hasFields: true });
    expect(fillAccessOf({ canAnnotate: true, canFillForms: false, fields: [] })).toEqual({ kind: 'full', hasFields: false });
    expect(fillAccessOf({ canAnnotate: true, canFillForms: false, fields: [f('text')] }).kind).toBe('annotate');
    expect(fillAccessOf({ canAnnotate: false, canFillForms: true, fields: [f('checkbox')] }).kind).toBe('form');
    expect(fillAccessOf({ canAnnotate: false, canFillForms: true, fields: [f('signature')] }).kind).toBe('none');
    expect(fillAccessOf({ canAnnotate: false, canFillForms: false, fields: [f('text')] }).kind).toBe('none');
  });

  it('says why it isn’t offered', () => {
    expect(fillBlockedReason({ kind: 'none', hasFields: true })).toMatch(/author/);
    expect(fillBlockedReason({ kind: 'form', hasFields: true })).toBeNull();
    expect(fillBlockedReason(null)).toBeNull();
    expect(signBlockedReason({ kind: 'form', hasFields: true })).toMatch(/form/);
    expect(signBlockedReason({ kind: 'full', hasFields: false })).toBeNull();
    expect(signBlockedReason({ kind: 'locked', hasFields: false })).toBeNull();
  });

  it('remembers filled PDFs once each, newest last', () => {
    expect(withFilled(['a', 'b'], 'a')).toEqual(['b', 'a']);
    expect(withFilled(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd']);
  });
});

describe('the convert suggestion on a form or a filled PDF', () => {
  it('warns that the form and signatures become part of the image', () => {
    expect(convertWarning(true, false)).toMatch(/form fields and any signatures/);
    expect(convertWarning(false, true)).toMatch(/signatures and added text/);
    expect(convertWarning(false, false)).toBeNull();
  });
});

describe('the keyboard for a field', () => {
  it('follows the field name', () => {
    expect(keyboardForField({ name: 'applicant.email', label: '' }).keyboardType).toBe('email-address');
    expect(keyboardForField({ name: 'phone_number' }).keyboardType).toBe('phone-pad');
    expect(keyboardForField({ name: 'full_name' }).textContentType).toBe('name');
    expect(keyboardForField({ name: 'zip' }).textContentType).toBe('postalCode');
    expect(keyboardForField({ name: 'notes' })).toEqual({ keyboardType: 'default', autoCapitalize: 'sentences' });
  });
});
