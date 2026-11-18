// lib/auto-name.ts
// Names for new documents: a readable, locale-aware default ("Scan Nov 18, 2026
// at 12:35 AM"), later replaced by a title read from the page (titleFromText)
// unless the user has renamed the document meanwhile (see lib/save-scan.ts).
//
// These are DISPLAY names and read like the rest of the app ("01:37", not
// "01.37"). Characters a file system rejects are dealt with only when a file is
// actually named after a document — exports and shares (lib/share.ts
// exportFileName, via safeFileName below).
import { formatDate, formatTime } from './format';

/** Characters that aren't allowed (or are awkward) in file names on iOS, macOS and Windows. */
const ILLEGAL_IN_FILE_NAME = /[\\/:*?"<>|\u0000-\u001f]/g;
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** Tidies text for display as a document name: control characters out, whitespace collapsed. */
export function cleanDisplayName(s: string): string {
  return s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Makes `s` safe to use as an exported file's name: a time's ":" becomes "."
 * (as macOS does for screenshots: "01:37" → "01.37"), other illegal characters
 * become spaces, and spaces are tidied.
 */
export function safeFileName(s: string): string {
  return s
    .replace(/(\d):(?=\d)/g, '$1.')
    .replace(ILLEGAL_IN_FILE_NAME, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Default name for a new document: the prefix, then the date and time in the device's own format. */
export function autoName(date: Date = new Date(), prefix: string = 'Scan', locale?: string): string {
  const trimmed = prefix.trim() || 'Scan';
  const resolved = locale ?? Intl.DateTimeFormat().resolvedOptions().locale ?? '';
  const joiner = /^en\b/i.test(resolved) ? ' at ' : ' ';
  return cleanDisplayName(`${trimmed} ${formatDate(date, locale)}${joiner}${formatTime(date, locale)}`);
}

const MAX_TITLE = 40;
// Letters in Latin, Greek, Cyrillic, Hebrew and Arabic scripts (no \p{L}: keep
// the regex engine requirements minimal).
const L = 'A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF';
const LETTER = new RegExp(`[${L}]`, 'g');
const WORD = new RegExp(`[${L}]{3,}`);
const URL_OR_EMAIL = /(https?:\/\/|www\.|\S+@\S+\.\S+|\.(com|net|org|io)\b)/i;
const PHONE = /^[\s()+\-.\d]*(tel|phone|fax|mob(ile)?)?[\s:()+\-.\d]*$/i;
const PAGE_MARKER = /^(page|p\.)\s*\d+(\s*(of|\/)\s*\d+)?$/i;
const DATE_ONLY = /^[\d\s./\-,:]+(am|pm)?$/i;
const MONTH_DATE = /^(\d{1,2}\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,4}(,?\s+\d{2,4})?$/i;

/** Title-cases SHOUTING words longer than three letters; short ones (LLC, USA) stay. */
function tameCaps(line: string): string {
  const letters = line.replace(/[^A-Za-z]/g, '');
  if (letters.length < 4 || letters !== letters.toUpperCase()) return line;
  return line.replace(/[A-Z][A-Z']{3,}/g, w => w[0] + w.slice(1).toLowerCase());
}

function clip(line: string): string {
  if (line.length <= MAX_TITLE) return line;
  const cut = line.slice(0, MAX_TITLE + 1);
  const space = cut.lastIndexOf(' ');
  return (space >= 20 ? cut.slice(0, space) : line.slice(0, MAX_TITLE)).replace(/[\s,.;:–—-]+$/, '');
}

/**
 * The first line of recognised text that reads like a title ("Invoice
 * #2026-0417", "Residential Lease Agreement"), or null when none does. Skips
 * short fragments, lines that are mostly digits or symbols, dates, phone
 * numbers, addresses on the web and "Page 1 of 2" markers. The result is at
 * most 40 characters (cut at a word).
 */
export function titleFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/).slice(0, 25);
  for (const raw of lines) {
    const line = cleanDisplayName(raw).replace(/^[\s\-–—•*·.,;:#]+/, '').trim();
    if (line.length < 4) continue;
    const letters = (line.match(LETTER) ?? []).length;
    if (letters < 3) continue;
    // Mostly letters, or at least a real word next to the numbers ("Invoice #2026-0417").
    const hasWord = WORD.test(line);
    if (!hasWord || letters / line.replace(/\s/g, '').length < 0.35) continue;
    if (URL_OR_EMAIL.test(line) || PHONE.test(line) || PAGE_MARKER.test(line) || DATE_ONLY.test(line) || MONTH_DATE.test(line)) continue;
    return clip(tameCaps(line));
  }
  return null;
}
