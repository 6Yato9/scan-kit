// lib/filters.ts
import { PageAdjustment, PageFilter } from '../types/document';

/** Returns a CSS filter string for use in PDF HTML <img> tags. */
export function filterCss(filter?: PageFilter): string {
  switch (filter) {
    case 'grayscale': return 'grayscale(100%)';
    case 'bw':        return 'grayscale(100%) contrast(200%)';
    case 'enhanced':  return 'contrast(130%) saturate(130%)';
    default:          return 'none';
  }
}

// Coerce any non-finite value (NaN / Infinity / null / undefined) to 0 so a
// corrupt stored doc can't produce `brightness(NaN)` and blank out the image.
const safe = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// ── React Native `filter` style (array form) ─────────────────────────────────
// RN's filter style prop on the New Architecture (iOS + Android) only reliably
// honors the ARRAY-of-objects form, e.g. [{ grayscale: 1 }, { contrast: 2 }].
// A CSS string like 'grayscale(1) contrast(2)' is silently ignored on iOS,
// which is why filters previously appeared to do nothing on device.
type RNFilter = Record<string, number>;

function filterRNParts(filter?: PageFilter): RNFilter[] {
  switch (filter) {
    case 'grayscale': return [{ grayscale: 1 }];
    case 'bw':        return [{ grayscale: 1 }, { contrast: 2 }];
    case 'enhanced':  return [{ contrast: 1.3 }, { saturate: 1.3 }];
    default:          return [];
  }
}

function adjRNParts(adj?: PageAdjustment): RNFilter[] {
  if (!adj) return [];
  const b = safe(adj.brightness), c = safe(adj.contrast), s = safe(adj.saturation);
  const parts: RNFilter[] = [];
  if (b !== 0) parts.push({ brightness: (100 + b) / 100 });
  if (c !== 0) parts.push({ contrast: (100 + c) / 100 });
  if (s !== 0) parts.push({ saturate: (100 + s) / 100 });
  return parts;
}

/**
 * Combined page filter + per-page adjustments as a React Native `filter` style
 * array, or undefined when there's nothing to apply. Use this for on-device
 * <Image> rendering. (Use combinedFilterCss for PDF/print HTML.)
 */
export function combinedFilterRN(filter?: PageFilter, adj?: PageAdjustment): RNFilter[] | undefined {
  const parts = [...filterRNParts(filter), ...adjRNParts(adj)];
  return parts.length ? parts : undefined;
}

function adjCss(adj?: PageAdjustment): string {
  if (!adj) return '';
  const b = safe(adj.brightness), c = safe(adj.contrast), s = safe(adj.saturation);
  const parts: string[] = [];
  if (b !== 0) parts.push(`brightness(${100 + b}%)`);
  if (c !== 0) parts.push(`contrast(${100 + c}%)`);
  if (s !== 0) parts.push(`saturate(${100 + s}%)`);
  return parts.join(' ');
}

/** Combined filter + per-page adjustments CSS for PDF/HTML rendering. */
export function combinedFilterCss(filter?: PageFilter, adj?: PageAdjustment): string {
  const f = filterCss(filter);
  const a = adjCss(adj);
  const fVal = f === 'none' ? '' : f;
  const combined = [fVal, a].filter(Boolean).join(' ');
  return combined || 'none';
}
