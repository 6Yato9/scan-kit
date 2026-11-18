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

// Acronyms of four or more letters that would otherwise pass for shouting
// words (they have vowels). Vowel-less ones (HSBC, HMRC) are kept anyway.
const ACRONYMS = new Set([
  'NASA', 'NATO', 'IKEA', 'ASAP', 'FIFA', 'UEFA', 'OPEC', 'UNESCO', 'UNICEF', 'HTML', 'JSON', 'HTTP', 'HTTPS',
  'IBAN', 'SWIFT', 'PAYE', 'ISBN', 'ISSN', 'GAAP', 'HIPAA', 'OSHA', 'FEMA', 'NOAA', 'DEFRA', 'OFSTED', 'OFCOM',
  'OFGEM', 'ACAS', 'NAFTA', 'ASEAN', 'EBITDA', 'COVID', 'AIDS', 'SARS', 'INSEAD', 'ESPN', 'AARP', 'CERN', 'NAACP',
]);
// Common three-letter words on documents: tamed like longer words (other
// three-letter capitals are taken for acronyms: VAT, LLC, USA).
const WORDS3 = new Set([
  'TAX', 'DUE', 'PAY', 'NEW', 'OLD', 'FEE', 'NET', 'DAY', 'BOX', 'KEY', 'SUM', 'END', 'OUR', 'ALL', 'NOT',
  'ONE', 'TWO', 'SIX', 'TEN', 'CAR', 'BUS', 'ART', 'LAB', 'JOB', 'MAP', 'LOG', 'BAR', 'TOP',
]);
// Small words that read lower-case inside a title once the words around them are tamed.
const MINOR = new Set([
  'A', 'AN', 'AND', 'AS', 'AT', 'BY', 'FOR', 'FROM', 'IN', 'OF', 'ON', 'OR', 'THE', 'TO', 'WITH',
  'DE', 'DES', 'DU', 'LA', 'LE', 'LES', 'ET', 'DER', 'DIE', 'DAS', 'UND', 'VON', 'DEL', 'EL', 'Y',
]);
const TOKEN = new RegExp(`[${L}][${L}']*`, 'g');
const VOWEL = /[AEIOUYÀ-ÖØ-Ý]/;

const isCaps = (w: string) => w === w.toUpperCase() && w !== w.toLowerCase();

/**
 * Title-cases SHOUTING words, whether the whole line shouts ("ACME LLC
 * STATEMENT") or only some of it ("Northwind INVOICE #4471"). Conservative:
 * only all-capital words of four or more letters (and a few common short ones:
 * TAX, DUE, NEW) change, and not when they are part of a code with digits
 * (AB-2209, Q3, #4471), have no vowel (HSBC, HMRC) or are a known acronym
 * (NASA, IBAN). Other short capitals (VAT, LLC, USA) stay, except small words
 * (of, the, and…) caught between two tamed words.
 */
function tameCaps(line: string): string {
  const tokens: { start: number; end: number; word: string; tamed: boolean }[] = [];
  for (const m of line.matchAll(TOKEN)) {
    const word = m[0], start = m.index ?? 0, end = start + word.length;
    // The whitespace-separated chunk the word sits in: a code if it has a digit.
    const chunkStart = line.lastIndexOf(' ', start) + 1;
    const chunkEnd = line.indexOf(' ', end) < 0 ? line.length : line.indexOf(' ', end);
    const inCode = /\d/.test(line.slice(chunkStart, chunkEnd));
    const letters = word.replace(/'/g, '');
    const tamed = !inCode && isCaps(letters) && VOWEL.test(letters) &&
      (letters.length >= 4 ? !ACRONYMS.has(letters) : WORDS3.has(letters));
    tokens.push({ start, end, word, tamed });
  }
  if (!tokens.some(t => t.tamed)) return line;
  let out = '', at = 0;
  tokens.forEach((t, i) => {
    let w = t.word;
    if (t.tamed) w = w[0] + w.slice(1).toLowerCase();
    else if (i > 0 && MINOR.has(w) && tokens[i - 1].tamed && tokens[i + 1]?.tamed) w = w.toLowerCase();
    out += line.slice(at, t.start) + w;
    at = t.end;
  });
  return out + line.slice(at);
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
