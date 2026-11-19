// lib/tool-prefs.ts
// Remembered tool options (round 16): Compress, Split, Long image, Erase
// marks, Extract text, Book mode, ID card, Whiteboard. Each tool has a key of its own
// holding one JSON value, read through the tool's pure `parse` function, which
// validates every field and falls back to the default — the tool exactly as it
// was before it had options — for anything missing, unknown or damaged. Only
// new keys: no document record or earlier setting is touched.

type Store = { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void> };

/** AsyncStorage, loaded on first use; a missing module only forgets choices (tests, odd builds). */
function store(): Store | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@react-native-async-storage/async-storage');
    return (mod.default ?? mod) as Store;
  } catch {
    return null;
  }
}

export const TOOL_PREF_KEYS = {
  compress: '@scan_kit_tool_compress',
  split: '@scan_kit_tool_split',
  longImage: '@scan_kit_tool_long_image',
  eraseMarks: '@scan_kit_tool_erase_marks',
  extractText: '@scan_kit_tool_extract_text',
  book: '@scan_kit_tool_book',
  idCard: '@scan_kit_tool_id_card',
  whiteboard: '@scan_kit_tool_whiteboard',
} as const;

/** The stored object, or {} for anything that isn't one. Pure. */
export function jsonObject(raw: string | null | undefined): Record<string, unknown> {
  try {
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** `v` when it is one of `list`, otherwise `fallback`. Pure. */
export function oneOf<T>(list: readonly T[], v: unknown, fallback: T): T {
  return list.includes(v as T) ? (v as T) : fallback;
}

/** A finite number within min…max (rounded to `step`), otherwise `fallback`. Pure. */
export function numberIn(v: unknown, min: number, max: number, fallback: number, step = 1): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v / step) * step));
}

/** A tool's remembered options, parsed (the defaults on any failure). Never throws. */
export async function readToolPrefs<T>(key: string, parse: (o: Record<string, unknown>) => T): Promise<T> {
  let raw: string | null = null;
  try {
    raw = (await store()?.getItem(key)) ?? null;
  } catch {}
  return parse(jsonObject(raw));
}

/** Remembers a tool's options. Best effort. */
export async function writeToolPrefs<T>(key: string, value: T): Promise<void> {
  try {
    await store()?.setItem(key, JSON.stringify(value));
  } catch {}
}
