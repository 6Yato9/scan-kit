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

/** Remembered split choices; anything unknown is the classic split in two. Pure. */
export function parseSplitPrefs(o: Record<string, unknown>): SplitPrefs {
  return { mode: oneOf(SPLIT_MODES, o.mode, 'at'), every: numberIn(o.every, 1, 500, 1) };
}
