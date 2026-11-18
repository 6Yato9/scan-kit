// lib/highlight.ts
// Splits a line of text into plain and matched runs so a search snippet can
// show the words that matched in bold. Pure, so it is unit-tested.

export type HighlightRun = { text: string; match: boolean };

/** Lower-cases and strips accents so "Café" matches "cafe". Keeps string length. */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * Every case- and accent-insensitive occurrence of any whitespace-separated
 * term of `query` in `text` becomes a `match` run; overlapping and adjacent
 * hits merge. An empty query returns the whole text as one plain run.
 */
export function highlightRuns(text: string, query: string | undefined): HighlightRun[] {
  if (!text) return [];
  const terms = (query ?? '')
    .split(/\s+/)
    .map(t => fold(t))
    .filter(t => t.length > 0);
  if (terms.length === 0) return [{ text, match: false }];

  // Fold character by character so indices map back to the original text even
  // when a character decomposes into a letter plus combining marks.
  const chars = Array.from(text);
  const folded: string[] = chars.map(c => fold(c));
  const flat = folded.join('');
  const owner: number[] = [];
  folded.forEach((f, i) => {
    for (let k = 0; k < f.length; k++) owner.push(i);
  });

  const hit = new Array<boolean>(chars.length).fill(false);
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = flat.indexOf(term, from);
      if (at < 0) break;
      for (let k = at; k < at + term.length; k++) hit[owner[k]] = true;
      from = at + 1;
    }
  }

  // A lone combining mark folds to nothing: keep it with the letter before it.
  for (let i = 1; i < chars.length; i++) if (folded[i] === '') hit[i] = hit[i - 1];

  const runs: HighlightRun[] = [];
  chars.forEach((c, i) => {
    const last = runs[runs.length - 1];
    if (last && last.match === hit[i]) last.text += c;
    else runs.push({ text: c, match: hit[i] });
  });
  return runs;
}
