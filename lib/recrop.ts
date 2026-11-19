// lib/recrop.ts
// The viewer's Crop, end to end: re-crop a page from its source photo (or,
// without one, from its unfiltered image — lib/page-source.ts recropPage),
// bake the page's filter back in, and Undo.
//
// recropPage writes the page's new UNFILTERED pixels (.orig and page). The
// page keeps its recorded filter/adjustments, so afterwards they are baked
// back in (rebakeAfterCrop). Until that bake lands the page shows unfiltered
// pixels — the crop screen stays open over it meanwhile — and should the app
// die first, the startup self-heal finds the page (identical to its .orig with
// a look recorded: lib/storage.ts pendingBakeMigrations) and bakes it.
//
// Undo: a crop from a valid source is undone by re-cropping that source to
// the previous corners. A crop that replaced pixels no source can give back
// — starting again from the original photo (which drops a signature or
// markup), or cropping an edited page whose original photo is kept aside —
// is undone by putting back the copy of the page recropPage kept
// (lib/page-source.ts takeCropStash).
import { File } from 'expo-file-system';
import { Document, PageAdjustment } from '../types/document';
import { bakePage, pendingBakesFor, subscribeBakeChanges } from './bake';
import { pageLayoutGeneration, restorePageWithShadow } from './files';
import {
  cropTargetFor,
  discardCropStash,
  recropPage,
  sameStamp,
  takeCropStash,
  unfilteredStamp,
  type CropStash,
  type CropTarget,
} from './page-source';
import { sameGeometry, type PageGeometry } from './quad';

const isDefaultAdj = (a: PageAdjustment | undefined) =>
  !a || (!a.brightness && !a.contrast && !a.saturation && !(a as { sharpness?: number }).sharpness);

/**
 * Re-crops page `index` of `fresh` (the record read under the page lock) and
 * returns the patch for it. Call inside runPageEdit(docId, { pages: [index] }).
 */
export async function recropPatch(
  fresh: Document,
  index: number,
  target: CropTarget,
  geometry: PageGeometry,
  keepSource: boolean,
): Promise<Partial<Document>> {
  if (index < 0 || index >= fresh.pages.length) throw new Error('recrop: no such page');
  const uri = target.restore
    ? restoreStashedPage(fresh.id, index, target.restore)
    : await recropPage(fresh.id, index, target, geometry, { keepSource });
  const pages = [...fresh.pages];
  pages[index] = uri;
  return { pages };
}

/** Resolves once page `index` of `docId` has no bake queued or running (or after `timeoutMs`). */
function waitForPageBake(docId: string, index: number, timeoutMs: number): Promise<void> {
  if (!pendingBakesFor(docId).has(index)) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const unsubscribe = subscribeBakeChanges(changed => {
      if (changed === docId && !pendingBakesFor(docId).has(index)) done();
    });
    const timer = setTimeout(done, timeoutMs);
  });
}

/**
 * Bakes page `index`'s look back into its freshly cropped pixels, and resolves
 * when they are written. A bake already pending for the page was re-targeted by
 * the crop's page edit and redoes itself from the new .orig: then this only
 * waits for it. Never rejects (the self-heal covers a failed bake).
 */
export async function rebakeAfterCrop(doc: Document, index: number, timeoutMs = 30_000): Promise<void> {
  try {
    if (pendingBakesFor(doc.id).has(index)) {
      await waitForPageBake(doc.id, index, timeoutMs);
      return;
    }
    const filter = doc.filters?.[index] ?? 'original';
    const adjustment = doc.adjustments?.[index];
    if (filter === 'original' && isDefaultAdj(adjustment)) return;
    let stopTimer = () => {};
    try {
      await Promise.race([
        bakePage(doc.id, index, filter, adjustment, { priority: 'high' }),
        new Promise<void>(resolve => {
          const t = setTimeout(resolve, timeoutMs);
          stopTimer = () => clearTimeout(t);
        }),
      ]);
    } finally {
      stopTimer();
    }
  } catch (err) {
    console.warn('rebakeAfterCrop', err);
  }
}

// ── Undo ────────────────────────────────────────────────────────────────────

/**
 * What Undo needs: the page's previous corners on its (now kept) source photo,
 * or (`stash`) the copy of the page as it was.
 */
export type CropUndo = { docId: string; index: number; geometry: PageGeometry; layout: number; stash?: CropStash };

export class CropUndoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CropUndoError';
  }
}

const CHANGED_SINCE = 'The page has been changed since, so the crop can’t be undone.';

/**
 * The Undo for a crop from `before` (the editor's target) to `after`, or null
 * when there is nothing to undo or it can't be done exactly. Call right after
 * the crop: it takes the copy of the page that crop kept, if any.
 */
export function cropUndoFor(docId: string, index: number, before: CropTarget, after: PageGeometry, keepSource: boolean): CropUndo | null {
  const stash = takeCropStash(docId, index);
  if (stash) return { docId, index, geometry: before.geometry, layout: pageLayoutGeneration(docId), stash };
  if (!before.hasSource && !keepSource) return null;
  if (sameGeometry(before.geometry, after)) return null;
  return { docId, index, geometry: before.geometry, layout: pageLayoutGeneration(docId) };
}

/** Throws away an Undo nobody will use (its copy of the page, if it kept one). */
export function discardCropUndo(undo: CropUndo | null | undefined): void {
  discardCropStash(undo?.stash);
}

/**
 * The target to re-crop for an Undo, read under the page lock. Throws
 * CropUndoError (with copy that is safe to show) when the pages moved since,
 * or the page lost its source (another edit changed it).
 */
export function undoTargetFor(undo: CropUndo): CropTarget {
  if (pageLayoutGeneration(undo.docId) !== undo.layout) {
    discardCropUndo(undo);
    throw new CropUndoError('The pages have been moved or deleted since, so the crop can’t be undone.');
  }
  if (undo.stash) {
    const page = new File(undo.stash.dir, 'page-0.jpg');
    if (!page.exists) throw new CropUndoError('The earlier version of the page is no longer available.');
    return { uri: page.uri, geometry: undo.geometry, hasSource: false, bytes: 0, md5: null, restore: undo.stash };
  }
  const target = cropTargetFor(undo.docId, undo.index);
  if (!target.hasSource) throw new CropUndoError(CHANGED_SINCE);
  return target;
}

/**
 * Puts the page copy `stash` back as page `index` (with its .orig, or none if
 * it had none), only while the page is still exactly what the crop wrote. Its
 * source files are left alone: their stamp decides whether they describe the
 * page again. Runs under the page lock (recropPatch). Single use.
 */
function restoreStashedPage(docId: string, index: number, stash: CropStash): string {
  if (!sameStamp(unfilteredStamp(docId, index), stash.written)) {
    discardCropStash(stash);
    throw new CropUndoError(CHANGED_SINCE);
  }
  const uri = restorePageWithShadow(new File(stash.dir, 'page-0.jpg').uri, docId, index);
  discardCropStash(stash);
  return uri;
}
