// lib/find-text.ts
// Find text's wording (app/tools/find-text.tsx), kept pure for tests.
import { normalizeTerm } from './redact';

/** Page numbers to read out: "1", "1 and 3", "1, 3 and 4", "1, 3, 4 and 2 more". */
export function pageList(indexes: number[]): string {
  const n = indexes.map(i => String(i + 1));
  if (n.length <= 1) return n.join('');
  if (n.length <= 4) return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
  return `${n.slice(0, 3).join(', ')} and ${n.length - 3} more`;
}

/** The line under the search field once a search has finished. */
export function foundSummary(term: string, perPage: number[]): string {
  const total = perPage.reduce((a, b) => a + b, 0);
  const shown = `“${normalizeTerm(term)}”`;
  if (total === 0) return `No matches for ${shown}`;
  const hit = perPage.map((c, i) => (c > 0 ? i : -1)).filter(i => i >= 0);
  const m = `${total} ${total === 1 ? 'match' : 'matches'}`;
  if (perPage.length === 1) return `${m} for ${shown}`;
  return `${m} for ${shown}, on ${hit.length === 1 ? 'page' : 'pages'} ${pageList(hit)}`;
}
