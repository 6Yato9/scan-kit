// lib/erase-strength.ts
// Erase marks' strength (round 16): the Black & white filter's Brightness
// (the threshold: brighter = fewer dark pixels, so fainter marks disappear)
// and Contrast (how hard edges are). Standard is the +30 / +30 the tool has
// always used, so it stays the default.
import type { PageAdjustment } from '../types/document';
import { oneOf } from './tool-prefs';

export type EraseStrength = 'light' | 'standard' | 'strong';
export const ERASE_STRENGTHS: readonly EraseStrength[] = ['light', 'standard', 'strong'];

const LEVELS: Record<EraseStrength, { brightness: number; contrast: number }> = {
  light: { brightness: 12, contrast: 20 },
  standard: { brightness: 30, contrast: 30 },
  strong: { brightness: 55, contrast: 40 },
};

/** The adjustment baked with the Black & white filter for `strength` (a fresh object). */
export function eraseAdjustment(strength: EraseStrength): PageAdjustment {
  return { ...LEVELS[strength], saturation: 0 };
}

/** The remembered strength; anything unknown is Standard. Pure. */
export function parseEraseStrength(o: Record<string, unknown>): EraseStrength {
  return oneOf(ERASE_STRENGTHS, o.strength, 'standard');
}
