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

/** Longest snippet shown under a result; the row truncates anything wider anyway. */
const SNIPPET_MAX = 90;

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
    // Fold character by character so a hit's index maps back to the line.
    const chars = Array.from(line);
    const owner: number[] = [];
    const folded = chars
      .map((c, i) => {
        const f = foldForSearch(c);
        for (let k = 0; k < f.length; k++) owner.push(i);
        return f;
      })
      .join('');
    const at = folded.indexOf(query);
    if (at < 0) continue;
    if (chars.length <= max) return line;

    // Window around the hit: a little context before, the rest after.
    const hitStart = owner[at];
    const hitEnd = owner[Math.min(at + query.length, owner.length) - 1] + 1;
    let start = Math.max(0, hitStart - Math.floor((max - (hitEnd - hitStart)) / 3));
    const end = Math.min(chars.length, start + max);
    start = Math.max(0, end - max);
    // Don't cut a word in half at either edge.
    while (start > 0 && start < hitStart && chars[start - 1] !== ' ') start++;
    let stop = end;
    while (stop < chars.length && stop > hitEnd && chars[stop] !== ' ') stop--;
    const body = chars.slice(start, stop).join('').trim();
    return `${start > 0 ? '…' : ''}${body}${stop < chars.length ? '…' : ''}`;
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
