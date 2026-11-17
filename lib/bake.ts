// lib/bake.ts
//
// Orchestrates baking a filter into a page's actual JPEG pixels. Always
// bakes FROM the pristine .orig copy (see lib/files.ts's ensureOriginal),
// never from the current page-N.jpg — that keeps repeated filter changes
// from compounding JPEG generation loss and keeps "Original" reachable.
//
// Ordering matters: the filter is only recorded in storage AFTER the baked
// pixels have been written to disk. If the bake or the write fails, nothing
// is recorded, so pixels and metadata never disagree, and a page export
// racing an in-flight bake yields unenhanced (not wrong) output.
import { Directory, File, Paths } from 'expo-file-system';
import { writeAsStringAsync } from 'expo-file-system/legacy';
import { PageAdjustment, PageFilter } from '../types/document';
import { enqueueBake } from './bake-queue';
import { ensureOriginal } from './files';
import { combinedFilterRN } from './filters';
import { setPageBaked } from './storage';

const DATA_URL_PREFIX = /^data:image\/jpeg;base64,/;

export async function bakePage(
  docId: string,
  pageIndex: number,
  filter: PageFilter,
  adjustment: PageAdjustment | undefined,
): Promise<void> {
  const src = ensureOriginal(docId, pageIndex);
  // combinedFilterRN already yields the primitive list ([{grayscale:1},{contrast:2}]);
  // the bake canvas applies those with explicit pixel maths, because ctx.filter is
  // a silent no-op in this WebKit.
  const ops = combinedFilterRN(filter, adjustment) ?? [];
  const dataUrl = await enqueueBake({ docId, pageIndex, src, ops });

  const base64 = dataUrl.replace(DATA_URL_PREFIX, '');
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  const dest = new File(dir, `page-${pageIndex}.jpg`);
  await writeAsStringAsync(dest.uri, base64, { encoding: 'base64' });

  await setPageBaked(docId, pageIndex, filter, adjustment);
}

/** Filters offered by the picker, in display order. */
export const PREVIEW_FILTERS: PageFilter[] = ['original', 'grayscale', 'bw', 'enhanced'];

// Previews derive from page-N.orig.jpg, which only changes when the page's
// geometry does — not when a filter is applied — so they are cached per page and
// invalidated by the caller when the page itself changes.
const previewCache = new Map<string, string[]>();

export function previewCacheKey(docId: string, pageIndex: number): string {
  return `${docId}:${pageIndex}`;
}

export function invalidatePreviews(docId: string, pageIndex: number): void {
  previewCache.delete(previewCacheKey(docId, pageIndex));
}

/**
 * Drops every cached preview for a document.
 *
 * Deleting or reordering pages renames the page files, so previews cached under
 * an index now describe a different page. Clearing per-page would miss that —
 * the whole document's cache has to go.
 */
export function invalidateDocPreviews(docId: string): void {
  for (const key of [...previewCache.keys()]) {
    if (key.startsWith(`${docId}:`)) previewCache.delete(key);
  }
}

/**
 * Data URLs for one small preview per entry in PREVIEW_FILTERS, in that order.
 *
 * The picker has to show what each filter WOULD do; on iOS it cannot use the RN
 * `filter` style for that, because it silently does nothing. All four are rendered
 * in a single WebView pass and cached, so opening the sheet costs one round-trip.
 */
export async function bakePreviews(docId: string, pageIndex: number): Promise<string[]> {
  const key = previewCacheKey(docId, pageIndex);
  const hit = previewCache.get(key);
  if (hit) return hit;

  const src = ensureOriginal(docId, pageIndex);
  const opsList = PREVIEW_FILTERS.map(f => combinedFilterRN(f, undefined) ?? []);
  const reply = await enqueueBake({ docId, pageIndex, src, ops: [], previews: opsList, previewWidth: 120 });
  const urls = JSON.parse(reply.replace(/^PREVIEWS:/, '')) as string[];
  previewCache.set(key, urls);
  return urls;
}
