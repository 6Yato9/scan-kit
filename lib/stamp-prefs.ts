// lib/stamp-prefs.ts
// Remembered looks for Sign (ink colour, opacity) and Redact (box colour, the
// "REDACTED" label) — round 16. Each tool has one additive key of its own;
// nothing here touches documents, saved signatures or other settings.
// Reading is forgiving like lib/watermark-prefs.ts: field by field, unknown or
// broken values fall back to the default, nothing throws.
import { clampPercent } from './stamp';
import { normalizeHex, parseInkChoice, type InkChoice } from './stamp-colors';

type Store = { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void> };

/** AsyncStorage, loaded on first use (as in lib/export-prefs.ts): a missing module just forgets. */
function store(): Store | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@react-native-async-storage/async-storage');
    return (mod.default ?? mod) as Store;
  } catch {
    return null;
  }
}

function object(raw: string | null | undefined): Record<string, unknown> {
  let v: unknown = null;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    v = null;
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ── Sign ────────────────────────────────────────────────────────────────────

export type SignPrefs = {
  ink: InkChoice;
  customInk: string | null;
  /** Opacity in percent (100: as solid as ink). */
  strength: number;
};

/** Black and fully opaque: how every signature was drawn before. */
export const DEFAULT_SIGN_PREFS: SignPrefs = { ink: 'black', customInk: null, strength: 100 };

export const SIGN_STRENGTH_RANGE = { min: 30, max: 100 };

export function parseSignPrefs(raw: string | null | undefined): SignPrefs {
  const o = object(raw);
  const d = DEFAULT_SIGN_PREFS;
  return {
    ink: parseInkChoice(o.ink, d.ink),
    customInk: normalizeHex(o.customInk),
    strength: num(o.strength) ? clampPercent(o.strength, SIGN_STRENGTH_RANGE.min, SIGN_STRENGTH_RANGE.max) : d.strength,
  };
}

const SIGN_KEY = '@scan_kit_sign_style';

export async function loadSignPrefs(): Promise<SignPrefs> {
  try {
    return parseSignPrefs(await store()?.getItem(SIGN_KEY));
  } catch {
    return parseSignPrefs(null);
  }
}

export async function saveSignPrefs(p: SignPrefs): Promise<void> {
  try {
    await store()?.setItem(SIGN_KEY, JSON.stringify(parseSignPrefs(JSON.stringify(p))));
  } catch {}
}

// ── Redact ──────────────────────────────────────────────────────────────────

export type RedactPrefs = {
  color: InkChoice;
  customColor: string | null;
  /** Print "REDACTED" across each box. */
  label: boolean;
};

/** Solid black, no label: how every redaction was burned in before. */
export const DEFAULT_REDACT_PREFS: RedactPrefs = { color: 'black', customColor: null, label: false };

export function parseRedactPrefs(raw: string | null | undefined): RedactPrefs {
  const o = object(raw);
  const d = DEFAULT_REDACT_PREFS;
  return {
    color: parseInkChoice(o.color, d.color),
    customColor: normalizeHex(o.customColor),
    label: typeof o.label === 'boolean' ? o.label : d.label,
  };
}

const REDACT_KEY = '@scan_kit_redact_style';

export async function loadRedactPrefs(): Promise<RedactPrefs> {
  try {
    return parseRedactPrefs(await store()?.getItem(REDACT_KEY));
  } catch {
    return parseRedactPrefs(null);
  }
}

export async function saveRedactPrefs(p: RedactPrefs): Promise<void> {
  try {
    await store()?.setItem(REDACT_KEY, JSON.stringify(parseRedactPrefs(JSON.stringify(p))));
  } catch {}
}
