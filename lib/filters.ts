// lib/filters.ts
//
// Filters are baked into page pixels (see lib/bake.ts), so this module produces
// only the primitive list the bake canvas applies. The CSS builders that used to
// live here were removed once nothing rendered filters at display or export time:
// re-introducing a CSS filter anywhere downstream would double-apply it on top of
// pixels that already carry it.
import { PageAdjustment, PageFilter } from '../types/document';

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
 * array, or undefined when there's nothing to apply.
 *
 * PREVIEW-ONLY — this is NOT the render path anymore. Filters are now baked
 * directly into a page's JPEG pixels (see lib/bake.ts) because RN's iOS
 * `filter` style implementation only honors brightness/opacity and silently
 * drops grayscale/contrast/saturate. The one remaining caller is
 * components/page-actions-sheet.tsx's filter-picker tiles, which use it to
 * preview what a filter WOULD look like before the user applies it.
 */
export function combinedFilterRN(filter?: PageFilter, adj?: PageAdjustment): RNFilter[] | undefined {
  const parts = [...filterRNParts(filter), ...adjRNParts(adj)];
  return parts.length ? parts : undefined;
}
