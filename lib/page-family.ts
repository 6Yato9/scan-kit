// lib/page-family.ts
// The files that make up one stored page, by what follows `page-N` in their
// names. Dependency-free so every module (and every test mock) shares it.
//
//   page-N.jpg        the page itself
//   page-N.orig.jpg   its unfiltered shadow (lib/bake.ts)
//   page-N.src.jpg    its uncropped source photo (lib/page-source.ts, R12)
//   page-N.src.json   the crop geometry that made the page from that photo
//
// Each shadow is optional, and every one of them must travel with its page
// through every copy, delete, reorder and restore: a shadow left behind gets
// paired with whatever page lands at its index next.

/** The page's shadows (all optional). */
export const PAGE_SHADOW_SUFFIXES = ['.orig.jpg', '.src.jpg', '.src.json'] as const;
/** The page itself first, then its shadows. */
export const PAGE_FAMILY_SUFFIXES = ['.jpg', ...PAGE_SHADOW_SUFFIXES] as const;
