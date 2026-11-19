// lib/review-filter.ts
// Choosing the filter in the camera's review step, before anything is saved.
//
// The review (components/capture-review.tsx) knows the captured photos; the
// save (contexts/scan-context.tsx) knows the pages handed back by the camera.
// They meet here, keyed by each capture's photo (CapturedPage.sourceUri,
// which the camera hands back as SourcePageInput.sourceUri):
// - The scan that opens the camera arms a session with its default filter,
//   withReviewFilters(). Only an armed session shows the picker: tools that
//   save with their own look (Whiteboard, ID card, Book…) or don't save pages
//   at all (Extract text) never show it. Where the default comes from:
//     - a new scan: Scan settings' default filter;
//     - the viewer's Add pages: the document's own filter when all its pages
//       share one, so the new pages match; else Scan settings' (addPagesFilter);
//     - the viewer's Retake: the replaced page's filter AND adjustments
//       (retakeLook), so the new capture keeps the page's look. The
//       adjustments ride along in the session (`adjustment`): the previews
//       show them, and the save bakes them with the chosen filter.
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
import type { Document, PageAdjustment, PageFilter } from '../types/document';
import type { ScanPageInput } from './page-source';
import { combinedFilterRN } from './filters';
import { enqueueBake } from './bake-queue';
import { PREVIEW_FILTERS } from './bake';

/**
 * What the review is for, when a document's own flow opened the camera: it
 * names the confirm button and the pages, so the review says where they go.
 *  - 'add': the viewer's Add pages, to `docName`, which has `pageCount` pages;
 *  - 'replace': the viewer's Retake of page `page` (zero-based) of a
 *    `pageCount`-page document.
 */
export type ReviewPurpose =
  | { kind: 'add'; docName: string; pageCount: number }
  | { kind: 'replace'; page: number; pageCount: number };

type Session = {
  defaultFilter: PageFilter;
  purpose?: ReviewPurpose;
  /** Brightness / contrast / … applied with every filter (a retake keeps the page's); undefined = none. */
  adjustment?: PageAdjustment;
  /** The filter for every page, once the user picked one. */
  all: PageFilter | null;
  /** Pages given a filter of their own, by photo URI. */
  perPage: Map<string, PageFilter>;
};

let session: Session | null = null;
const listeners = new Set<() => void>();

/** What the review shows: a new object whenever the choice changes (for useSyncExternalStore). */
export type ReviewFilterSnapshot = {
  defaultFilter: PageFilter;
  all: PageFilter | null;
  perPage: ReadonlyMap<string, PageFilter>;
  adjustment?: PageAdjustment;
  purpose?: ReviewPurpose;
};
let snapshot: ReviewFilterSnapshot | null = null;

const emit = () => {
  snapshot = session
    ? {
        defaultFilter: session.defaultFilter,
        all: session.all,
        perPage: new Map(session.perPage),
        adjustment: session.adjustment,
        purpose: session.purpose,
      }
    : null;
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
const isDefaultAdj = (a: PageAdjustment | undefined) => !a || (!a.brightness && !a.contrast && !a.saturation && !a.sharpness);

/**
 * Runs `open` (which shows the camera and resolves with its pages) with the
 * review's filter picker on, starting at `defaultFilter`. Resolves with the
 * pages and the filter chosen for each (`defaultFilter` where nothing was
 * chosen). `options.adjustment` is shown with every filter in the previews;
 * the caller saves the pages with it. `options.purpose` names the review's
 * confirm button and pages (reviewLabels).
 */
export async function withReviewFilters(
  defaultFilter: PageFilter,
  open: () => Promise<ScanPageInput[] | null>,
  options: { adjustment?: PageAdjustment; purpose?: ReviewPurpose } = {},
): Promise<{ pages: ScanPageInput[] | null; filters: PageFilter[] }> {
  const adjustment = options.adjustment && !isDefaultAdj(options.adjustment) ? { ...options.adjustment } : undefined;
  const mine: Session = { defaultFilter, adjustment, purpose: options.purpose, all: null, perPage: new Map() };
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

// ── What the review says ─────────────────────────────────────────────────────

const pagesWord = (n: number) => (n === 1 ? '1 page' : `${n} pages`);

/**
 * The review's header title, confirm button and caption for the page at
 * `index` of `count` captured, given what it is for. `doneLabel` is the
 * camera's own (CaptureOptions.doneLabel, "Save" by default), used when no
 * purpose names it. `found` false adds that the whole photo is kept.
 */
export function reviewLabels(
  purpose: ReviewPurpose | undefined,
  count: number,
  index: number,
  doneLabel: string,
  found = true,
): { title: string; doneLabel: string; caption: string } {
  const noEdges = found ? '' : ' · No edges found, whole photo kept';
  if (purpose?.kind === 'add') {
    const at = purpose.pageCount + index + 1;
    return {
      title: purpose.docName,
      doneLabel: count > 0 ? `Add ${pagesWord(count)}` : 'Add',
      caption: `New page ${at}${count > 1 ? ` · ${index + 1} of ${count}` : ''}${noEdges}`,
    };
  }
  if (purpose?.kind === 'replace') {
    const which = purpose.pageCount > 1 ? ` ${purpose.page + 1}` : '';
    return {
      title: `Retake page${which}`,
      doneLabel: 'Replace page',
      caption: `New page${which}${noEdges}`,
    };
  }
  return {
    title: pagesWord(count),
    doneLabel,
    caption: `${count > 1 ? `Page ${index + 1} of ${count}` : 'Page 1'}${noEdges}`,
  };
}

// ── Where the review starts ──────────────────────────────────────────────────

/**
 * The filter every page of `doc` shares, or null when they differ (or there
 * are none). `filters` absent means every page is Original. Pass the record
 * the viewer shows (pending bakes overlaid), so a filter still being applied
 * counts as the page's.
 */
export function sharedFilter(doc: Pick<Document, 'pages' | 'filters'>): PageFilter | null {
  const n = doc.pages.length;
  if (n === 0) return null;
  const first = doc.filters?.[0] ?? 'original';
  for (let i = 1; i < n; i++) if ((doc.filters?.[i] ?? 'original') !== first) return null;
  return first;
}

/**
 * The filter Add pages starts at: the document's own when all its pages share
 * one (Original included: a document kept as photographed gets matching new
 * pages), else `fallback` (Scan settings' default filter).
 */
export function addPagesFilter(doc: Pick<Document, 'pages' | 'filters'>, fallback: PageFilter): PageFilter {
  return sharedFilter(doc) ?? fallback;
}

/**
 * The look Retake starts at: the replaced page's filter and adjustments, so
 * the new capture looks like the page it replaces. `adjustment` is undefined
 * when the page has none.
 */
export function retakeLook(doc: Pick<Document, 'pages' | 'filters' | 'adjustments'>, index: number): { filter: PageFilter; adjustment: PageAdjustment | undefined } {
  const filter = doc.filters?.[index] ?? 'original';
  const adj = doc.adjustments?.[index];
  return { filter, adjustment: isDefaultAdj(adj) ? undefined : { ...adj! } };
}

// ── Previews ─────────────────────────────────────────────────────────────────

/** Not a document: bake jobs need an id and index only to group their work. */
const REVIEW_DOC = 'capture-review';
const tileCache = new Map<string, string[]>();
const pageCache = new Map<string, string>();
const PAGE_CACHE_MAX = 24;

const adjKey = (a: PageAdjustment | undefined) =>
  (isDefaultAdj(a) ? '' : `|${a!.brightness},${a!.contrast},${a!.saturation},${a!.sharpness ?? 0}`);

/** Filter tiles (one per PREVIEW_FILTERS entry, data URLs) for the preview image `src`, each with `adjustment`. */
export async function reviewTilePreviews(src: string, adjustment?: PageAdjustment): Promise<string[]> {
  const adj = isDefaultAdj(adjustment) ? undefined : adjustment;
  const key = `${keyOf(src)}${adjKey(adj)}`;
  const hit = tileCache.get(key);
  if (hit) return hit;
  const reply = await enqueueBake(
    {
      docId: REVIEW_DOC,
      pageIndex: 0,
      src: keyOf(src),
      ops: [],
      previews: PREVIEW_FILTERS.map(f => combinedFilterRN(f, adj) ?? []),
      previewWidth: 360,
    },
    { priority: 'high' },
  );
  const urls = JSON.parse(reply.replace(/^PREVIEWS:/, '')) as string[];
  tileCache.set(key, urls);
  return urls;
}

/** The preview image `src` with `filter` (and `adjustment`) applied (a data URL), or `src` itself when that changes nothing. */
export async function reviewPagePreview(src: string, filter: PageFilter, adjustment?: PageAdjustment): Promise<string> {
  const adj = isDefaultAdj(adjustment) ? undefined : adjustment;
  const ops = combinedFilterRN(filter, adj);
  if (!ops) return src;
  const key = `${keyOf(src)}|${filter}${adjKey(adj)}`;
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
