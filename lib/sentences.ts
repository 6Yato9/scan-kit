// lib/sentences.ts
// Finding the sentence around a position in recognized text (pure, no React):
// the read-aloud caption shows it, and a date chip titles its event with it.
// OCR text breaks lines where the page did, so a line break only ends a
// sentence when the next line doesn't carry on in lower case.

const ABBREVIATIONS = /^(mr|mrs|ms|mx|dr|prof|st|sr|jr|mt|no|nr|vs|etc|e\.g|i\.e|inc|ltd|co|corp|dept|approx|tel|fig|p|pp|vol|m|mme|mlle|me|av|bd|bldg|ste|apt|ave|rd)$/i;

/** The sentence around UTF-16 index `at`: [start, end) of `text`, trimmed. */
export function sentenceAt(text: string, at: number): [number, number] {
  const n = text.length;
  const i = Math.max(0, Math.min(at, n));
  // A sentence ends at . ! ? … followed by a space, or at a line break —
  // unless the next line carries on in lower case (a sentence the page
  // wrapped: "your next appointment\non Thursday").
  const isEnd = (k: number) => {
    const c = text[k];
    if (c === '\n') return !/^[ \t]*\p{Ll}/u.test(text.slice(k + 1, k + 12));
    if (!(c === '.' || c === '!' || c === '?' || c === '…') || !(k + 1 >= n || /\s/.test(text[k + 1]))) return false;
    // "Mr. Carter", "Dr. Hart", "J. Smith", "e.g. this": not the end of a sentence.
    if (c === '.') {
      const before = /([\p{L}.]+)$/u.exec(text.slice(Math.max(0, k - 12), k))?.[1] ?? '';
      if (/^\p{L}$/u.test(before) || ABBREVIATIONS.test(before)) return false;
    }
    return true;
  };
  let start = i;
  while (start > 0 && !isEnd(start - 1)) start--;
  let end = i;
  while (end < n && !isEnd(end)) end++;
  if (end < n && text[end] !== '\n') end++; // keep the full stop
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return [start, end];
}

