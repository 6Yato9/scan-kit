// lib/page-ranges.ts
// Page ranges typed by people (round 16): Split › "By ranges" ("1-3, 4-8, 9")
// and Extract pages' "Select pages" field. Pure and 1-based on screen,
// 0-based in the result.
//
// Accepted: numbers and ranges separated by commas or semicolons (spaces are
// ignored), with a hyphen, en dash or "to"; "7-" (or "7-end") runs to the last
// page. A range written backwards ("5-3") is an error rather than a guess —
// reversed page order is something else.
import { numberIn, oneOf } from './tool-prefs';

export type RangeParse = { ok: true; ranges: number[][] } | { ok: false; error: string };

const pagesWord = (n: number) => (n === 1 ? 'page' : 'pages');

/** "1-3, 5, 7-" on a `count`-page document → each range's page indices, in the order typed. */
export function parsePageRanges(text: string, count: number): RangeParse {
  const items = text
    .split(/[,;]+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (items.length === 0) return { ok: false, error: 'Type pages, for example 1-3, 5.' };
  const ranges: number[][] = [];
  for (const item of items) {
    const m = /^(\d+)\s*(?:(?:-|–|—|to)\s*(\d+|end)?)?$/i.exec(item);
    if (!m) return { ok: false, error: `“${item}” isn’t a page or a range. Use numbers like 1-3, 5.` };
    const a = Number(m[1]);
    const isRange = /-|–|—|to/i.test(item);
    const b = !isRange ? a : m[2] === undefined || /^end$/i.test(m[2]) ? count : Number(m[2]);
    for (const p of [a, b]) {
      if (p < 1 || p > count) {
        return { ok: false, error: `There’s no page ${p}: this document has ${count} ${pagesWord(count)}.` };
      }
    }
    if (b < a) return { ok: false, error: `${a}–${b} runs backwards. Write it as ${b}–${a}.` };
    ranges.push(Array.from({ length: b - a + 1 }, (_, k) => a - 1 + k));
  }
  return { ok: true, ranges };
}

/** The pages any of the ranges name, each once, in page order (Extract pages). */
export function pagesInRanges(ranges: number[][]): number[] {
  return [...new Set(ranges.flat())].sort((x, y) => x - y);
}

/** A `count`-page document cut into documents of `size` pages (the last may be shorter). */
export function chunkPages(count: number, size: number): number[][] {
  const n = Math.max(1, Math.floor(size));
  const out: number[][] = [];
  for (let s = 0; s < count; s += n) out.push(Array.from({ length: Math.min(n, count - s) }, (_, k) => s + k));
  return out;
}

/** "1–3", "5", for one part (0-based pages in, 1-based out; runs of consecutive pages joined). */
export function rangeLabel(pages: number[]): string {
  const runs: string[] = [];
  let i = 0;
  while (i < pages.length) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    runs.push(i === j ? `${pages[i] + 1}` : `${pages[i] + 1}–${pages[j] + 1}`);
    i = j + 1;
  }
  return runs.join(', ');
}

/** The selection written back as ranges ("1–3, 5"), e.g. to prefill Extract's field. */
export function selectionLabel(selected: Iterable<number>): string {
  return rangeLabel([...new Set(selected)].sort((a, b) => a - b));
}

/** Every other page: odd (1, 3, 5…) or even (2, 4, 6…), as 0-based indices. */
export function oddEvenPages(count: number, which: 'odd' | 'even'): number[] {
  return Array.from({ length: count }, (_, i) => i).filter(i => (which === 'odd' ? i % 2 === 0 : i % 2 === 1));
}

/**
 * What a split makes, in one line: "4 documents: pages 1–3, 4–6, 7–9, 10–12".
 * Long lists are shortened after six parts.
 */
export function describeParts(parts: number[][]): string {
  const shown = parts.slice(0, 6).map(rangeLabel);
  const more = parts.length > 6 ? `, and ${parts.length - 6} more` : '';
  return `${parts.length} ${parts.length === 1 ? 'document' : 'documents'}: ${parts.length === 1 ? pagesWord(parts[0].length) : 'pages'} ${shown.join(', ')}${more}`;
}

// ── Split's remembered choices ──────────────────────────────────────────────

export type SplitMode = 'at' | 'every' | 'ranges';
const SPLIT_MODES: readonly SplitMode[] = ['at', 'every', 'ranges'];
export type SplitPrefs = { mode: SplitMode; every: number };

/**
 * "Every N pages" starts at two pages per document: one per page is a choice
 * to make on purpose (it can mean a document for every page of a long scan).
 */
export const DEFAULT_SPLIT_EVERY = 2;
export const DEFAULT_SPLIT_PREFS: SplitPrefs = { mode: 'at', every: DEFAULT_SPLIT_EVERY };

/** More parts than this and Split asks first (each part is a document of its own, with copies of its pages). */
export const SPLIT_CONFIRM_OVER = 10;

/** Remembered split choices; anything unknown is the classic split in two. Pure. */
export function parseSplitPrefs(o: Record<string, unknown>): SplitPrefs {
  return { mode: oneOf(SPLIT_MODES, o.mode, 'at'), every: numberIn(o.every, 1, 500, DEFAULT_SPLIT_EVERY) };
}

/** The pages (0-based, in order) of a `count`-page document that none of `parts` names. Pure. */
export function omittedPages(parts: readonly (readonly number[])[], count: number): number[] {
  const used = new Set(parts.flat());
  return Array.from({ length: count }, (_, i) => i).filter(i => !used.has(i));
}

/** True when `parts` between them name every page of a `count`-page document. Pure. */
export function everyPageNamed(parts: readonly (readonly number[])[], count: number): boolean {
  return omittedPages(parts, count).length === 0;
}

/**
 * Why the original can't go to Recently deleted, or null when it can: pages no
 * part names would then exist only in the deleted original (By ranges).
 * "Pages 4, 6 aren’t in any range, so the original is kept." Pure.
 */
export function keepOriginalReason(omitted: readonly number[]): string | null {
  if (omitted.length === 0) return null;
  const label = rangeLabel([...omitted]);
  return omitted.length === 1
    ? `Page ${label} isn’t in any range, so the original is kept.`
    : `Pages ${label} aren’t in any range, so the original is kept.`;
}

/** "two new documents" (the classic split's words), "1 new document", "3 new documents". Pure. */
export function newDocumentsLabel(n: number): string {
  return n === 2 ? 'two new documents' : n === 1 ? '1 new document' : `${n} new documents`;
}
