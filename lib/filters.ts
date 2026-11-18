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

// The op list is plain objects ([{ magic: 1 }, { brightness: 1.1 }]) so it can
// be serialised straight into the bake WebView.
type RNFilter = Record<string, number>;

// Document filters are whole-image operations (see lib/pixel-kernels.ts):
// lighting is flattened first so shadows and yellowed paper disappear, then
// Enhanced keeps colour, Grayscale drops it and Black & white thresholds
// adaptively. The Adjust sliders compose after the filter, except on Black &
// white, whose output is already pure black and white: there Brightness moves
// the threshold (brighter = fewer dark pixels) and Contrast sets how hard the
// edges are, so both sliders still do something visible.
function filterRNParts(filter?: PageFilter, adj?: PageAdjustment): RNFilter[] {
  switch (filter) {
    case 'grayscale': return [{ docgray: 1 }];
    case 'enhanced':  return [{ magic: 1 }];
    case 'bw': {
      const op: RNFilter = { docbw: 1 };
      const b = clampUnit(safe(adj?.brightness) / 100), c = clampUnit(safe(adj?.contrast) / 100);
      if (b !== 0) op.bias = b;
      if (c !== 0) op.crisp = c;
      return [op];
    }
    default:          return [];
  }
}

const clampUnit = (v: number) => Math.max(-1, Math.min(1, v));

function adjRNParts(adj?: PageAdjustment, filter?: PageFilter): RNFilter[] {
  if (!adj) return [];
  // Black & white folds brightness/contrast into its threshold, and has no colour.
  if (filter === 'bw') return [];
  const b = safe(adj.brightness), c = safe(adj.contrast), s = safe(adj.saturation);
  const parts: RNFilter[] = [];
  if (b !== 0) parts.push({ brightness: (100 + b) / 100 });
  if (c !== 0) parts.push({ contrast: (100 + c) / 100 });
  if (s !== 0) parts.push({ saturate: (100 + s) / 100 });
  return parts;
}

/**
 * The bake op list for a page's filter + Adjust sliders, in the order the bake
 * canvas applies them (lib/pixel-kernels.ts), or undefined when there is
 * nothing to apply. Used by lib/bake.ts for page bakes and filter previews.
 */
export function combinedFilterRN(filter?: PageFilter, adj?: PageAdjustment): RNFilter[] | undefined {
  const parts = [...filterRNParts(filter, adj), ...adjRNParts(adj, filter)];
  return parts.length ? parts : undefined;
}
