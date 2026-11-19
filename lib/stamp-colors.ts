// lib/stamp-colors.ts
// The colours the stamp tools (Timestamp, Watermark, Sign, Redact) offer, and
// the small colour maths behind them: the palette, a custom colour picked by
// hue and shade, and turning a choice + opacity into the CSS the canvas paints
// with (lib/stamp.ts) and the preview shows.
//
// One palette for every tool, so a "Blue" is the same choice everywhere. A
// tool may keep its own historical shade for an id (TOOL_INKS): the
// Timestamp's black is the #222 it always printed, Sign's black and blue are
// the inks signatures were always drawn in, Redact's black is pure #000. That
// way adding the palette changed nothing a user already had.
//
// Stored choices are plain ids ('blue') or 'custom' plus a '#rrggbb' string:
// anything else (an id from a later build, a broken hex) reads as the tool's
// default, never as an error.

export type PaletteColor = 'black' | 'gray' | 'white' | 'red' | 'orange' | 'green' | 'teal' | 'blue' | 'purple';

/** A colour choice as stored: a palette id, or 'custom' (its hex is stored alongside). */
export type InkChoice = PaletteColor | 'custom';

/** Highlight (background) choices: none, or a light marker colour, or any ink. */
export type HighlightChoice = 'none' | 'white' | 'yellow' | 'lime' | 'pink' | 'sky' | 'black' | 'red' | 'custom';

export type PaletteEntry<T extends string> = { id: T; label: string; hex: string };

/**
 * Ink colours, in the order the swatches show. Gray, red and blue are exactly
 * the Watermark's original inks (lib/stamp.ts STAMP_RGB) so a watermark made
 * before the palette prints the same.
 */
export const INK_PALETTE: readonly PaletteEntry<PaletteColor>[] = [
  { id: 'black', label: 'Black', hex: '#111111' },
  { id: 'gray', label: 'Gray', hex: '#707070' },
  { id: 'white', label: 'White', hex: '#ffffff' },
  { id: 'red', label: 'Red', hex: '#c81e1e' },
  { id: 'orange', label: 'Orange', hex: '#e2680d' },
  { id: 'green', label: 'Green', hex: '#1f8a3b' },
  { id: 'teal', label: 'Teal', hex: '#0f7f86' },
  { id: 'blue', label: 'Blue', hex: '#1450be' },
  { id: 'purple', label: 'Purple', hex: '#6b2fb3' },
];

/**
 * Highlight colours: light marker tints (as Markup's highlighter, lib/theme.ts
 * Highlight) that dark text reads on, plus black and red for a white-on-dark
 * "PAID" look.
 */
export const HIGHLIGHT_PALETTE: readonly PaletteEntry<Exclude<HighlightChoice, 'none' | 'custom'>>[] = [
  { id: 'white', label: 'White', hex: '#ffffff' },
  { id: 'yellow', label: 'Yellow', hex: '#ffe45e' },
  { id: 'lime', label: 'Green', hex: '#a6ee8f' },
  { id: 'pink', label: 'Pink', hex: '#ffa8d2' },
  { id: 'sky', label: 'Blue', hex: '#a3dcff' },
  { id: 'black', label: 'Black', hex: '#111111' },
  { id: 'red', label: 'Red', hex: '#c81e1e' },
];

export const INK_IDS: readonly PaletteColor[] = INK_PALETTE.map(p => p.id);
export const HIGHLIGHT_IDS: readonly HighlightChoice[] = ['none', ...HIGHLIGHT_PALETTE.map(p => p.id), 'custom'];

/** Each tool's own shade for some ids: what it drew before the palette existed. */
export const TOOL_INKS = {
  timestamp: { black: '#222222' } as Partial<Record<PaletteColor, string>>,
  watermark: {} as Partial<Record<PaletteColor, string>>,
  sign: { black: '#111111', blue: '#1d3f9e' } as Partial<Record<PaletteColor, string>>,
  redact: { black: '#000000', gray: '#808080' } as Partial<Record<PaletteColor, string>>,
};

/** A '#rrggbb' (or '#rgb') string as lower-case '#rrggbb', or null when it isn't one. */
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const h = normalizeHex(hex);
  if (!h) return null;
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.min(255, Math.max(0, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * The hex an ink choice paints with, for a tool (its own shades first).
 * Unknown ids: `fallback`. Custom with no (valid) hex yet is the colour the
 * Custom swatch shows until a slider moves, DEFAULT_CUSTOM_HEX.
 */
export function inkHex(
  choice: unknown,
  custom: unknown,
  overrides: Partial<Record<PaletteColor, string>> = {},
  fallback: PaletteColor = 'black',
): string {
  if (choice === 'custom') return normalizeHex(custom) ?? DEFAULT_CUSTOM_HEX;
  const id = (INK_IDS as readonly unknown[]).includes(choice) ? (choice as PaletteColor) : fallback;
  return overrides[id] ?? INK_PALETTE.find(p => p.id === id)!.hex;
}

/** The hex a highlight choice fills with, or null for none. Unknown ids: none. Custom as in inkHex. */
export function highlightHex(choice: unknown, custom: unknown): string | null {
  if (choice === 'custom') return normalizeHex(custom) ?? DEFAULT_CUSTOM_HEX;
  return HIGHLIGHT_PALETTE.find(p => p.id === choice)?.hex ?? null;
}

/**
 * CSS for a colour at an opacity (0..1). Fully opaque stays the plain hex, so
 * a default stamp resolves to exactly the colour string it always had.
 */
export function cssColor(hex: string, opacity = 1): string {
  const rgb = hexToRgb(hex) ?? [0, 0, 0];
  const a = Math.min(1, Math.max(0, Number.isFinite(opacity) ? opacity : 1));
  if (a >= 1) return normalizeHex(hex) ?? '#000000';
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Number(a.toFixed(3))})`;
}

/** Relative luminance (WCAG), 0 for black … 1 for white. */
export function luminance(hex: string): number {
  const rgb = hexToRgb(hex) ?? [0, 0, 0];
  const lin = rgb.map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** True for a light colour, which needs dark marks (a check, a label) on it. */
export function isLight(hex: string): boolean {
  return luminance(hex) > 0.4;
}

/** Black or white, whichever reads better on `hex` (a swatch's check, Redact's label). */
export function contrastOn(hex: string): '#000000' | '#ffffff' {
  return isLight(hex) ? '#000000' : '#ffffff';
}

// ── Custom colour: hue and shade ────────────────────────────────────────────
//
// A custom colour is picked with two sliders: the hue (0–359°) and the shade
// (from deep to pale). Saturation is fixed at a strong, print-friendly level,
// so every pick is a usable ink; greys are in the palette already.

export const CUSTOM_SATURATION = 0.72;
/** Shade range, as HSL lightness: deep enough to read as ink, pale enough to highlight. */
export const SHADE_RANGE = { min: 0.15, max: 0.85 };
/** What Custom starts as before the user moves anything: a mid blue-violet. */
export const DEFAULT_CUSTOM_HEX = hslToHex(250, CUSTOM_SATURATION, 0.45);

export function hslToHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const rgb = hexToRgb(hex) ?? [0, 0, 0];
  const [r, g, b] = rgb.map(c => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s, l };
}

/** The custom colour for slider positions: hue in degrees, shade 0 (deep) … 1 (pale). */
export function customFromSliders(hue: number, shade: number): string {
  const t = Math.min(1, Math.max(0, shade));
  return hslToHex(hue, CUSTOM_SATURATION, SHADE_RANGE.min + t * (SHADE_RANGE.max - SHADE_RANGE.min));
}

/** Slider positions for a custom colour (the inverse of customFromSliders, to a rounding). */
export function slidersFromCustom(hex: string): { hue: number; shade: number } {
  const { h, l } = hexToHsl(hex);
  const shade = (l - SHADE_RANGE.min) / (SHADE_RANGE.max - SHADE_RANGE.min);
  return { hue: Math.round(h), shade: Math.min(1, Math.max(0, shade)) };
}

/** Spoken / shown name of a choice ("Blue", "Custom"). */
export function inkLabel(choice: InkChoice): string {
  return choice === 'custom' ? 'Custom' : INK_PALETTE.find(p => p.id === choice)?.label ?? 'Black';
}

/** Reads a stored ink choice; anything unknown is `fallback`. */
export function parseInkChoice(v: unknown, fallback: InkChoice): InkChoice {
  return v === 'custom' || (INK_IDS as readonly unknown[]).includes(v) ? (v as InkChoice) : fallback;
}

/** Reads a stored highlight choice; anything unknown is `fallback`. */
export function parseHighlightChoice(v: unknown, fallback: HighlightChoice): HighlightChoice {
  return (HIGHLIGHT_IDS as readonly unknown[]).includes(v) ? (v as HighlightChoice) : fallback;
}
