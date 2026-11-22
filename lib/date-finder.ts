// lib/date-finder.ts
// Dates (and their times) written in a page's text, for the "Add to
// calendar" chip where NSDataDetector isn't there: on Android (no system API
// parses a date out of free text) and in builds without the native detector.
// Pure and on the device.
//
// It finds only dates whose DAY is written — "12 March 2026", "March 12",
// "Thursday, 12 March 2026 at 10:30", "le 3 avril 2026 à 14h30", "12. März
// 2026 um 9 Uhr", "12/03/2026", "2026-03-12" — in English, French, German,
// Spanish, Italian, Dutch and Portuguese, with an optional weekday before and
// a time (or time range) after. A bare time or weekday is never a date (the
// same rule lib/text-actions checkDetections applies to NSDataDetector).
// Numeric dates read day first unless the device's locale writes the month
// first (en-US and a few others) or a part over 12 settles it. A date without
// a year is the next one from a month ago (a letter's "12 March" is usually
// upcoming).
import type { DetectedData } from '../modules/vision-ocr/src';

const MONTH_NAMES: Record<number, string[]> = {
  0: ['january', 'jan', 'janvier', 'janv', 'januar', 'jänner', 'jän', 'enero', 'ene', 'gennaio', 'gen', 'januari', 'janeiro'],
  1: ['february', 'feb', 'février', 'fevrier', 'févr', 'fevr', 'févr', 'februar', 'febrero', 'febbraio', 'februari', 'fevereiro', 'fev'],
  2: ['march', 'mar', 'mars', 'märz', 'marz', 'mär', 'marzo', 'maart', 'março', 'marco'],
  3: ['april', 'apr', 'avril', 'avr', 'abril', 'abr', 'aprile'],
  4: ['may', 'mai', 'mayo', 'maggio', 'mag', 'mei', 'maio'],
  5: ['june', 'jun', 'juin', 'juni', 'junio', 'giugno', 'giu', 'junho'],
  6: ['july', 'jul', 'juillet', 'juil', 'juli', 'julio', 'luglio', 'lug', 'julho'],
  7: ['august', 'aug', 'août', 'aout', 'agosto', 'ago', 'augustus'],
  8: ['september', 'sep', 'sept', 'septembre', 'septiembre', 'setiembre', 'settembre', 'set', 'setembro'],
  9: ['october', 'oct', 'octobre', 'oktober', 'okt', 'octubre', 'ottobre', 'ott', 'outubro', 'out'],
  10: ['november', 'nov', 'novembre', 'noviembre', 'novembro'],
  11: ['december', 'dec', 'décembre', 'decembre', 'déc', 'dezember', 'dez', 'diciembre', 'dic', 'dicembre', 'dezembro'],
};
const MONTH_OF = new Map<string, number>();
for (const [m, names] of Object.entries(MONTH_NAMES)) for (const n of names) MONTH_OF.set(n, Number(m));

const WEEKDAYS = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
  'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche',
  'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag', 'sonnabend', 'sonntag',
  'lunes', 'martes', 'miércoles', 'miercoles', 'jueves', 'viernes', 'sábado', 'sabado', 'domingo',
  'lunedì', 'lunedi', 'martedì', 'martedi', 'mercoledì', 'mercoledi', 'giovedì', 'giovedi', 'venerdì', 'venerdi', 'sabato', 'domenica',
  'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag',
  'segunda-feira', 'terça-feira', 'terca-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira',
];

const alt = (words: string[]) => [...words].sort((a, b) => b.length - a.length).map(w => w.replace(/\./g, '\\.')).join('|');
const MONTH = `(${alt([...MONTH_OF.keys()])})\\.?`;
const WEEKDAY = `(?:${alt(WEEKDAYS)})\\.?,?\\s+`;
// Letters on either side mean it's part of a word ("Mars" in "Marseille" isn't).
const L = '\\p{L}';
const ORD = '(?:st|nd|rd|th|er|re|e|º|ª|\\.)?';
const LEAD = `(?:(?:le|the|den|der|am|el|il|op|on)\\s+)?`;

const DAY_MONTH = new RegExp(`(?<![${L}\\d])(?:${WEEKDAY})?${LEAD}(\\d{1,2})${ORD}\\s*(?:of\\s+|de\\s+|di\\s+)?${MONTH}(?!${L})(?:,?\\s+(?:de\\s+)?(\\d{4}))?(?!\\d)`, 'giu');
const MONTH_DAY = new RegExp(`(?<![${L}\\d])(?:${WEEKDAY})?${MONTH}(?!${L})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s+(\\d{4}))?(?!\\d)`, 'giu');
const ISO = /(?<![\d.\/-])(\d{4})-(\d{2})-(\d{2})(?![.\/-]?\d)/g;
const NUMERIC = /(?<![\d.\/-])(\d{1,2})([.\/-])(\d{1,2})\2(\d{4}|\d{2})(?![.\/-]?\d)/g;
const NUMERIC_WEEKDAY = new RegExp(`${WEEKDAY}$`, 'iu');

// A time after the date: "10:30", "10:30 AM", "3 pm", "14h30", "14 h", "9 Uhr", "noon".
const TIME = String.raw`(\d{1,2})(?:[:h.](\d{2}))?\s*(a\.\s?m\.|p\.\s?m\.|[ap]\s?m(?!\p{L})|h(?!\p{L})|uhr)?`;
const TIME_AFTER = new RegExp(String.raw`^(?:,?\s*(?:at|à|a las|alle|um|om|às|from|de|dès|von|vanaf|-|–)?\s*)` + TIME, 'iu');
// …and the end of a range after it: "10:00–11:30", "9 am to 5 pm", "14h à 16h".
const UNTIL = new RegExp(String.raw`^\s*(?:-|–|to|à|a|bis|until|tot|al)\s*` + TIME, 'iu');
const NOON = /^(?:,?\s*(?:at|à|a|um)?\s*)(noon|midday|midi|mittag)\b/iu;

type Time = { h: number; m: number };

function parseTime(hh?: string, mm?: string, suffix?: string): Time | null {
  if (hh === undefined) return null;
  let h = Number(hh);
  const m = mm === undefined ? 0 : Number(mm);
  const s = (suffix ?? '').toLowerCase().replace(/[\s.]/g, '');
  // A time needs minutes or a marker: "12 March 2026 3" is no time.
  if (mm === undefined && !s) return null;
  if (m > 59) return null;
  if (s === 'am' || s === 'pm') {
    if (h < 1 || h > 12) return null;
    if (s === 'pm' && h !== 12) h += 12;
    if (s === 'am' && h === 12) h = 0;
  }
  if (h > 23) return null;
  return { h, m };
}

/** Whether the device's locale writes numeric dates month first (en-US, en-PH, …). */
export function localeMonthFirst(): boolean {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale ?? '';
    const parts = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'numeric', year: 'numeric' }).formatToParts(new Date(2026, 2, 12));
    const order = parts.filter(p => p.type === 'day' || p.type === 'month').map(p => p.type);
    return order[0] === 'month';
  } catch {
    return false;
  }
}

export type DateFinderOptions = { now?: Date; monthFirst?: boolean };

type Hit = { start: number; end: number; y: number | null; mo: number; d: number };

function fullYear(y: string): number {
  const n = Number(y);
  if (y.length === 4) return n;
  return n < 70 ? 2000 + n : 1900 + n;
}

function validDay(y: number, mo: number, d: number): boolean {
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return false;
  const yy = y || 2024; // leap year when unknown (29 February)
  return new Date(yy, mo + 1, 0).getDate() >= d;
}

/** Dates in `text` as DetectedData (type 'date'), in reading order, without overlaps. */
export function findDates(text: string, opts: DateFinderOptions = {}): DetectedData[] {
  if (!text || !/\d/.test(text)) return [];
  const now = opts.now ?? new Date();
  const monthFirst = opts.monthFirst ?? localeMonthFirst();
  const hits: Hit[] = [];
  const push = (start: number, end: number, y: number | null, mo: number, d: number) => {
    if (y !== null && (y < 1900 || y > 2100)) return;
    if (validDay(y ?? 0, mo, d)) hits.push({ start, end, y, mo, d });
  };
  for (const m of text.matchAll(DAY_MONTH)) {
    const mo = MONTH_OF.get(m[2].toLowerCase());
    if (mo !== undefined) push(m.index, m.index + m[0].length, m[3] ? Number(m[3]) : null, mo, Number(m[1]));
  }
  for (const m of text.matchAll(MONTH_DAY)) {
    const mo = MONTH_OF.get(m[1].toLowerCase());
    if (mo !== undefined) push(m.index, m.index + m[0].length, m[3] ? Number(m[3]) : null, mo, Number(m[2]));
  }
  for (const m of text.matchAll(ISO)) push(m.index, m.index + m[0].length, Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  for (const m of text.matchAll(NUMERIC)) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    const y = fullYear(m[4]);
    const dayFirst = a > 12 ? true : b > 12 ? false : !monthFirst;
    let start = m.index;
    const weekday = NUMERIC_WEEKDAY.exec(text.slice(Math.max(0, start - 20), start));
    if (weekday) start -= weekday[0].length;
    push(start, m.index + m[0].length, y, (dayFirst ? b : a) - 1, dayFirst ? a : b);
  }

  // The longest wins where two overlap.
  hits.sort((p, q) => q.end - q.start - (p.end - p.start) || p.start - q.start);
  const kept: Hit[] = [];
  for (const h of hits) if (!kept.some(k => h.start < k.end && h.end > k.start)) kept.push(h);
  kept.sort((p, q) => p.start - q.start);

  const out: DetectedData[] = [];
  for (const h of kept) {
    let end = h.end;
    let time: Time | null = null;
    let until: Time | null = null;
    const rest = text.slice(end, end + 40);
    const t = TIME_AFTER.exec(rest);
    if (t) time = parseTime(t[1], t[2], t[3]);
    if (t && time) {
      end += t[0].length;
      const u = UNTIL.exec(text.slice(end, end + 24));
      // "9 am to 5 pm"; "9 to 5 pm" takes the end's am/pm; "10:00 - 3" is no range.
      until = u ? parseTime(u[1], u[2], u[3] ?? t[3]) : null;
      if (u && until) end += u[0].length;
    } else {
      const n = NOON.exec(rest);
      if (n) {
        time = { h: 12, m: 0 };
        end += n[0].length;
      }
    }
    // Drop trailing spaces or punctuation the time pattern took.
    while (end > h.end && /[\s,–-]/.test(text[end - 1])) end--;

    let year = h.y;
    if (year === null) {
      year = now.getFullYear();
      const monthAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30).getTime();
      if (new Date(year, h.mo, h.d).getTime() < monthAgo) year += 1;
      if (!validDay(year, h.mo, h.d)) continue;
    }
    const at = new Date(year, h.mo, h.d, time?.h ?? 12, time?.m ?? 0, 0, 0);
    let duration = 0;
    if (time && until) {
      const stop = new Date(year, h.mo, h.d, until.h, until.m, 0, 0).getTime();
      if (stop > at.getTime()) duration = (stop - at.getTime()) / 1000;
    }
    const words = text.slice(h.start, end);
    out.push({
      type: 'date',
      text: words,
      range: [h.start, end - h.start],
      value: words,
      date: at.getTime(),
      duration,
      hasTime: time !== null,
    });
  }
  return out;
}

const DATE_SHAPED = /^\s*(?:\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./](?:\d{4}|\d{2}))\s*$/;

/**
 * `found` (from a detector that reports no dates) with the dates in `text`
 * added. Where a date and a phone number overlap, a phone that is really a
 * date ("12.03.2026") gives way; otherwise the date that overlaps anything
 * found is dropped.
 */
export function withDates(found: DetectedData[], text: string, opts: DateFinderOptions = {}): DetectedData[] {
  const dates = findDates(text, opts);
  if (!dates.length) return found;
  const overlaps = (a: DetectedData, b: DetectedData) => a.range[0] < b.range[0] + b.range[1] && a.range[0] + a.range[1] > b.range[0];
  const kept = found.filter(f => !(f.type === 'phone' && DATE_SHAPED.test(f.text) && dates.some(d => overlaps(d, f))));
  const added = dates.filter(d => !kept.some(f => overlaps(d, f)));
  return [...kept, ...added].sort((a, b) => a.range[0] - b.range[0]);
}
