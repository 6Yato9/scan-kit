// lib/add-pages.ts
//
// Appends newly scanned or imported pages to an existing document through the
// same pipeline a new scan goes through: auto-crop for library photos, the
// user's scan quality, the filter chosen in the camera's review (or the
// default one — lib/review-filter.ts addPagesFilter; baked, then recorded),
// and a refreshed text index.
//
// Each page may be a finished image URI or a photo with its page outline
// (SourcePageInput, see lib/save-scan.ts and lib/page-source.ts): then the page
// is rendered from the photo and the photo is kept as its source. A library
// photo passed as a plain URI gets the same treatment when page detection is
// available: its outline is found (detectQuad) and the photo is kept, so its
// crop can be widened later.
import { File } from 'expo-file-system';
import { docDir } from './storage-layout';
import { Document, PageAdjustment, PageFilter } from '../types/document';
import { copyPageWithQuality, deleteDisposableTemps, isScannerOutput, moveScannerOutputToCaches } from './files';
import { PAGE_SHADOW_SUFFIXES } from './page-family';
import { getDocument, keepSourcesEnabled, updateDocumentWith } from './storage';
import { bakePage, bakePages, runPageEdit } from './bake';
import { indexDocText } from './save-scan';
import { autoCropDocument } from './document-detect';
import { addPagesUndoToken, type AddPagesUndo } from './add-pages-undo';
import {
  canDetectQuad,
  detectQuad,
  discardPrepared,
  inputUri,
  installPreparedSource,
  isSourceInput,
  prepareSourcePage,
  type PreparedSourcePage,
  type ScanPageInput,
  type SourcePageInput,
} from './page-source';

export type AddPagesResult = {
  doc: Document;
  added: number[];
  /** Undo's fingerprint of the added pages (lib/add-pages-undo.ts); null when none can be offered. */
  undo: AddPagesUndo | null;
};

export type AddPagesOptions = {
  /**
   * Find the page in each photo and straighten it (lib/document-detect). By
   * default every input except the document scanner's own output is cropped —
   * the scanner has already done it, with the user's own corner adjustments.
   * Ignored for SourcePageInput pages (they carry their own outline).
   */
  autoCrop?: boolean;
};

/**
 * What a page input becomes before it is stored: a photo with its outline
 * (kept as the page's source) when page detection is available, else a
 * finished image (auto-cropped the old way, or as is).
 */
export async function resolvePageInput(
  page: ScanPageInput,
  quality: number,
  autoCrop: boolean | undefined,
): Promise<ScanPageInput> {
  if (isSourceInput(page)) return page;
  const crop = autoCrop ?? !isScannerOutput(page);
  if (!crop) return page;
  if (canDetectQuad()) {
    const source: SourcePageInput = { sourceUri: page, quad: await detectQuad(page) };
    return source;
  }
  return (await autoCropDocument(page, quality)).uri;
}

/** Removes any shadow (.orig, source photo, geometry) left at `index` by an older edit. */
export function clearStaleShadows(dir: ReturnType<typeof docDir>, index: number): void {
  for (const suffix of PAGE_SHADOW_SUFFIXES) {
    const stale = new File(dir, `page-${index}${suffix}`);
    if (stale.exists) stale.delete();
  }
}

/**
 * Copies `uris` into `docId` as new trailing pages (recompressed at `quality`,
 * capped in size) and records them on the CURRENT stored document — read fresh
 * under the page lock, so a filter that finished baking a moment ago isn't
 * overwritten with an older in-memory copy. Returns the updated document and
 * the new page indices.
 *
 * All or nothing: if any page fails to copy, the pages already written for this
 * call are removed again, so a retry starts clean and the document never
 * gains files it doesn't list. Temp inputs (scanner, picker, auto-crop output)
 * are deleted once stored.
 *
 * Applying the default filter and re-indexing text are started afterwards and
 * not awaited (see finishAddedPages).
 */
export async function addPagesToDocument(
  docId: string,
  rawPages: ScanPageInput[],
  quality: number,
  options: AddPagesOptions = {},
): Promise<AddPagesResult> {
  // Scanner pages land in Documents (shown in the Files app): out of there
  // first, whoever called (the viewer passes the scanner's result straight in).
  const pages = rawPages.map(p => (isSourceInput(p) ? p : moveScannerOutputToCaches([p])[0]));
  // Auto-crop / render before taking the page lock: slow, and touches no
  // stored file.
  let keep: boolean | null = null; // read only when a page keeps a source
  const inputs: string[] = [];
  const prepared: (PreparedSourcePage | null)[] = [];
  const temps: string[] = pages.map(inputUri);
  try {
    for (const page of pages) {
      const resolved = await resolvePageInput(page, quality, options.autoCrop);
      if (isSourceInput(resolved)) {
        keep ??= await keepSourcesEnabled();
        const p = await prepareSourcePage(resolved, quality, keep);
        prepared.push(p);
        inputs.push(p.page);
      } else {
        prepared.push(null);
        inputs.push(resolved);
        temps.push(resolved);
      }
    }
  } catch (err) {
    prepared.forEach(discardPrepared);
    throw err;
  }

  const result = await runPageEdit(docId, {}, async () => {
    const current = await getDocument(docId);
    if (!current) throw new Error('document missing');
    const start = current.pages.length;
    const dir = docDir(docId);
    const stored: string[] = [];
    try {
      for (let i = 0; i < inputs.length; i++) {
        // A shadow left at this index by an older edit would be taken for the
        // new page's unfiltered original by its first bake (or its source).
        clearStaleShadows(dir, start + i);
        const p = prepared[i];
        // A page rendered from its photo is already at `quality`.
        stored.push(await copyPageWithQuality(inputs[i], docId, start + i, p ? 1 : quality));
        if (p) installPreparedSource(p, docId, start + i);
      }
      const pad = <T,>(arr: T[] | undefined, fill: () => T): T[] | undefined =>
        arr ? [...arr, ...stored.map(fill)] : undefined;
      // Only the fields this edit changes are written, merged onto the stored
      // record, so nothing else written meanwhile (a rename, the text index)
      // is replaced by this call's older copy.
      const patch: Partial<Document> = {
        pages: [...current.pages, ...stored],
        filters: pad<PageFilter>(current.filters, () => 'original'),
        adjustments: pad<PageAdjustment>(current.adjustments, () => ({ brightness: 0, contrast: 0, saturation: 0 })),
        updatedAt: Date.now(),
      };
      let doc: Document | null = null;
      const written = await updateDocumentWith(docId, latest => {
        doc = { ...latest, ...patch };
        return patch;
      });
      if (!written || !doc) throw new Error('document missing');
      // Taken under the same lock, right after the write (as merge Undo does).
      let undo: AddPagesUndo | null = null;
      try {
        undo = addPagesUndoToken(docId, start, stored.length);
      } catch (err) {
        console.warn('Add pages: no undo', err);
      }
      return { doc: doc as Document, added: stored.map((_, i) => start + i), undo };
    } catch (err) {
      for (let i = 0; i < inputs.length; i++) {
        try {
          const f = new File(dir, `page-${start + i}.jpg`);
          if (f.exists) f.delete();
          clearStaleShadows(dir, start + i);
        } catch {}
      }
      throw err;
    }
  }).finally(() => {
    prepared.forEach(discardPrepared);
  });

  deleteDisposableTemps(temps);
  return result;
}

/**
 * Bakes the chosen look into the new pages, then refreshes the text index.
 * `filter` is one filter for every page in `added`, or one per page (the
 * camera review's choice, in `added`'s order). `adjustments`, when given,
 * are baked with them, page by page (a retake keeps the replaced page's).
 * Pages were stored as 'original', so the bake is what records the look
 * (lib/bake.ts): a page left Original with no adjustment needs no bake.
 */
export function finishAddedPages(
  doc: Document,
  added: number[],
  filter: PageFilter | PageFilter[],
  adjustments?: (PageAdjustment | undefined)[],
  options: {
    /** Called once this call's bake has written page `index` (Add pages' Undo notes the new file, lib/add-pages-undo.ts). */
    onBaked?: (index: number) => void;
  } = {},
): void {
  const { onBaked } = options;
  (async () => {
    const looks = addedLooks(added, filter, adjustments);
    const bakeOne = (l: { index: number; filter: PageFilter; adjustment?: PageAdjustment }) =>
      bakePage(doc.id, l.index, l.filter, l.adjustment)
        .then(written => {
          if (written) onBaked?.(l.index);
          return written;
        })
        .catch(err => {
          console.error('Bake failed for page', l.index, err);
          return false;
        });
    const plain = looks.filter(l => !l.adjustment);
    const adjusted = looks.filter(l => l.adjustment);
    await Promise.all([
      // Every page is requested at once, so each is tracked from the start:
      // one bakePages call per filter, or page by page when each written page
      // must be reported.
      ...(onBaked ? plain.map(bakeOne) : bakeGroupsFor(plain).map(g => bakePages(doc.id, g.indices, g.filter))),
      ...adjusted.map(bakeOne),
    ]);
    const fresh = await getDocument(doc.id);
    if (fresh) await indexDocText(fresh.id, fresh.pages);
  })().catch(err => console.error('finishAddedPages', err));
}

const isDefaultAdj = (a: PageAdjustment | undefined) => !a || (!a.brightness && !a.contrast && !a.saturation && !a.sharpness);

/** What each added page is baked with: Original pages with no adjustment are left out. Exported for tests. */
export function addedLooks(
  added: number[],
  filter: PageFilter | PageFilter[],
  adjustments?: (PageAdjustment | undefined)[],
): { index: number; filter: PageFilter; adjustment?: PageAdjustment }[] {
  const out: { index: number; filter: PageFilter; adjustment?: PageAdjustment }[] = [];
  added.forEach((index, k) => {
    const f = (Array.isArray(filter) ? filter[k] : filter) ?? 'original';
    const a = adjustments?.[k];
    const adjustment = isDefaultAdj(a) ? undefined : a;
    if (f === 'original' && !adjustment) return;
    out.push(adjustment ? { index, filter: f, adjustment } : { index, filter: f });
  });
  return out;
}

function bakeGroupsFor(looks: { index: number; filter: PageFilter }[]): { filter: PageFilter; indices: number[] }[] {
  const groups = new Map<PageFilter, number[]>();
  for (const l of looks) groups.set(l.filter, [...(groups.get(l.filter) ?? []), l.index]);
  return [...groups.entries()].map(([f, indices]) => ({ filter: f, indices }));
}
