// lib/filters.ts
import { PageAdjustment, PageFilter } from '../types/document';

/** Returns a React Native `filter` style string, or undefined for 'original'. */
export function filterStyle(filter?: PageFilter): string | undefined {
  switch (filter) {
    case 'grayscale': return 'grayscale(1)';
    case 'bw':        return 'grayscale(1) contrast(2)';
    case 'enhanced':  return 'contrast(1.3) saturate(1.3)';
    default:          return undefined;
  }
}

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

function adjStyle(adj?: PageAdjustment): string {
  if (!adj) return '';
  const b = safe(adj.brightness), c = safe(adj.contrast), s = safe(adj.saturation);
  const parts: string[] = [];
  if (b !== 0) parts.push(`brightness(${(100 + b) / 100})`);
  if (c !== 0) parts.push(`contrast(${(100 + c) / 100})`);
  if (s !== 0) parts.push(`saturate(${(100 + s) / 100})`);
  return parts.join(' ');
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

/** Combined filter + per-page adjustments for RN Image display. */
export function combinedFilterStyle(filter?: PageFilter, adj?: PageAdjustment): string | undefined {
  const f = filterStyle(filter) ?? '';
  const a = adjStyle(adj);
  const combined = [f, a].filter(Boolean).join(' ');
  return combined || undefined;
}

/** Combined filter + per-page adjustments CSS for PDF/HTML rendering. */
export function combinedFilterCss(filter?: PageFilter, adj?: PageAdjustment): string {
  const f = filterCss(filter);
  const a = adjCss(adj);
  const fVal = f === 'none' ? '' : f;
  const combined = [fVal, a].filter(Boolean).join(' ');
  return combined || 'none';
}
