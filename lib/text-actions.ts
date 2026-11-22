// lib/text-actions.ts
// Acting on recognized text, all on device: phone numbers, emails, links,
// addresses and dates found in a page's text (NSDataDetector, with a JS
// fallback for builds without it), QR codes and barcodes on a page (Vision),
// and the system forms that act on them (New Event, New Contact).
//
// App Lock: the system forms are presented by the native module over
// whatever is on screen. Like lib/share.ts, every presenter here waits until
// the app is unlocked (nav-guard whenUnlocked) right before presenting, and is
// tracked as system UI (lib/system-ui withSystemUI) so a lock while it is open
// covers it instead of closing it. The native side always settles (a form that
// goes away without an answer resolves 'cancelled'), so nothing stays tracked.
import { Linking, Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import {
  VisionOcr,
  type ContactFields,
  type DetectedBarcode,
  type DetectedData,
  type DetectedDataType,
  type PresentOutcome,
} from '../modules/vision-ocr/src';
import { withDates } from './date-finder';
import { whenUnlocked } from './nav-guard';
import { sentenceAt } from './sentences';
import { withSystemUI } from './system-ui';

export type { ContactFields, DetectedBarcode, DetectedData, DetectedDataType, PresentOutcome };

// ---------------------------------------------------------------------------
// Detected data
// ---------------------------------------------------------------------------

/** At most this many chips: a dense page (a price list) shouldn't become a wall of them. */
export const MAX_DETECTIONS = 24;

/**
 * Phone numbers, emails, links, addresses and dates in `text`, in reading
 * order, without duplicates. Never rejects: an empty list when nothing is
 * found or detection fails.
 */
export async function detectData(text: string): Promise<DetectedData[]> {
  if (!text.trim()) return [];
  let found: DetectedData[];
  const native = VisionOcr?.detectData;
  // NSDataDetector (iOS) finds dates itself; Android's detector (Linkify and
  // the system text classifier) and the JS fallback don't: lib/date-finder.
  let nativeDates = false;
  try {
    found = typeof native === 'function' ? await native(text) : detectDataFallback(text);
    nativeDates = typeof native === 'function' && Platform.OS === 'ios';
  } catch {
    found = detectDataFallback(text);
  }
  if (!nativeDates) found = withDates(found, text);
  return tidyDetections(checkDetections(withSpacedEmails(found, text), text));
}

// "sarah @acme.com", "sarah@ acme.com": text recognition (ML Kit especially)
// often puts a space beside the @ of a small-print address. Detectors then see
// no email, only a link to the domain.
const SPACED_EMAIL = /(?<![\w.%+-])([A-Z0-9._%+-]+) ?@ ?([A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,})(?![\w-])/gi;

/**
 * Adds the email addresses written with a space beside the @ (the value
 * without it), replacing whatever was found inside them (the domain as a
 * link). Addresses written normally are left to the detector.
 */
export function withSpacedEmails(found: DetectedData[], text: string): DetectedData[] {
  const extra: DetectedData[] = [];
  for (const m of text.matchAll(SPACED_EMAIL)) {
    if (!/ @|@ /.test(m[0])) continue;
    extra.push({ type: 'email', text: m[0], range: [m.index, m[0].length], value: `${m[1]}@${m[2]}` });
  }
  if (!extra.length) return found;
  const inside = (d: DetectedData) => extra.some(e => d.range[0] < e.range[0] + e.range[1] && d.range[0] + d.range[1] > e.range[0]);
  return [...found.filter(d => !inside(d)), ...extra].sort((a, b) => a.range[0] - b.range[0]);
}

/** Words that make NSDataDetector report a span from NOW to the date ("before 30 November"). */
const RANGE_LEAD = /^\s*(?:before|until|till|til|by|no later than|up to|through|avant|jusqu['’]au|bis|vor|hasta|antes del?|entro|prima del?|tot|voor)\b[\s,]*/i;

/**
 * Keeps only what is really in `text`. A detection's range must point at its
 * own words (a stale range is moved to where the words are, or dropped). A
 * date must be one the text actually names: NSDataDetector reads "before 30
 * November 2026" as a span starting TODAY, and a bare time or weekday as a day
 * near today — a chip for today's date on a letter that never mentions it
 * would add a wrong event to the calendar. So a date is kept only when the
 * day of the month it gives is written in its words; for a span that ends on
 * the named day ("before…", "until…") the end is used.
 */
export function checkDetections(found: DetectedData[], text: string): DetectedData[] {
  const out: DetectedData[] = [];
  for (const d of found) {
    if (!d || typeof d.text !== 'string' || !d.text) continue;
    let range = d.range;
    const valid =
      Array.isArray(range) &&
      range[0] >= 0 &&
      range[0] + range[1] <= text.length &&
      text.slice(range[0], range[0] + range[1]) === d.text;
    if (!valid) {
      const at = text.indexOf(d.text);
      if (at < 0) continue;
      range = [at, d.text.length];
    }
    const placed = range === d.range ? d : { ...d, range };
    if (placed.type !== 'date') {
      out.push(placed);
      continue;
    }
    const date = checkedDate(placed);
    if (date) out.push(date);
  }
  return out;
}

/** Day-of-month numbers written in `words` ("30", "30th", "1er", "03" in 12/03/2026). */
function writtenDays(words: string): Set<number> {
  const days = new Set<number>();
  for (const m of words.matchAll(/(?<!\d)(\d{1,2})(?:st|nd|rd|th|er|e|\.)?(?!\d)/gi)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 31) days.add(n);
  }
  return days;
}

/** The date if its words name its day; the end of a span when the words name that instead; else null. */
function checkedDate(d: DetectedData): DetectedData | null {
  if (typeof d.date !== 'number' || !Number.isFinite(d.date)) return null;
  const days = writtenDays(d.text);
  const names = (ms: number) => days.has(new Date(ms).getDate());
  const span = (d.duration ?? 0) > 0 ? d.date + (d.duration as number) * 1000 : null;
  const endFirst = RANGE_LEAD.test(d.text);
  if (span !== null && endFirst && names(span)) return { ...d, date: span, duration: 0 };
  if (names(d.date)) return d;
  if (span !== null && names(span)) return { ...d, date: span, duration: 0 };
  return null;
}

/** Drops duplicates (same kind and value) and caps the list, keeping reading order. */
export function tidyDetections(found: DetectedData[]): DetectedData[] {
  const seen = new Set<string>();
  const out: DetectedData[] = [];
  const sorted = [...found].sort((a, b) => a.range[0] - b.range[0]);
  for (const d of sorted) {
    if (!d || !d.type || !d.value) continue;
    const key = `${d.type}:${normalizeValue(d)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
    if (out.length >= MAX_DETECTIONS) break;
  }
  return out;
}

function normalizeValue(d: DetectedData): string {
  switch (d.type) {
    case 'phone':
      return d.value.replace(/[^\d+]/g, '');
    case 'email':
      return d.value.toLowerCase();
    case 'url':
      return d.value.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
    case 'date':
      return String(d.date ?? d.value);
    default:
      return d.value.toLowerCase().replace(/\s+/g, ' ').trim();
  }
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|co|fr|de|uk|ca|dev|app|info|biz|eu|us|me)\b(?:\/[^\s<>"']*)?/gi;
// "+1 (415) 555-0132", "020 7946 0958", "06 12 34 56 78": 7-15 digits with
// common separators, not part of a longer run of digits or letters.
const PHONE_RE = /(?<![\w+])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{1,4}(?:[\s.-]?\d{2,4}){2,4}(?![\w])/g;

/**
 * Plain-JS detection for builds without the native detector (older dev
 * clients): emails, links and phone numbers (dates are added by
 * lib/date-finder, as on Android). Addresses need a real grammar and are
 * left out rather than guessed.
 */
export function detectDataFallback(text: string): DetectedData[] {
  const out: DetectedData[] = [];
  const taken: [number, number][] = [];
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);
  const add = (type: DetectedDataType, m: RegExpExecArray, value: string) => {
    const start = m.index;
    const end = start + m[0].length;
    if (overlaps(start, end)) return;
    taken.push([start, end]);
    out.push({ type, text: m[0], range: [start, m[0].length], value });
  };
  for (const m of text.matchAll(EMAIL_RE)) add('email', m as RegExpExecArray, m[0]);
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;:!?)]+$/, '');
    const mm = Object.assign([raw], { index: m.index, input: text }) as unknown as RegExpExecArray;
    add('url', mm, /^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
  }
  for (const m of text.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) continue;
    // A date (2026-03-12) or a plain number with dots (1.234.567) isn't a phone number.
    if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(m[0].trim())) continue;
    add('phone', m as RegExpExecArray, m[0].trim());
  }
  return out.sort((a, b) => a.range[0] - b.range[0]);
}

/** Short label for a chip: the value as written, trimmed to fit. */
export function detectionLabel(d: DetectedData, max = 32): string {
  let s: string;
  switch (d.type) {
    case 'url':
      s = d.text.replace(/^https?:\/\//i, '').replace(/\/$/, '');
      break;
    case 'email':
      s = d.value;
      break;
    case 'date':
      // The date as written on the page ("30 November 2026"), without a
      // leading "before" / "until".
      s = d.text.replace(RANGE_LEAD, '') || d.text;
      break;
    default:
      s = d.text;
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** "Thu, Mar 12, 2026" or "Thu, Mar 12, 10:30 AM" in the user's locale. */
export function formatDetectedDate(ms: number, withTime: boolean, locale?: string): string {
  const date = new Date(ms);
  try {
    return withTime
      ? date.toLocaleString(locale, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : date.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return date.toDateString();
  }
}

// ---------------------------------------------------------------------------
// Calendar events from dates
// ---------------------------------------------------------------------------

export type EventDraft = { title: string; start: number; end: number; allDay: boolean; notes: string };

/** Words left dangling once the date is cut out of a sentence ("appointment on"). */
const DANGLING = /(?:^|\s)(on|at|for|from|by|until|till|before|after|dated?|due|le|du|au|à|am|um|el|il|op|del|des|de)$/i;

/**
 * The New Event a date chip proposes: on that day (all day unless the text
 * names a time, then one hour or the detected duration), titled with the
 * sentence the date sits in, the date itself cut out ("This letter confirms
 * your next check-up appointment" from "…appointment on Thursday, March 12,
 * 2026 at 10:30 AM."), and that sentence in the notes.
 */
export function eventFromDate(d: DetectedData, sourceText: string): EventDraft | null {
  if (d.type !== 'date' || typeof d.date !== 'number' || !Number.isFinite(d.date)) return null;
  const [start, len] = d.range;
  const [s, e] = sentenceAt(sourceText, start);
  const sentence = sourceText.slice(Math.min(s, start), Math.max(e, start + len));
  const from = start - Math.min(s, start);
  let rest = `${sentence.slice(0, from)} ${sentence.slice(from + len)}`.replace(/\s+/g, ' ');
  // Trim punctuation and the little words the date leaves hanging, from both ends.
  for (let i = 0; i < 4; i++) {
    const before = rest;
    rest = rest
      .replace(/^[\s,;:.–—\-|·•]+|[\s,;:.!?–—\-|·•]+$/g, '')
      .replace(DANGLING, '')
      .trim();
    if (rest === before) break;
  }
  let title = 'Event';
  if (rest.length >= 3 && /\p{L}{2}/u.test(rest)) {
    title = rest.length > 64 ? `${rest.slice(0, 64).replace(/\s+\S*$/, '')}…` : rest;
    title = title.charAt(0).toUpperCase() + title.slice(1);
  }
  const allDay = !d.hasTime;
  let begin = d.date;
  if (allDay) {
    const day = new Date(d.date);
    day.setHours(0, 0, 0, 0);
    begin = day.getTime();
  }
  const duration = (d.duration ?? 0) > 0 ? (d.duration as number) * 1000 : allDay ? 0 : 60 * 60 * 1000;
  return { title, start: begin, end: begin + duration, allDay, notes: sentence.replace(/\s+/g, ' ').trim() };
}

// ---------------------------------------------------------------------------
// Opening things
// ---------------------------------------------------------------------------

/** "tel:" URL for a detected number (digits and a leading +; extensions dropped). */
export function telUrl(number: string): string {
  const main = number.split(/\s*(?:ext\.?|x|poste)\s*\d+$/i)[0];
  return `tel:${main.replace(/[^\d+]/g, '')}`;
}

/** Apple Maps search for an address (opens the Maps app; nothing is sent from Scan Kit). */
export function mapsUrl(address: string): string {
  const q = encodeURIComponent(address.replace(/\s+/g, ' ').trim());
  return Platform.OS === 'ios' ? `maps://?q=${q}` : `geo:0,0?q=${q}`;
}

/** Only web links open in the in-app browser; anything else isn't opened from a page. */
export function webUrl(raw: string): string | null {
  const s = raw.trim();
  if (/^https?:\/\/\S+$/i.test(s)) return s;
  if (/^www\.\S+$/i.test(s)) return `https://${s}`;
  return null;
}

/** False when no app can open `url`. */
export async function openExternal(url: string): Promise<boolean> {
  await whenUnlocked();
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}

/** Opens a web link in the in-app browser (Safari view). False when it can't. */
export async function openWebLink(raw: string): Promise<boolean> {
  const url = webUrl(raw);
  if (!url) return false;
  await whenUnlocked();
  try {
    await WebBrowser.openBrowserAsync(url, {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      dismissButtonStyle: 'close',
    });
    return true;
  } catch {
    return openExternal(url);
  }
}

// ---------------------------------------------------------------------------
// System forms (App Lock aware — see the header)
// ---------------------------------------------------------------------------

export function canAddToCalendar(): boolean {
  return typeof VisionOcr?.presentEventEditor === 'function';
}

/** Shows the system New Event editor for a date found in `sourceText`. */
export async function addDateToCalendar(d: DetectedData, sourceText: string): Promise<PresentOutcome> {
  const present = VisionOcr?.presentEventEditor;
  const draft = eventFromDate(d, sourceText);
  if (typeof present !== 'function' || !draft) return 'unavailable';
  await whenUnlocked();
  return withSystemUI(
    () => present(draft.title, draft.start, draft.end, draft.allDay, draft.notes, null),
    (): PresentOutcome => 'cancelled',
  );
}

export function canAddContact(): boolean {
  return typeof VisionOcr?.presentNewContact === 'function';
}

/** Shows the system New Contact form, prefilled. */
export async function presentNewContact(fields: ContactFields): Promise<PresentOutcome> {
  const present = VisionOcr?.presentNewContact;
  if (typeof present !== 'function') return 'unavailable';
  await whenUnlocked();
  return withSystemUI(() => present(fields), (): PresentOutcome => 'cancelled');
}

export function canWriteVCard(): boolean {
  return typeof VisionOcr?.writeVCard === 'function';
}

// ---------------------------------------------------------------------------
// Barcodes
// ---------------------------------------------------------------------------

export function canDetectBarcodes(): boolean {
  return typeof VisionOcr?.detectBarcodes === 'function';
}

/** Codes in an image (top to bottom). Rejects when the image can't be read. */
export async function detectBarcodes(uri: string): Promise<DetectedBarcode[]> {
  const fn = VisionOcr?.detectBarcodes;
  if (typeof fn !== 'function') return [];
  return fn(uri.split('?')[0]);
}

/** "QR code", "EAN-13"… for a symbology name (expo-camera or Vision). */
export function barcodeTypeLabel(type: string): string {
  const map: Record<string, string> = {
    qr: 'QR code',
    ean13: 'EAN-13',
    ean8: 'EAN-8',
    code128: 'Code 128',
    code39: 'Code 39',
    code93: 'Code 93',
    datamatrix: 'Data Matrix',
    pdf417: 'PDF417',
    aztec: 'Aztec code',
    upc_a: 'UPC-A',
    upc_e: 'UPC-E',
    itf14: 'ITF-14',
    itf: 'ITF',
    codabar: 'Codabar',
  };
  return map[type] ?? 'Barcode';
}
