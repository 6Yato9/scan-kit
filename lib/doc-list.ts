// lib/doc-list.ts
// Pure list helpers shared by Home and Files.
import { Document } from '../types/document';
import type { SortKey } from './storage';

export function sortDocuments(docs: Document[], key: SortKey): Document[] {
  switch (key) {
    case 'dateModified':
      return [...docs].sort((a, b) => b.updatedAt - a.updatedAt);
    case 'nameAZ':
      return [...docs].sort((a, b) => a.name.localeCompare(b.name));
    default:
      return [...docs].sort((a, b) => b.createdAt - a.createdAt);
  }
}

/** Lower-case with accents removed, so "Café" matches "cafe". */
export function foldForSearch(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Case- and accent-insensitive match on the name or the recognized text. */
export function matchesQuery(d: Document, q: string): boolean {
  const query = foldForSearch(q.trim());
  if (!query) return true;
  return foldForSearch(d.name).includes(query) || (!!d.ocrText && foldForSearch(d.ocrText).includes(query));
}

/**
 * Longest snippet handed to a result row. The row then windows it again to
 * the width it actually has (`windowAround`), keeping the hit in the middle.
 */
const SNIPPET_MAX = 90;

/** Maps each character of `text` to its folded form, with an index back. */
function foldWithOwners(chars: string[]): { folded: string; owner: number[] } {
  const owner: number[] = [];
  const folded = chars
    .map((c, i) => {
      const f = foldForSearch(c);
      for (let k = 0; k < f.length; k++) owner.push(i);
      return f;
    })
    .join('');
  return { folded, owner };
}

/**
 * A window of at most `max` characters (ellipses included) of `text` with the
 * first hit of `query` in the middle: "…net 30 days. Invoice total…". Whole
 * words only at both cut edges, and a leading or trailing "…" already on
 * `text` (an earlier, wider window) is kept. When the query isn't found the
 * window covers the first of its words that is, else the start of the text.
 * Used for search snippets, so the matched word is never cut off by the
 * row's tail truncation however narrow the row is.
 */
export function windowAround(text: string, query: string, max: number): string {
  let body = text;
  const lead = body.startsWith('…');
  const trail = body.endsWith('…') && body.length > 1;
  if (lead) body = body.slice(1);
  if (trail) body = body.slice(0, -1);
  const chars = Array.from(body);
  const room = Math.max(4, Math.floor(max));
  if (chars.length + (lead ? 1 : 0) + (trail ? 1 : 0) <= room) return text;

  const { folded, owner } = foldWithOwners(chars);
  const q = foldForSearch(query.trim());
  let at = q ? folded.indexOf(q) : -1;
  let len = q.length;
  if (at < 0) {
    for (const term of q.split(/\s+/).filter(Boolean)) {
      const i = folded.indexOf(term);
      if (i >= 0) { at = i; len = term.length; break; }
    }
  }
  const hitStart = at >= 0 ? owner[at] : 0;
  const hitEnd = at >= 0 ? owner[Math.min(at + len, owner.length) - 1] + 1 : 0;

  // Two characters for the ellipses either side; the hit sits in the middle.
  const span = Math.max(1, room - 2);
  let start = Math.max(0, hitStart - Math.floor((span - (hitEnd - hitStart)) / 2));
  if (start > hitStart) start = hitStart; // a hit wider than the window starts it
  const end = Math.min(chars.length, start + span);
  start = Math.max(0, Math.min(start, end - span, hitStart));
  // Don't cut a word in half at either edge (never moving past the hit).
  // A hit inside a word ("voice" in "invoice") shows that whole word.
  let wordStart = hitStart;
  while (wordStart > 0 && chars[wordStart - 1] !== ' ') wordStart--;
  let from = Math.min(start, wordStart);
  while (from > 0 && from < wordStart && chars[from - 1] !== ' ') from++;
  let stop = end;
  while (stop < chars.length && stop > hitEnd && chars[stop] !== ' ') stop--;
  if (stop < chars.length && stop <= hitEnd) stop = end;
  const out = chars.slice(from, stop).join('').trim();
  return `${from > 0 || lead ? '…' : ''}${out}${stop < chars.length || trail ? '…' : ''}`;
}

/**
 * Why a document matched a search, when it matched on its text rather than
 * its name: the first line of its recognized text that contains the query,
 * trimmed to a window around the hit ("…net 30 days. Invoice total…"). Undefined
 * when the name already explains the match or the text doesn't match.
 */
export function searchSnippet(d: Document, q: string, max = SNIPPET_MAX): string | undefined {
  const query = foldForSearch(q.trim());
  if (!query || !d.ocrText) return undefined;
  if (foldForSearch(d.name).includes(query)) return undefined;

  for (const raw of d.ocrText.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (!foldWithOwners(Array.from(line)).folded.includes(query)) continue;
    return windowAround(line, q, max);
  }
  // The query spans a line break: the text matched, but no single line does.
  return undefined;
}

/**
 * Short meta for a narrow grid card: "2 pages, Today", "PDF, Yesterday",
 * "1 page, Nov 17" — the full "Today, 01:28" doesn't fit three columns wide.
 */
export function compactMeta(d: { pages: string[]; pdfUri?: string; updatedAt: number }, now: Date = new Date(), locale?: string): string {
  const count = d.pdfUri ? 'PDF' : `${d.pages.length} ${d.pages.length === 1 ? 'page' : 'pages'}`;
  const t = new Date(d.updatedAt);
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const when = same(t, now)
    ? 'Today'
    : same(t, yesterday)
      ? 'Yesterday'
      : t.toLocaleDateString(locale, t.getFullYear() === now.getFullYear()
        ? { month: 'short', day: 'numeric' }
        : { month: 'short', year: 'numeric' });
  return `${count}, ${when}`;
}
