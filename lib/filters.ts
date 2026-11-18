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
//
// R12 added five filters (new ids, new ops; the four above are untouched):
// No shadow (`noshadow`), Photo (`photo`), Faint text (`faint`), Whiteboard
// (`board`) and Ink saver (`eco`), and the Sharpness slider (`sharpen`). On
// Black & white, Sharpness runs BEFORE the threshold (sharpening a pure black
// and white image changes nothing); everywhere else it runs right after the
// filter, before the other sliders.
function filterRNParts(filter?: PageFilter, adj?: PageAdjustment): RNFilter[] {
  switch (filter) {
    case 'grayscale': return [{ docgray: 1 }];
    case 'enhanced':  return [{ magic: 1 }];
    case 'bw': {
      const op: RNFilter = { docbw: 1 };
      const b = clampUnit(safe(adj?.brightness) / 100), c = clampUnit(safe(adj?.contrast) / 100);
      if (b !== 0) op.bias = b;
      if (c !== 0) op.crisp = c;
      const sh = sharpOp(adj);
      return sh ? [sh, op] : [op];
    }
    case 'noshadow':   return [{ noshadow: 1 }];
    case 'photo':      return [{ photo: 1 }];
    case 'fainttext':  return [{ faint: 1 }];
    case 'whiteboard': return [{ board: 1 }];
    case 'inksaver':   return [{ eco: 1 }];
    default:          return [];
  }
}

function sharpOp(adj?: PageAdjustment): RNFilter | null {
  const v = clampUnit(safe(adj?.sharpness) / 100);
  return v !== 0 ? { sharpen: v } : null;
}

/** Filters whose output is gray, where a Saturation setting does nothing. */
export const NO_COLOR_FILTERS: readonly PageFilter[] = ['grayscale', 'bw', 'fainttext', 'inksaver'];

/** True when an adjustment changes nothing (missing fields count as 0). */
export function isNeutralAdjustment(adj?: PageAdjustment): boolean {
  return !adj || (!safe(adj.brightness) && !safe(adj.contrast) && !safe(adj.saturation) && !safe(adj.sharpness));
}

const clampUnit = (v: number) => Math.max(-1, Math.min(1, v));

function adjRNParts(adj?: PageAdjustment, filter?: PageFilter): RNFilter[] {
  if (!adj) return [];
  // Black & white folds brightness/contrast into its threshold, and has no colour.
  if (filter === 'bw') return [];
  const b = safe(adj.brightness), c = safe(adj.contrast), s = safe(adj.saturation);
  const parts: RNFilter[] = [];
  const sh = sharpOp(adj);
  if (sh) parts.push(sh);
  if (b !== 0) parts.push({ brightness: (100 + b) / 100 });
  if (c !== 0) parts.push({ contrast: (100 + c) / 100 });
  // Grayscale (and the other gray filters) have no colour either: a stored
  // Saturation (set under another filter) would only cost a no-op pass. The
  // viewer hides the slider for them.
  if (s !== 0 && !(filter && NO_COLOR_FILTERS.includes(filter))) parts.push({ saturate: (100 + s) / 100 });
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
