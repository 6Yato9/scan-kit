// lib/bake.ts
//
// Orchestrates baking a filter into a page's actual JPEG pixels. Always
// bakes FROM the pristine .orig copy (see lib/files.ts's ensureOriginal),
// never from the current page-N.jpg — that keeps repeated filter changes
// from compounding JPEG generation loss and keeps "Original" reachable.
//
// Ordering matters: the filter is only recorded in storage AFTER the baked
// pixels have been written to disk (setPageBaked). If the bake or the write
// fails, nothing is recorded, so pixels and metadata never disagree, and a page
// export racing an in-flight bake yields unenhanced (not wrong) output. That is
// why new pages are always saved as 'original' and get their default filter
// only through a bake (contexts/scan-context.tsx, lib/add-pages.ts). Should the
// two ever disagree anyway, the startup self-heal finds the page by comparing
// it with its .orig (lib/storage.ts pendingBakeMigrations).
//
// CONCURRENT EDITS. A bake takes a moment, and the user keeps editing while it
// runs: deleting or reordering pages renames every page file, and rotate, crop
// and annotate replace one. Every such edit runs through `runPageEdit`, which
// holds a per-document lock and then tells each in-flight bake what happened:
//  - its page moved → the bake follows it to the new index;
//  - its page was deleted → the bake is dropped;
//  - its page's pixels changed (or it moved while running) → the bake is
//    redone from the updated .orig, so the edit is never undone.
// The final write + metadata record happen under the same lock, so an edit can
// never interleave with them. A newer bake for the same page supersedes an
// older one, so the user's latest choice always wins.
import { Directory, Paths } from 'expo-file-system';
import { writeAsStringAsync } from 'expo-file-system/legacy';
import { PageAdjustment, PageFilter } from '../types/document';
import { BakeCancelled, cancelJob, EnqueueOptions, enqueueBake, enqueueBakeWithId } from './bake-queue';
import { ensureOriginal, pageSideUri, promotePageSide } from './files';
import { combinedFilterRN } from './filters';
import { capStoredPageSize } from './image';
import { setPageBaked } from './storage';

const DATA_URL_PREFIX = /^data:image\/jpeg;base64,/;

// ── Per-document lock ───────────────────────────────────────────────────────

const locks = new Map<string, Promise<unknown>>();

/** Runs `fn` exclusively with respect to other page edits and bake writes on `docId`. */
export function withDocLock<T>(docId: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = locks.get(docId) ?? Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.then(() => undefined, () => undefined);
  locks.set(docId, tail);
  void tail.then(() => {
    if (locks.get(docId) === tail) locks.delete(docId);
  });
  return run;
}

// ── In-flight bake tracking ─────────────────────────────────────────────────

type Ticket = {
  docId: string;
  /** Current index of the page this bake is for; -1 once the page is deleted. */
  pageIndex: number;
  /** Bumped whenever the page moves or its pixels change under the bake. */
  gen: number;
  superseded: boolean;
  jobId: number | null;
  filter: PageFilter;
  adjustment: PageAdjustment | undefined;
};

const tickets = new Set<Ticket>();
const docVersions = new Map<string, number>();

/** Maps a page's old index to its new one, or -1 when the page was removed. */
export type PageRemap = (oldIndex: number) => number;

export type PageEdit = {
  /** Pages were deleted, inserted before others, or reordered. */
  remap?: PageRemap;
  /** These pages' pixels (and their .orig) were changed in place. */
  pages?: number[];
};

function applyEdit(docId: string, edit: PageEdit): void {
  docVersions.set(docId, (docVersions.get(docId) ?? 0) + 1);
  if (edit.remap) invalidateDocPreviews(docId);
  for (const idx of edit.pages ?? []) invalidatePreviews(docId, idx);

  for (const t of tickets) {
    if (t.docId !== docId || t.pageIndex < 0) continue;
    const before = t.pageIndex;
    const after = edit.remap ? edit.remap(before) : before;
    const touched = edit.pages?.includes(before) ?? false;
    if (after === before && !touched) continue;
    t.pageIndex = after;
    t.gen++;
    // A queued job would load a source file that now belongs to another page
    // (or has new pixels); a running one would write stale output. Either way
    // withdraw it; bakePage re-enqueues for the page's new index.
    if (t.jobId !== null) cancelJob(t.jobId);
  }
  emitChange(docId);
}

/**
 * Runs a page-structure or page-pixel edit for `docId` under the document lock,
 * then re-targets any in-flight bakes accordingly (see the header comment).
 * Never call bakePage from inside `fn` and await it — that would deadlock.
 */
export async function runPageEdit<T>(docId: string, edit: PageEdit, fn: () => Promise<T> | T): Promise<T> {
  return withDocLock(docId, async () => {
    try {
      return await fn();
    } finally {
      // Even a failed edit may have touched files; treat it as having changed them.
      applyEdit(docId, edit);
    }
  });
}

/** Remap for deleting the page at `index`. */
export function remapForDelete(index: number): PageRemap {
  return old => (old === index ? -1 : old > index ? old - 1 : old);
}

/** Remap for a reorder where `newOrder[newIndex] = oldIndex`. */
export function remapForReorder(newOrder: number[]): PageRemap {
  const inverse = new Map<number, number>();
  newOrder.forEach((oldIdx, newIdx) => inverse.set(oldIdx, newIdx));
  return old => inverse.get(old) ?? -1;
}

/**
 * The filter/adjustment each page of `docId` is still waiting on, keyed by the
 * page's current index. The viewer overlays these on the stored document so the
 * picker shows the user's latest choice while the pixels catch up.
 */
export function pendingBakesFor(docId: string): Map<number, { filter: PageFilter; adjustment: PageAdjustment | undefined }> {
  const out = new Map<number, { filter: PageFilter; adjustment: PageAdjustment | undefined }>();
  for (const t of tickets) {
    if (t.docId === docId && !t.superseded && t.pageIndex >= 0) {
      out.set(t.pageIndex, { filter: t.filter, adjustment: t.adjustment });
    }
  }
  return out;
}

/** True while any page of `docId` has a bake queued or running. */
export function hasPendingBakes(docId: string): boolean {
  for (const t of tickets) if (t.docId === docId && !t.superseded && t.pageIndex >= 0) return true;
  return false;
}

const changeListeners = new Set<(docId: string) => void>();

/**
 * Notified whenever a document's bakes change state: a bake finished (pixels and
 * metadata written), was dropped, or was re-targeted by an edit. The viewer uses
 * it to reload the document so finished pages actually appear.
 */
export function subscribeBakeChanges(fn: (docId: string) => void): () => void {
  changeListeners.add(fn);
  return () => { changeListeners.delete(fn); };
}

function emitChange(docId: string): void {
  changeListeners.forEach(fn => {
    try { fn(docId); } catch (err) { console.error('bake change listener', err); }
  });
}

// ── Baking ───────────────────────────────────────────────────────────────────

const MAX_ROUNDS = 6;

/**
 * Bakes `filter` + `adjustment` into page `pageIndex` of `docId`.
 *
 * Resolves true once the pixels are written and recorded, false when the bake
 * became moot (page deleted, document gone, or a newer bake for the same page
 * superseded it). Rejects only on a genuine bake/write failure.
 */
export async function bakePage(
  docId: string,
  pageIndex: number,
  filter: PageFilter,
  adjustment: PageAdjustment | undefined,
  options: EnqueueOptions = {},
): Promise<boolean> {
  // Latest request for a page wins: withdraw any older one still waiting.
  for (const t of tickets) {
    if (t.docId === docId && t.pageIndex === pageIndex && !t.superseded) {
      t.superseded = true;
      if (t.jobId !== null) cancelJob(t.jobId);
    }
  }
  const ticket: Ticket = {
    docId, pageIndex, gen: 0, superseded: false, jobId: null, filter, adjustment,
  };
  tickets.add(ticket);

  try {
    // combinedFilterRN already yields the primitive list ([{grayscale:1},{contrast:2}]);
    // the bake canvas applies those with explicit pixel maths, because ctx.filter is
    // a silent no-op in this WebKit.
    const ops = combinedFilterRN(filter, adjustment) ?? [];

    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (ticket.superseded || ticket.pageIndex < 0) return false;
      const gen = ticket.gen;
      const idx = ticket.pageIndex;

      let dataUrl: string;
      try {
        const src = await withDocLock(docId, async () => {
          const orig = ensureOriginal(docId, idx);
          // Pages stored before imports were capped can be too big for the
          // bake canvas; shrink them (and their shadow) once, first.
          await capStoredPageSize(docId, idx);
          return orig;
        });
        if (ticket.gen !== gen || ticket.superseded) continue;
        const { id, promise } = enqueueBakeWithId({ docId, pageIndex: idx, src, ops }, options);
        ticket.jobId = id;
        dataUrl = await promise;
      } catch (err) {
        if (err instanceof BakeCancelled) continue;
        throw err;
      } finally {
        ticket.jobId = null;
      }

      const outcome = await withDocLock(docId, async (): Promise<'done' | 'retry' | 'dropped'> => {
        if (ticket.superseded || ticket.pageIndex < 0) return 'dropped';
        if (ticket.gen !== gen) return 'retry';
        const dir = new Directory(Paths.document, 'scan-kit', docId);
        if (!dir.exists) return 'dropped'; // document deleted mid-bake
        // Written beside the page and renamed over it, so a crash mid-write
        // can't leave a truncated page (the startup sweep finishes the rename).
        await writeAsStringAsync(pageSideUri(docId, idx), dataUrl.replace(DATA_URL_PREFIX, ''), { encoding: 'base64' });
        promotePageSide(docId, idx);
        await setPageBaked(docId, idx, filter, adjustment);
        return 'done';
      });
      if (outcome === 'done') return true;
      if (outcome === 'dropped') return false;
    }
    return false;
  } finally {
    tickets.delete(ticket);
    emitChange(docId);
  }
}

/**
 * Bakes `filter` into several pages of one document (a fresh scan, added pages).
 *
 * All pages are requested at once rather than one after another: the queue
 * still runs them one at a time, but every page is tracked from the start, so
 * an edit made while they run (deleting page 2 of 4) re-targets the rest instead
 * of a sequential loop baking stale indices. Per-page failures are logged and
 * leave that page with its raw pixels, which is a consistent state.
 */
export async function bakePages(docId: string, indices: number[], filter: PageFilter): Promise<void> {
  if (filter === 'original') return;
  await Promise.all(indices.map(i =>
    bakePage(docId, i, filter, undefined).catch(err => {
      console.error('Bake failed for page', i, err);
      return false;
    }),
  ));
}

/** Filters offered by the picker, in display order. */
export const PREVIEW_FILTERS: PageFilter[] = ['original', 'grayscale', 'bw', 'enhanced'];

// Previews derive from page-N.orig.jpg, which only changes when the page's
// geometry does — not when a filter is applied — so they are cached per page and
// invalidated when the page itself changes (see applyEdit).
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

  const version = docVersions.get(docId) ?? 0;
  const src = await withDocLock(docId, () => ensureOriginal(docId, pageIndex));
  const opsList = PREVIEW_FILTERS.map(f => combinedFilterRN(f, undefined) ?? []);
  const reply = await enqueueBake(
    { docId, pageIndex, src, ops: [], previews: opsList, previewWidth: 120 },
    { priority: 'high' },
  );
  const urls = JSON.parse(reply.replace(/^PREVIEWS:/, '')) as string[];
  // An edit landed while this rendered: the result may describe another page.
  if ((docVersions.get(docId) ?? 0) === version) previewCache.set(key, urls);
  return urls;
}
