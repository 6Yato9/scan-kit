// lib/text-format.ts
// Extract text's output choices (round 16). Pure.
//
// Recognised text comes as the page's lines. "Joined" turns each paragraph
// (lines up to a blank line) into one line, the way text pasted into an
// email or a document wants it: line breaks inside a paragraph become spaces,
// and a word hyphenated across two lines is put back together ("exam-" +
// "ple" → "example"; a hyphen before a capital or a digit is kept, since it
// is more likely a real one: "Jean-" + "Pierre" → "Jean-Pierre").
import { oneOf } from './tool-prefs';

export type LineBreaks = 'keep' | 'join';
export type TextShareAs = 'text' | 'file';

export type ExtractTextPrefs = { lineBreaks: LineBreaks; shareAs: TextShareAs };
export const DEFAULT_EXTRACT_TEXT: ExtractTextPrefs = { lineBreaks: 'keep', shareAs: 'text' };

export function parseExtractTextPrefs(o: Record<string, unknown>): ExtractTextPrefs {
  return {
    lineBreaks: oneOf<LineBreaks>(['keep', 'join'], o.lineBreaks, 'keep'),
    shareAs: oneOf<TextShareAs>(['text', 'file'], o.shareAs, 'text'),
  };
}

/** Each paragraph's lines joined into one; blank lines (paragraph breaks) kept. */
export function joinParagraphs(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map(par => {
      const lines = par.split('\n').map(l => l.trim()).filter(Boolean);
      let out = '';
      for (const line of lines) {
        if (!out) out = line;
        else if (/[a-zà-ÿ]-$/.test(out) && /^[a-zà-ÿ]/.test(line)) out = out.slice(0, -1) + line;
        else if (/\S-$/.test(out)) out += line; // a real hyphen at the line end: no space after it
        else out = `${out} ${line}`;
      }
      return out;
    })
    .filter(Boolean)
    .join('\n\n');
}

/** The text as chosen. */
export function formatRecognized(text: string, lineBreaks: LineBreaks): string {
  return lineBreaks === 'join' ? joinParagraphs(text) : text;
}

/** A .txt file name from the text's first line ("Lease Renewal Notice.txt"); "Recognized text.txt" when there is none. */
export function textFileName(text: string): string {
  const first = text.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  const name = first
    .replace(/[\\/:*?"<>|#%{}^~[\]`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 50)
    .trim()
    .replace(/[\s.,;:!-]+$/, '');
  return `${name || 'Recognized text'}.txt`;
}

type Line = { text: string; top: number; height: number };

/**
 * The lines with a blank line where the page has a paragraph break: a gap
 * above a line taller than ~0.8 of the typical line height. Recognition
 * itself returns lines only, so this is what "Joined" joins within. Lines are
 * taken in the order recognition gives them (top to bottom).
 */
export function paragraphText(lines: Line[]): string {
  const kept = lines.filter(l => l.text.trim());
  if (kept.length === 0) return '';
  const heights = kept.map(l => l.height).filter(h => h > 0).sort((a, b) => a - b);
  const typical = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
  let out = kept[0].text.trim();
  for (let i = 1; i < kept.length; i++) {
    const prev = kept[i - 1];
    const gap = kept[i].top - (prev.top + prev.height);
    out += (typical > 0 && gap > typical * 0.8 ? '\n\n' : '\n') + kept[i].text.trim();
  }
  return out;
}
