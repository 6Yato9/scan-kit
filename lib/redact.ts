// lib/redact.ts
// The logic behind Redact (app/tools/redact.tsx): boxes the user draws on a
// page, boxes proposed over every match of a search term or a pattern
// (email addresses, phone numbers) in the page's recognised text, and the
// check that a redaction really removed what it covered.
//
// Boxes are fractions (0..1) of the page — x / w of its width, y / h of its
// height — the same RedactRect lib/stamp.ts burns into the pixels, so the
// box on the preview is exactly the box in the page.
//
// WHERE A MATCH IS. Text recognition (lib/ocr.ts → Apple Vision) gives one
// box per LINE, not per word or character. A match covering a whole line gets
// the line's box. A match inside a line gets the part of the line box its
// characters span, measured proportionally: each character is weighted by its
// typical width in a proportional font (an "i" is narrower than an "M"), and
// the span is padded by about half a character on each side and a little
// above and below, then kept inside the line. The estimate errs wide, and
// after redacting, the page is read again and any match still readable under
// a box is reported (leftoverMatches), so an under-covered word is caught.
import type { Box, Handle } from './placement';
import type { RedactRect } from './stamp';
import type { OcrLine } from './ocr';

export type { RedactRect };

/** A box on a page, with where it came from (for the summary line and VoiceOver). */
export type RedactBox = RedactRect & { id: string; source: RedactSource };
export type RedactSource = 'drawn' | 'search' | 'email' | 'phone';

let seq = 0;
export function newBoxId(): string {
  seq += 1;
  return `b${Date.now().toString(36)}${seq}`;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

// ── Boxes on the preview (points) ──────────────────────────────────────────

/** Smallest a box can be drawn or resized to on the preview, in points. */
export const MIN_REDACT_POINTS = 10;

/** The box spanned by two points (any corner order), kept on the page. */
export function boxFromPoints(ax: number, ay: number, bx: number, by: number, bounds: { width: number; height: number }): Box {
  const x0 = clamp(Math.min(ax, bx), 0, bounds.width);
  const y0 = clamp(Math.min(ay, by), 0, bounds.height);
  const x1 = clamp(Math.max(ax, bx), 0, bounds.width);
  const y1 = clamp(Math.max(ay, by), 0, bounds.height);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Dragged by a corner by (dx, dy): the opposite corner stays put and the box
 * takes any shape (unlike a signature's, lib/placement resizeBox). The
 * dragged corner stops at the page edges and never comes closer than `min`
 * to the pinned one.
 */
export function resizeFreeBox(
  start: Box,
  handle: Handle,
  dx: number,
  dy: number,
  bounds: { width: number; height: number },
  min = MIN_REDACT_POINTS,
): Box {
  const right = handle === 'tr' || handle === 'br';
  const bottom = handle === 'bl' || handle === 'br';
  const minW = Math.min(min, bounds.width);
  const minH = Math.min(min, bounds.height);
  let x0 = start.x;
  let x1 = start.x + start.w;
  let y0 = start.y;
  let y1 = start.y + start.h;
  if (right) x1 = clamp(x1 + dx, x0 + minW, bounds.width);
  else x0 = clamp(x0 + dx, 0, x1 - minW);
  if (bottom) y1 = clamp(y1 + dy, y0 + minH, bounds.height);
  else y0 = clamp(y0 + dy, 0, y1 - minH);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The topmost box (last drawn) under a point, with `slop` points of reach, or -1. */
export function boxAt(boxes: readonly Box[], px: number, py: number, slop = 0): number {
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i];
    if (px >= b.x - slop && px <= b.x + b.w + slop && py >= b.y - slop && py <= b.y + b.h + slop) return i;
  }
  return -1;
}

/** The corner of `b` within `radius` points of the point (nearest first), or null. */
export function cornerAt(b: Box, px: number, py: number, radius: number): Handle | null {
  const corners: [Handle, number, number][] = [
    ['tl', b.x, b.y],
    ['tr', b.x + b.w, b.y],
    ['bl', b.x, b.y + b.h],
    ['br', b.x + b.w, b.y + b.h],
  ];
  let best: Handle | null = null;
  let bestD = radius;
  for (const [h, cx, cy] of corners) {
    const d = Math.hypot(px - cx, py - cy);
    if (d <= bestD) {
      best = h;
      bestD = d;
    }
  }
  return best;
}

export function toPoints(r: RedactRect, bounds: { width: number; height: number }): Box {
  return { x: r.x * bounds.width, y: r.y * bounds.height, w: r.w * bounds.width, h: r.h * bounds.height };
}

export function toFractions(b: Box, bounds: { width: number; height: number }): RedactRect {
  if (!(bounds.width > 0) || !(bounds.height > 0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: b.x / bounds.width, y: b.y / bounds.height, w: b.w / bounds.width, h: b.h / bounds.height };
}

// ── Finding text ───────────────────────────────────────────────────────────

/** Case- and accent-insensitive form of one character (may be longer or empty). */
function foldChar(c: string): string {
  return c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * `text` folded for matching, with, for every folded code unit, the index of
 * the original character it came from — so a match in the folded text maps
 * back to the original characters exactly (a "é" folds to one "e"; a ligature
 * may fold to two letters).
 */
export function foldWithMap(text: string): { folded: string; owner: number[] } {
  const chars = Array.from(text);
  let folded = '';
  const owner: number[] = [];
  chars.forEach((c, i) => {
    const f = foldChar(c);
    folded += f;
    for (let k = 0; k < f.length; k++) owner.push(i);
  });
  return { folded, owner };
}

/** Collapses runs of white space to one space and trims, as a search term is typed. */
export function normalizeTerm(term: string): string {
  return term.replace(/\s+/g, ' ').trim();
}

/** Shortest term searched for: one letter would cover half the document. */
export const MIN_TERM_LENGTH = 2;

/**
 * Every place `term` occurs in `text` (case- and accent-insensitive; any run
 * of white space in the text matches one space in the term), as [start, end)
 * indices of the text's characters (code points). Non-overlapping.
 */
export function findInText(text: string, term: string): { start: number; end: number }[] {
  const t = foldWithMap(normalizeTerm(term)).folded;
  if (t.length < MIN_TERM_LENGTH) return [];
  // Text with each white-space run as one space, mapped back to the text.
  const chars = Array.from(text);
  let squeezed = '';
  const back: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (/\s/.test(chars[i])) {
      if (squeezed.endsWith(' ')) continue;
      squeezed += ' ';
      back.push(i);
    } else {
      squeezed += chars[i];
      back.push(i);
    }
  }
  const { folded, owner } = foldWithMap(squeezed);
  const out: { start: number; end: number }[] = [];
  let from = 0;
  for (;;) {
    const at = folded.indexOf(t, from);
    if (at < 0) break;
    const first = back[owner[at]];
    const last = back[owner[at + t.length - 1]];
    out.push({ start: first, end: last + 1 });
    from = at + t.length;
  }
  return out;
}

/** Email addresses (the usual shape; good enough to propose, the user reviews). */
const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
/**
 * Phone-number candidates: an optional "+", then digits with spaces, dots,
 * dashes or brackets between them. Kept only with 9 to 15 digits (no slashes,
 * so dates like 18/11/2026 never match; 8-digit dates written with dashes
 * have too few digits).
 */
const PHONE_RE = /(?:\+\(?|\(|\b)\d[\d\s().-]{6,}\d\b/g;

export type RedactPattern = 'email' | 'phone';

/** Every match of an email address or a phone number in `text`, as [start, end) character indices. */
export function findPattern(text: string, kind: RedactPattern): { start: number; end: number }[] {
  const chars = Array.from(text);
  // Regexes index UTF-16 units; map them to characters.
  const unitToChar: number[] = [];
  chars.forEach((c, i) => {
    for (let k = 0; k < c.length; k++) unitToChar.push(i);
  });
  unitToChar.push(chars.length);
  const re = new RegExp(kind === 'email' ? EMAIL_RE.source : PHONE_RE.source, 'gi');
  const out: { start: number; end: number }[] = [];
  for (const m of text.matchAll(re)) {
    let s = m[0];
    let at = m.index ?? 0;
    if (kind === 'phone') {
      // Trailing separators belong to the sentence, not the number.
      const trimmed = s.replace(/[\s.-]+$/, '');
      s = trimmed;
      const lead = s.length - s.trimStart().length;
      at += lead;
      s = s.trimStart();
      const digits = (s.match(/\d/g) ?? []).length;
      if (digits < 9 || digits > 15) continue;
    }
    out.push({ start: unitToChar[at], end: unitToChar[at + s.length] });
  }
  return out;
}

/**
 * Relative width of a character in a proportional font, so a match's share of
 * its line is estimated from the letters it holds, not just their count.
 */
export function charWeight(c: string): number {
  if (/\s/.test(c)) return 0.3;
  if (/[iljI.,:;'!|`]/.test(c)) return 0.35;
  if (/[ftr()\[\]{}"-]/.test(c)) return 0.5;
  if (/[mwMW@%]/.test(c)) return 1.4;
  if (/[A-Z0-9#&]/.test(c)) return 1.1;
  return 1;
}

/** How far a match is padded on each side, in average characters. */
const PAD_CHARS = 0.6;
/** …and above and below, as a share of the line height. */
const PAD_V = 0.18;

/**
 * The span [from, to) of the line's width that characters [start, end) of
 * `text` cover, as fractions 0..1, padded by about half a character a side.
 */
export function spanOfLine(text: string, start: number, end: number): { from: number; to: number } {
  const chars = Array.from(text);
  if (chars.length === 0) return { from: 0, to: 1 };
  const weights = chars.map(charWeight);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let before = 0;
  for (let i = 0; i < Math.max(0, start); i++) before += weights[i] ?? 0;
  let inside = 0;
  for (let i = Math.max(0, start); i < Math.min(chars.length, end); i++) inside += weights[i];
  const pad = (PAD_CHARS * total) / chars.length;
  const from = start <= 0 ? 0 : Math.max(0, (before - pad) / total);
  const to = end >= chars.length ? 1 : Math.min(1, (before + inside + pad) / total);
  return { from, to };
}

/** The page-fraction box for characters [start, end) of an OCR line on an image `img` pixels in size. */
export function matchBox(line: OcrLine, start: number, end: number, img: { width: number; height: number }): RedactRect {
  const { from, to } = spanOfLine(line.text, start, end);
  const padY = line.height * PAD_V;
  const x0 = (line.left + from * line.width) / img.width;
  const x1 = (line.left + to * line.width) / img.width;
  const y0 = (line.top - padY) / img.height;
  const y1 = (line.top + line.height + padY) / img.height;
  const cx0 = clamp(x0, 0, 1);
  const cy0 = clamp(y0, 0, 1);
  return { x: cx0, y: cy0, w: clamp(x1, 0, 1) - cx0, h: clamp(y1, 0, 1) - cy0 };
}

export type Finder = { kind: 'term'; term: string } | { kind: RedactPattern };

/** Every match of `finder` on one page, as boxes. Lines without a usable box are skipped. */
export function findOnPage(lines: readonly OcrLine[], img: { width: number; height: number } | null, finder: Finder): RedactRect[] {
  if (!img || !(img.width > 0) || !(img.height > 0)) return [];
  const out: RedactRect[] = [];
  for (const line of lines) {
    if (!line.text || !(line.width > 0) || !(line.height > 0)) continue;
    const hits = finder.kind === 'term' ? findInText(line.text, finder.term) : findPattern(line.text, finder.kind);
    for (const h of hits) out.push(matchBox(line, h.start, h.end, img));
  }
  return out;
}

// ── Merging proposals ──────────────────────────────────────────────────────

function area(r: RedactRect): number {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

function overlapArea(a: RedactRect, b: RedactRect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** True when `inner` lies (almost: 90%) within `outer`. */
export function covers(outer: RedactRect, inner: RedactRect): boolean {
  const a = area(inner);
  return a > 0 && overlapArea(outer, inner) >= 0.9 * a;
}

/**
 * Adds proposals to a page's boxes, skipping any already covered by a box
 * the page has (searching twice, or a term inside an email already boxed,
 * doesn't stack boxes). Returns the new list and how many were added.
 */
export function addProposals(
  existing: readonly RedactBox[],
  found: readonly RedactRect[],
  source: RedactSource,
): { boxes: RedactBox[]; added: number } {
  const boxes = [...existing];
  let added = 0;
  for (const r of found) {
    if (boxes.some(b => covers(b, r))) continue;
    boxes.push({ ...r, id: newBoxId(), source });
    added += 1;
  }
  return { boxes, added };
}

// ── After redacting ────────────────────────────────────────────────────────

/**
 * Where the "REDACTED" label Redact can print across its boxes (lib/stamp.ts
 * REDACT_LABEL) is read in a line, as [start, end) character indices: any
 * word holding "DACT", or starting "REDAC" (text recognition may drop or
 * misread a letter of it).
 */
export function labelSpans(text: string): { start: number; end: number }[] {
  const chars = Array.from(text);
  const out: { start: number; end: number }[] = [];
  let i = 0;
  while (i < chars.length) {
    if (/\s/.test(chars[i])) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < chars.length && !/\s/.test(chars[j])) j += 1;
    const word = chars.slice(i, j).join('').toUpperCase();
    if (word.includes('DACT') || word.includes('REDAC')) out.push({ start: i, end: j });
    i = j;
  }
  return out;
}

/**
 * The matches of `finders` (search terms, patterns) still readable on a
 * redacted page whose centre lies under one of the applied boxes: the box
 * didn't fully cover them. (A match outside every box was left on purpose —
 * the user removed that proposal — and isn't reported.) A match inside the
 * word "REDACTED" is the label printed on a box, not a leftover: searching
 * "red" must not find it again under every labelled box.
 */
export function leftoverMatches(
  lines: readonly OcrLine[],
  img: { width: number; height: number } | null,
  finders: readonly Finder[],
  applied: readonly RedactRect[],
): RedactRect[] {
  const out: RedactRect[] = [];
  if (!img || !(img.width > 0) || !(img.height > 0)) return out;
  for (const finder of finders) {
    for (const line of lines) {
      if (!line.text || !(line.width > 0) || !(line.height > 0)) continue;
      const labels = labelSpans(line.text);
      const hits = finder.kind === 'term' ? findInText(line.text, finder.term) : findPattern(line.text, finder.kind);
      for (const h of hits) {
        if (labels.some(l => h.start >= l.start && h.end <= l.end)) continue;
        const r = matchBox(line, h.start, h.end, img);
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        if (applied.some(b => cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h)) out.push(r);
      }
    }
  }
  return out;
}

/** A box grown by `k` of its size on every side (kept on the page): a second, wider try. */
export function grow(r: RedactRect, k: number): RedactRect {
  const x0 = clamp(r.x - r.w * k, 0, 1);
  const y0 = clamp(r.y - r.h * k, 0, 1);
  const x1 = clamp(r.x + r.w * (1 + k), 0, 1);
  const y1 = clamp(r.y + r.h * (1 + k), 0, 1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** "3 boxes on 2 pages", "1 box". */
export function boxesSummary(perPage: readonly number[]): string {
  const total = perPage.reduce((a, b) => a + b, 0);
  const pages = perPage.filter(n => n > 0).length;
  const boxes = `${total} ${total === 1 ? 'box' : 'boxes'}`;
  return pages > 1 ? `${boxes} on ${pages} pages` : boxes;
}

/** What a finished search says: "Found 4 matches on 2 pages", "No matches for “Smith”". */
export function findSummary(finder: Finder, added: number, pages: number, alreadyCovered: number): string {
  const what = finder.kind === 'term' ? `“${normalizeTerm(finder.term)}”` : finder.kind === 'email' ? 'email addresses' : 'phone numbers';
  if (added === 0 && alreadyCovered > 0) return `Every match for ${what} is already covered`;
  if (added === 0) return finder.kind === 'term' ? `No matches for ${what}` : `No ${what} found`;
  const m = `${added} ${added === 1 ? 'match' : 'matches'}`;
  return pages > 1 ? `Found ${m} on ${pages} pages` : `Found ${m}`;
}
