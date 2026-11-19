// lib/timestamp-style.ts
// What the Timestamp tool (app/tools/timestamp.tsx) prints and how it looks,
// and its remembered choices.
//
// TEXT. Date and time, the date only, or the time only; the date in the
// device's own style (what the tool always printed: "Nov 18, 2026" in the US,
// "18 Nov 2026" in the UK) or a fixed order — 18/11/2026, 11/18/2026,
// 2026-11-18 (ISO 8601) or written out; the time in the device's clock or a
// fixed 12- or 24-hour one. An optional word in front: Received, Approved,
// Paid, or the user's own. The default (device date and time, no word) is
// exactly lib/format.ts formatDateTime, as before.
//
// LOOK. Mapped to the spec lib/stamp.ts draws (TimestampLookSpec): the
// colours come from the shared palette (lib/stamp-colors.ts), strengths are
// percents. Defaults reproduce the original stamp exactly.
//
// PREFS. One additive key of its own. Reading is forgiving like
// lib/watermark-prefs.ts: field by field, unknown or broken values fall back
// to the default, numbers are clamped, nothing throws.
import { formatDate, formatDateTime, formatTime } from './format';
import {
  clampPercent,
  clampTimestampSize,
  TIMESTAMP_HIGHLIGHT_OPACITY,
  type TimestampLookSpec,
} from './stamp';
import {
  TOOL_INKS,
  highlightHex,
  inkHex,
  normalizeHex,
  parseHighlightChoice,
  parseInkChoice,
  type HighlightChoice,
  type InkChoice,
} from './stamp-colors';

// ── Text ────────────────────────────────────────────────────────────────────

export type TimestampContent = 'datetime' | 'date' | 'time';
export type DateStyle = 'device' | 'dmy' | 'mdy' | 'iso' | 'long';
export type ClockStyle = 'device' | '12h' | '24h';
export type StampWord = 'none' | 'received' | 'approved' | 'paid' | 'custom';

export const DATE_STYLES: readonly DateStyle[] = ['device', 'dmy', 'mdy', 'iso', 'long'];
export const CLOCK_STYLES: readonly ClockStyle[] = ['device', '12h', '24h'];
export const CONTENTS: readonly TimestampContent[] = ['datetime', 'date', 'time'];
export const STAMP_WORDS: readonly StampWord[] = ['none', 'received', 'approved', 'paid', 'custom'];

export const WORD_TEXT: Record<Exclude<StampWord, 'none' | 'custom'>, string> = {
  received: 'Received',
  approved: 'Approved',
  paid: 'Paid',
};

/** Longest custom word, in characters: a stamp line, not a sentence. */
export const STAMP_WORD_MAX = 24;

export type TimestampText = {
  content: TimestampContent;
  dateStyle: DateStyle;
  clock: ClockStyle;
  word: StampWord;
  /** The user's own word (word 'custom'). */
  customWord: string;
};

const pad2 = (n: number) => String(n).padStart(2, '0');

/** The date part alone, in `style`. */
export function formatStampDate(ts: number, style: DateStyle, locale?: string): string {
  const d = new Date(ts);
  const dd = pad2(d.getDate());
  const mm = pad2(d.getMonth() + 1);
  const yyyy = String(d.getFullYear());
  switch (style) {
    case 'dmy':
      return `${dd}/${mm}/${yyyy}`;
    case 'mdy':
      return `${mm}/${dd}/${yyyy}`;
    case 'iso':
      return `${yyyy}-${mm}-${dd}`;
    case 'long':
      return d.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
    default:
      return formatDate(ts, locale);
  }
}

/** The time part alone, on `clock`. 12-hour reads "2:05 PM", 24-hour "14:05". */
export function formatStampTime(ts: number, clock: ClockStyle, locale?: string): string {
  const d = new Date(ts);
  const h = d.getHours();
  const m = pad2(d.getMinutes());
  if (clock === '24h') return `${pad2(h)}:${m}`;
  if (clock === '12h') return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
  return formatTime(ts, locale);
}

/** The word in front, trimmed ("" for none, or an empty custom one). */
export function stampWord(t: Pick<TimestampText, 'word' | 'customWord'>): string {
  if (t.word === 'none') return '';
  if (t.word === 'custom') return t.customWord.replace(/\s+/g, ' ').trim().slice(0, STAMP_WORD_MAX);
  return WORD_TEXT[t.word];
}

/**
 * The stamp's text. Device date and time with no word is formatDateTime,
 * character for character — the text the tool always printed.
 */
export function formatTimestampText(ts: number, t: TimestampText, locale?: string): string {
  let body: string;
  if (t.content === 'time') body = formatStampTime(ts, t.clock, locale);
  else if (t.content === 'date') body = formatStampDate(ts, t.dateStyle, locale);
  else if (t.dateStyle === 'device' && t.clock === 'device') body = formatDateTime(ts, locale);
  else {
    // Numeric dates read as one token with the time ("2026-11-18 14:05");
    // worded ones take a comma, as the device style does.
    const sep = t.dateStyle === 'device' || t.dateStyle === 'long' ? ', ' : ' ';
    body = `${formatStampDate(ts, t.dateStyle, locale)}${sep}${formatStampTime(ts, t.clock, locale)}`;
  }
  const word = stampWord(t);
  return word ? `${word} ${body}` : body;
}

// ── Look ────────────────────────────────────────────────────────────────────

export type TimestampLook = {
  /** Points on an A4-wide page; null: the original size (automatic). */
  sizePt: number | null;
  color: InkChoice;
  customColor: string | null;
  bold: boolean;
  /** Text opacity, percent. */
  strength: number;
  highlight: HighlightChoice;
  customHighlight: string | null;
  /** Highlight opacity, percent. */
  highlightStrength: number;
  border: boolean;
};

/** The look as lib/stamp.ts draws it. Defaults give exactly the original stamp. */
export function timestampLookSpec(look: TimestampLook): TimestampLookSpec {
  return {
    sizePt: look.sizePt,
    color: inkHex(look.color, look.customColor, TOOL_INKS.timestamp, 'black'),
    opacity: clampPercent(look.strength) / 100,
    bold: look.bold,
    highlight: highlightHex(look.highlight, look.customHighlight),
    highlightOpacity: clampPercent(look.highlightStrength) / 100,
    border: look.border,
  };
}

// ── Remembered choices ──────────────────────────────────────────────────────

export type TimestampWhen = 'scanned' | 'now';

export type TimestampPrefs = TimestampText &
  TimestampLook & {
    when: TimestampWhen;
    /** Where it sits between the page's inset edges (lib/placement.ts Anchor). */
    anchor: { x: number; y: number };
  };

export const DEFAULT_TIMESTAMP_PREFS: TimestampPrefs = {
  when: 'scanned',
  content: 'datetime',
  dateStyle: 'device',
  clock: 'device',
  word: 'none',
  customWord: '',
  sizePt: null,
  color: 'black',
  customColor: null,
  bold: false,
  strength: 100,
  highlight: 'white',
  customHighlight: null,
  highlightStrength: Math.round(TIMESTAMP_HIGHLIGHT_OPACITY * 100),
  border: false,
  anchor: { x: 1, y: 1 },
};

/** True when nothing under "More options" differs from the default (it then starts closed). */
export function timestampAdvancedIsDefault(p: TimestampPrefs): boolean {
  const d = DEFAULT_TIMESTAMP_PREFS;
  return (
    p.dateStyle === d.dateStyle &&
    p.clock === d.clock &&
    p.bold === d.bold &&
    p.strength === d.strength &&
    p.highlight === d.highlight &&
    p.highlightStrength === d.highlightStrength &&
    p.border === d.border
  );
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const unit = (v: unknown, d: number) => (num(v) ? Math.min(1, Math.max(0, v)) : d);

/** Stored JSON (or null) to prefs; never throws. */
export function parseTimestampPrefs(raw: string | null | undefined): TimestampPrefs {
  let v: unknown = null;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    v = null;
  }
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const d = DEFAULT_TIMESTAMP_PREFS;
  const a = o.anchor && typeof o.anchor === 'object' ? (o.anchor as Record<string, unknown>) : {};
  return {
    when: oneOf(o.when, ['scanned', 'now'] as const, d.when),
    content: oneOf(o.content, CONTENTS, d.content),
    dateStyle: oneOf(o.dateStyle, DATE_STYLES, d.dateStyle),
    clock: oneOf(o.clock, CLOCK_STYLES, d.clock),
    word: oneOf(o.word, STAMP_WORDS, d.word),
    customWord: typeof o.customWord === 'string' ? o.customWord.slice(0, STAMP_WORD_MAX) : d.customWord,
    sizePt: num(o.sizePt) ? clampTimestampSize(o.sizePt) : null,
    color: parseInkChoice(o.color, d.color),
    customColor: normalizeHex(o.customColor),
    bold: typeof o.bold === 'boolean' ? o.bold : d.bold,
    strength: num(o.strength) ? clampPercent(o.strength) : d.strength,
    highlight: parseHighlightChoice(o.highlight, d.highlight),
    customHighlight: normalizeHex(o.customHighlight),
    highlightStrength: num(o.highlightStrength) ? clampPercent(o.highlightStrength) : d.highlightStrength,
    border: typeof o.border === 'boolean' ? o.border : d.border,
    anchor: { x: unit(a.x, d.anchor.x), y: unit(a.y, d.anchor.y) },
  };
}

const KEY = '@scan_kit_timestamp';

type Store = { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void> };

/** AsyncStorage, loaded on first use (as in lib/watermark-prefs.ts): a missing module just forgets. */
function store(): Store | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@react-native-async-storage/async-storage');
    return (mod.default ?? mod) as Store;
  } catch {
    return null;
  }
}

/** The remembered choices, or the defaults. Never throws. */
export async function loadTimestampPrefs(): Promise<TimestampPrefs> {
  try {
    return parseTimestampPrefs(await store()?.getItem(KEY));
  } catch {
    return parseTimestampPrefs(null);
  }
}

/** Remembers the choices. Best effort. */
export async function saveTimestampPrefs(prefs: TimestampPrefs): Promise<void> {
  try {
    await store()?.setItem(KEY, JSON.stringify(parseTimestampPrefs(JSON.stringify(prefs))));
  } catch {}
}
