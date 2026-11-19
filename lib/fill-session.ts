// lib/fill-session.ts
//
// The pure rules of a Fill & sign session (app/pdf-fill.tsx), kept apart so
// they are unit-tested: which form field an addition was dropped on, the order
// Next / Previous walk the fields in, where a signature lands for a tap,
// initials copied to every page, and the session's recently used signatures.
// Everything is in display fractions of a page (lib/pdf-fill.ts DisplayRect).
import type { NativeFillField } from '../modules/vision-ocr/src';
import type { Signature } from './stamp';
import type { DisplayRect, FillMark, FillMarkKind } from './pdf-fill';

type FieldView = { field: NativeFillField; rect: DisplayRect };
type Rect = { x: number; y: number; w: number; h: number };

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The text or list field an addition mostly lies on (more than `share` of the
 * addition's area), or null. A PDF draws its form above everything added to a
 * page, so an addition there would be hidden in the saved file. Signature
 * fields don't count (a signature belongs in them).
 */
export function coveredField(m: Pick<FillMark, 'x' | 'y' | 'w' | 'h'>, fields: readonly FieldView[], share = 0.5): FieldView | null {
  const area = m.w * m.h;
  if (!(area > 0)) return null;
  let best: { v: FieldView; o: number } | null = null;
  for (const v of fields) {
    if (v.field.kind !== 'text' && v.field.kind !== 'choice') continue;
    const o = overlapArea(m, v.rect);
    if (o / area > share && (!best || o > best.o)) best = { v, o };
  }
  return best?.v ?? null;
}

/**
 * Fillable text fields in reading order: page, then rows top to bottom (fields
 * whose tops are within half a line count as one row), then left to right.
 */
export function fieldOrder(fields: readonly FieldView[]): FieldView[] {
  const list = fields.filter(v => v.field.kind === 'text' && !v.field.readOnly);
  return [...list].sort((a, b) => {
    if (a.field.page !== b.field.page) return a.field.page - b.field.page;
    const row = Math.min(a.rect.h, b.rect.h) / 2;
    if (Math.abs(a.rect.y - b.rect.y) > row) return a.rect.y - b.rect.y;
    return a.rect.x - b.rect.x;
  });
}

/** A list's "Choose…" / "Select" / "--" first entry: not worth saying "Selected: Choose". */
export function isPlaceholderChoice(value: string): boolean {
  const v = value.trim();
  return v === '' || /^(choose|select|pick|please (choose|select))\b/i.test(v) || /^[-–—\s.]+$/.test(v);
}

/**
 * Where a signature or initials land for a tap at `at` (fractions) on a page
 * `page` points as shown: centred across the tap, sitting ON it — people tap
 * the line they sign on, so the ink's bottom is just below the tap (its
 * descenders cross the line). In a signature field (`into`, fractions) it is
 * fitted inside the field instead.
 */
export function placeInkMark(
  kind: FillMarkKind,
  sig: Pick<Signature, 'width' | 'height'>,
  page: { width: number; height: number },
  at: { x: number; y: number },
  into?: DisplayRect | null,
): { x: number; y: number; w: number; h: number } {
  const W = page.width;
  const H = page.height;
  const ratio = sig.width > 0 ? sig.height / sig.width : 0.4;
  let wPts = W * (kind === 'initials' ? 0.12 : 0.3);
  let cx = at.x * W;
  let bottom = at.y * H + wPts * ratio * 0.12;
  if (into) {
    wPts = Math.min(into.w * W, (into.h * H) / ratio) * 0.95;
    cx = (into.x + into.w / 2) * W;
    bottom = (into.y + into.h / 2) * H + (wPts * ratio) / 2;
  }
  const hPts = wPts * ratio;
  return { x: (cx - wPts / 2) / W, y: (bottom - hPts) / H, w: wPts / W, h: hPts / H };
}

/**
 * `m` (initials) on every other page, the same size on paper and at the same
 * spot (fractions), skipping pages that already have initials there. `sizes`:
 * each page's size as shown, in points.
 */
export function copyToPages(
  m: FillMark,
  marks: readonly FillMark[],
  sizes: readonly { width: number; height: number }[],
  newId: () => string,
): FillMark[] {
  const from = sizes[m.page];
  if (!from || !(from.width > 0) || !(from.height > 0)) return [];
  const wPts = m.w * from.width;
  const hPts = m.h * from.height;
  const out: FillMark[] = [];
  sizes.forEach((size, page) => {
    if (page === m.page || !(size.width > 0) || !(size.height > 0)) return;
    const w = Math.min(1, wPts / size.width);
    const h = Math.min(1, hPts / size.height);
    const x = Math.min(Math.max(0, m.x), 1 - w);
    const y = Math.min(Math.max(0, m.y), 1 - h);
    const spot = { x, y, w, h };
    const taken = marks.some(o => o.page === page && o.kind === m.kind && overlapArea(o, spot) > 0.3 * w * h);
    if (taken) return;
    out.push({ ...m, id: newId(), page, ...spot });
  });
  return out;
}

/** The session's signatures, newest first, each once (by image), at most `max`. */
export function pushRecent(list: readonly Signature[], sig: Signature, max = 3): Signature[] {
  return [sig, ...list.filter(s => s.dataUri !== sig.dataUri)].slice(0, max);
}

export type FieldKeyboard = {
  keyboardType: 'default' | 'email-address' | 'phone-pad' | 'number-pad' | 'url';
  textContentType?: 'emailAddress' | 'telephoneNumber' | 'postalCode' | 'name' | 'givenName' | 'familyName' | 'fullStreetAddress' | 'addressCity' | 'URL';
  autoCapitalize: 'none' | 'words' | 'sentences';
};

/**
 * The keyboard for a form field, from its name or description ("email",
 * "phone", "zip"…), so the right keys show and AutoFill can offer the
 * user's own details.
 */
export function keyboardForField(f: Pick<NativeFillField, 'name' | 'label'>): FieldKeyboard {
  const s = `${f.label ?? ''} ${f.name ?? ''}`.toLowerCase().replace(/[_.\-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  const has = (re: RegExp) => re.test(s);
  if (has(/e ?mail/)) return { keyboardType: 'email-address', textContentType: 'emailAddress', autoCapitalize: 'none' };
  if (has(/\b(phone|tel|telephone|mobile|cell)\b/)) return { keyboardType: 'phone-pad', textContentType: 'telephoneNumber', autoCapitalize: 'none' };
  if (has(/\b(zip|postcode|postal)\b/)) return { keyboardType: 'default', textContentType: 'postalCode', autoCapitalize: 'none' };
  if (has(/\b(website|url|web site)\b/)) return { keyboardType: 'url', textContentType: 'URL', autoCapitalize: 'none' };
  if (has(/\b(first name|given name)\b/)) return { keyboardType: 'default', textContentType: 'givenName', autoCapitalize: 'words' };
  if (has(/\b(last name|surname|family name)\b/)) return { keyboardType: 'default', textContentType: 'familyName', autoCapitalize: 'words' };
  if (has(/\b(full name|name)\b/)) return { keyboardType: 'default', textContentType: 'name', autoCapitalize: 'words' };
  if (has(/\bcity\b/)) return { keyboardType: 'default', textContentType: 'addressCity', autoCapitalize: 'words' };
  if (has(/\baddress\b/)) return { keyboardType: 'default', textContentType: 'fullStreetAddress', autoCapitalize: 'words' };
  return { keyboardType: 'default', autoCapitalize: 'sentences' };
}
