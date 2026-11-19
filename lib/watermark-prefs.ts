// lib/watermark-prefs.ts
// The Watermark tool's remembered choices (app/tools/watermark.tsx): the text,
// Single or Tiled, the style, the colour (a palette id, or 'custom' with its
// hex — round 16), bold or regular, and the size and strength chosen for each
// type. One additive key of its own: nothing here touches documents or other
// settings. Round 16 only added fields (`customColor`, `bold`) and colour ids,
// so a value saved by round 15 loads unchanged.
//
// Reading is forgiving on purpose. A stored value from an older build (or a
// later one with fields this build doesn't know) loads field by field: a field
// that is missing or not valid falls back to its default, numbers are clamped
// to the current ranges, unknown fields are ignored. A broken value never
// stops the tool from opening.
import {
  clampWatermarkSize,
  clampWatermarkStrength,
  type WatermarkLayout,
  type WatermarkStyle,
} from './stamp';
import { normalizeHex, parseInkChoice, type InkChoice } from './stamp-colors';

const KEY = '@scan_kit_watermark';

/** Per type: a number the user set, or null for automatic (lib/stamp.ts resolveWatermarkLook). */
export type PerLayout = Record<WatermarkLayout, number | null>;

export type WatermarkPrefs = {
  text: string;
  layout: WatermarkLayout;
  style: WatermarkStyle;
  color: InkChoice;
  /** The hex for color 'custom' (null until one is picked). */
  customColor: string | null;
  /** Bold (the original) or regular. */
  bold: boolean;
  /** Points on an A4-wide page. Kept per type: a good tile size is far smaller than a single mark. */
  size: PerLayout;
  /** Ink opacity in percent. */
  strength: PerLayout;
};

export const WATERMARK_TEXT_MAX = 40;

/** The tool's look before anything is remembered: what it always drew by default. */
export const DEFAULT_WATERMARK_PREFS: WatermarkPrefs = {
  text: 'CONFIDENTIAL',
  layout: 'single',
  style: 'diagonal',
  color: 'gray',
  customColor: null,
  bold: true,
  size: { single: null, tiled: null },
  strength: { single: null, tiled: null },
};

const LAYOUTS: readonly WatermarkLayout[] = ['single', 'tiled'];
const STYLES: readonly WatermarkStyle[] = ['diagonal', 'center', 'footer'];

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

function perLayout(v: unknown, clamp: (layout: WatermarkLayout, n: number) => number): PerLayout {
  const src = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const one = (layout: WatermarkLayout) => {
    const n = src[layout];
    return typeof n === 'number' && Number.isFinite(n) ? clamp(layout, n) : null;
  };
  return { single: one('single'), tiled: one('tiled') };
}

/** Stored JSON (or null) to prefs; never throws. */
export function parseWatermarkPrefs(raw: string | null | undefined): WatermarkPrefs {
  let v: unknown = null;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    v = null;
  }
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const d = DEFAULT_WATERMARK_PREFS;
  const text = typeof o.text === 'string' ? o.text.trim().slice(0, WATERMARK_TEXT_MAX) : '';
  return {
    text: text || d.text,
    layout: oneOf(o.layout, LAYOUTS, d.layout),
    style: oneOf(o.style, STYLES, d.style),
    color: parseInkChoice(o.color, d.color),
    customColor: normalizeHex(o.customColor),
    bold: typeof o.bold === 'boolean' ? o.bold : d.bold,
    size: perLayout(o.size, clampWatermarkSize),
    strength: perLayout(o.strength, (_l, n) => clampWatermarkStrength(n)),
  };
}

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

/** The remembered choices, or the defaults. Never throws. */
export async function loadWatermarkPrefs(): Promise<WatermarkPrefs> {
  try {
    return parseWatermarkPrefs(await store()?.getItem(KEY));
  } catch {
    return parseWatermarkPrefs(null);
  }
}

/** Remembers the choices. Best effort: a preference that didn't stick is not worth an error. */
export async function saveWatermarkPrefs(prefs: WatermarkPrefs): Promise<void> {
  try {
    await store()?.setItem(KEY, JSON.stringify(parseWatermarkPrefs(JSON.stringify(prefs))));
  } catch {}
}
