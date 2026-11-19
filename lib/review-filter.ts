// lib/review-filter.ts
// Choosing the filter in the camera's review step, before anything is saved.
//
// The review (components/capture-review.tsx) knows the captured photos; the
// save (contexts/scan-context.tsx) knows the pages handed back by the camera.
// They meet here, keyed by each capture's photo (CapturedPage.sourceUri,
// which the camera hands back as SourcePageInput.sourceUri):
// - The scan that opens the camera arms a session with its default filter
//   (Scan settings), withReviewFilters(). Only an armed session shows the
//   picker: tools that save with their own look (Whiteboard, ID card, Book…)
//   or don't save pages at all (Extract text) never show it.
// - The review records the user's choice: one filter for every page, and
//   optionally a page of its own.
// - The save asks filtersFor(pages): the chosen filter for each page, which
//   is then baked exactly like the default filter was (Pages are always
//   stored as 'original' and the filter is recorded by the bake that writes
//   it — lib/save-scan.ts).
//
// Previews: each filter tile and the big page are the capture's preview image
// run through the same bake pipeline the viewer uses (lib/bake-queue.ts,
// combinedFilterRN, buildPreviewHtml), so what you pick is what is saved.
import type { PageFilter } from '../types/document';
import type { ScanPageInput } from './page-source';
import { combinedFilterRN } from './filters';
import { enqueueBake } from './bake-queue';
import { PREVIEW_FILTERS } from './bake';

type Session = {
  defaultFilter: PageFilter;
  /** The filter for every page, once the user picked one. */
  all: PageFilter | null;
  /** Pages given a filter of their own, by photo URI. */
  perPage: Map<string, PageFilter>;
};

let session: Session | null = null;
const listeners = new Set<() => void>();

/** What the review shows: a new object whenever the choice changes (for useSyncExternalStore). */
export type ReviewFilterSnapshot = { defaultFilter: PageFilter; all: PageFilter | null; perPage: ReadonlyMap<string, PageFilter> };
let snapshot: ReviewFilterSnapshot | null = null;

const emit = () => {
  snapshot = session ? { defaultFilter: session.defaultFilter, all: session.all, perPage: new Map(session.perPage) } : null;
  for (const l of [...listeners]) { try { l(); } catch {} }
};

/** The current choice, or null when no scan has the picker on. */
export function getReviewFilterSnapshot(): ReviewFilterSnapshot | null {
  return snapshot;
}

/** The filter page `uri` will be saved with, in `snap` (pure: for rendering). */
export function filterInSnapshot(snap: ReviewFilterSnapshot | null, uri: string): PageFilter | null {
  if (!snap) return null;
  return snap.perPage.get(keyOf(uri)) ?? snap.all ?? snap.defaultFilter;
}

const keyOf = (uri: string) => uri.split('?')[0];

/**
 * Runs `open` (which shows the camera and resolves with its pages) with the
 * review's filter picker on, starting at `defaultFilter`. Resolves with the
 * pages and the filter chosen for each (`defaultFilter` where nothing was
 * chosen).
 */
export async function withReviewFilters(
  defaultFilter: PageFilter,
  open: () => Promise<ScanPageInput[] | null>,
): Promise<{ pages: ScanPageInput[] | null; filters: PageFilter[] }> {
  const mine: Session = { defaultFilter, all: null, perPage: new Map() };
  session = mine;
  emit();
  try {
    const pages = await open();
    return { pages, filters: pages ? filtersFor(pages, mine) : [] };
  } finally {
    if (session === mine) {
      session = null;
      emit();
    }
  }
}

/** The review's starting filter while a session is armed; null = no picker. */
export function reviewFilterSession(): { defaultFilter: PageFilter } | null {
  return session ? { defaultFilter: session.defaultFilter } : null;
}

export function subscribeReviewFilters(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The filter page `uri` will be saved with. */
export function reviewFilterOf(uri: string, s: Session | null = session): PageFilter | null {
  if (!s) return null;
  return s.perPage.get(keyOf(uri)) ?? s.all ?? s.defaultFilter;
}

/** True when `uri` has a filter of its own (not the one for every page). */
export function hasOwnReviewFilter(uri: string): boolean {
  return !!session?.perPage.has(keyOf(uri));
}

/**
 * Chooses `filter`: for every page (clearing pages' own choices), or, with
 * `onlyUri`, for that page alone.
 */
export function chooseReviewFilter(filter: PageFilter, onlyUri?: string): void {
  if (!session) return;
  if (onlyUri) {
    session.perPage.set(keyOf(onlyUri), filter);
  } else {
    session.all = filter;
    session.perPage.clear();
  }
  emit();
}

/** The filter for each page the camera handed back. */
export function filtersFor(pages: ScanPageInput[], s: Session | null = session): PageFilter[] {
  return pages.map(p => {
    const uri = typeof p === 'string' ? p : p.sourceUri;
    return reviewFilterOf(uri, s) ?? s?.defaultFilter ?? 'original';
  });
}

/** Groups page indices by filter, for one bakePages call per filter ('original' needs none). */
export function bakeGroups(filters: PageFilter[]): { filter: PageFilter; indices: number[] }[] {
  const groups = new Map<PageFilter, number[]>();
  filters.forEach((f, i) => {
    if (f === 'original') return;
    const list = groups.get(f) ?? [];
    list.push(i);
    groups.set(f, list);
  });
  return [...groups.entries()].map(([filter, indices]) => ({ filter, indices }));
}

// ── Previews ─────────────────────────────────────────────────────────────────

/** Not a document: bake jobs need an id and index only to group their work. */
const REVIEW_DOC = 'capture-review';
const tileCache = new Map<string, string[]>();
const pageCache = new Map<string, string>();
const PAGE_CACHE_MAX = 24;

/** Filter tiles (one per PREVIEW_FILTERS entry, data URLs) for the preview image `src`. */
export async function reviewTilePreviews(src: string): Promise<string[]> {
  const key = keyOf(src);
  const hit = tileCache.get(key);
  if (hit) return hit;
  const reply = await enqueueBake(
    {
      docId: REVIEW_DOC,
      pageIndex: 0,
      src: key,
      ops: [],
      previews: PREVIEW_FILTERS.map(f => combinedFilterRN(f, undefined) ?? []),
      previewWidth: 360,
    },
    { priority: 'high' },
  );
  const urls = JSON.parse(reply.replace(/^PREVIEWS:/, '')) as string[];
  tileCache.set(key, urls);
  return urls;
}

/** The preview image `src` with `filter` applied (a data URL), or `src` itself for Original. */
export async function reviewPagePreview(src: string, filter: PageFilter): Promise<string> {
  const ops = combinedFilterRN(filter, undefined);
  if (!ops) return src;
  const key = `${keyOf(src)}|${filter}`;
  const hit = pageCache.get(key);
  if (hit) return hit;
  const url = await enqueueBake({ docId: REVIEW_DOC, pageIndex: 1, src: keyOf(src), ops }, { priority: 'high' });
  pageCache.set(key, url);
  if (pageCache.size > PAGE_CACHE_MAX) pageCache.delete(pageCache.keys().next().value as string);
  return url;
}

/** Drops cached previews (the review closed: its preview files are gone). */
export function clearReviewPreviews(): void {
  tileCache.clear();
  pageCache.clear();
}

export function resetReviewFiltersForTests(): void {
  session = null;
  snapshot = null;
  listeners.clear();
  clearReviewPreviews();
}
