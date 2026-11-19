// lib/toolbar-layout.ts
// Item widths for the viewer's page toolbar (components/viewer-toolbar.tsx),
// which scrolls sideways once its actions no longer fit.
//
// While they fit, the items share the width equally, as before. Once they
// don't, every item gets the same width, at least `minItem`, chosen so the
// row ends part-way through an item: a cut-off icon and label at the edge is
// how iOS says "there's more this way" (no scroll indicator, no arrow).
//
// Pure, for jest.

/** How much of the item at the edge shows when the row overflows. */
export const TOOLBAR_PEEK = 0.45;

export function toolbarLayout(
  available: number,
  count: number,
  minItem: number,
  peek: number = TOOLBAR_PEEK,
): { itemWidth: number; scrolls: boolean } {
  if (count <= 0 || available <= 0) return { itemWidth: minItem, scrolls: false };
  if (count * minItem <= available) return { itemWidth: available / count, scrolls: false };
  // Whole items that fit with room left for the peek, at the narrowest width.
  const whole = Math.max(1, Math.floor(available / minItem - peek));
  // (A row narrower than one and a bit items still never squeezes one below minItem.)
  return { itemWidth: Math.max(minItem, available / (whole + peek)), scrolls: true };
}
