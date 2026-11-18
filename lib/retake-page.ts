// lib/retake-page.ts
//
// "Retake page N": replaces one page of a document, in place, with a new
// capture (or photo), through the same pipeline a new page goes through —
// auto-crop for library photos, the user's scan quality, then (finishAddedPages)
// their default filter and a refreshed text index.
//
// The old page is stashed first (lib/page-undo), so the viewer can offer Undo,
// and its `.orig` shadow is removed: the new pixels are unfiltered, so the
// first filter bake must take its original from them, not from the old photo.
import { Directory, File, Paths } from 'expo-file-system';
import { Document, PageAdjustment, PageFilter } from '../types/document';
import {
  copyPageWithQuality,
  deleteDisposableTemps,
  isScannerOutput,
  pageLayoutGeneration,
  replacePage,
  restorePageWithShadow,
} from './files';
import { getDocument, updateDocument } from './storage';
import { bakePage, pendingBakesFor, runPageEdit } from './bake';
import { autoCropDocument } from './document-detect';
import { stashPage } from './page-undo';

const DEFAULT_ADJ: PageAdjustment = { brightness: 0, contrast: 0, saturation: 0 };
/** Scratch "document" the new pixels are encoded into before they replace the page. */
const STAGING_ID = '.retake-staging';

/** What Undo needs to put the replaced page back exactly as it was. */
export type RetakeUndo = {
  stash: string;
  filter: PageFilter;
  adjustment: PageAdjustment;
  /**
   * The document's page layout when the page was replaced (files.ts
   * pageLayoutGeneration). After a reorder or delete the index points at a
   * different page, which Undo must not overwrite.
   */
  layout: number;
};

export type RetakeResult = { doc: Document; undo: RetakeUndo | null };

export class RetakeError extends Error {
  constructor(readonly kind: 'missing-page' | 'pages-moved' | 'expired', message: string) {
    super(message);
    this.name = 'RetakeError';
  }
}

/** Sets entry `index` of a per-page list, materialising the list when it's absent. */
function setAt<T>(list: T[] | undefined, length: number, index: number, value: T, fill: () => T): T[] {
  const out = Array.from({ length }, (_, i) => list?.[i] ?? fill());
  out[index] = value;
  return out;
}

const isOriginalFilter = (f: PageFilter) => f === 'original';
const isDefaultAdj = (a: PageAdjustment) => !a.brightness && !a.contrast && !a.saturation;

/**
 * Replaces page `index` of `docId` with `uri`. The page keeps its position;
 * its filter and adjustments are reset (the caller bakes the default filter
 * afterwards with finishAddedPages). Temp inputs are deleted once stored.
 */
export async function retakePage(
  docId: string,
  index: number,
  uri: string,
  quality: number,
  options: { autoCrop?: boolean } = {},
): Promise<RetakeResult> {
  // Auto-crop before taking the page lock: it's slow and touches no stored file.
  const crop = options.autoCrop ?? !isScannerOutput(uri);
  const input = crop ? (await autoCropDocument(uri, quality)).uri : uri;

  try {
    const result = await runPageEdit(docId, { pages: [index] }, async () => {
      const current = await getDocument(docId);
      if (!current) throw new Error('document missing');
      const n = current.pages.length;
      if (index < 0 || index >= n) throw new RetakeError('missing-page', 'That page no longer exists.');

      // Encode first, away from the document: a failure here leaves the page untouched.
      const staged = await copyPageWithQuality(input, STAGING_ID, 0, quality);

      let undo: RetakeUndo | null = null;
      try {
        undo = {
          stash: stashPage(docId, index),
          filter: current.filters?.[index] ?? 'original',
          adjustment: current.adjustments?.[index] ?? { ...DEFAULT_ADJ },
          layout: pageLayoutGeneration(docId),
        };
      } catch (err) {
        console.warn('Retake undo stash failed', err);
      }

      // Shadow first: if the app dies between the two steps the old page is
      // left without a shadow (harmless), never the new page paired with the
      // old photo's shadow (a later filter change would bring the old page back).
      const dir = new Directory(Paths.document, 'scan-kit', docId);
      const shadow = new File(dir, `page-${index}.orig.jpg`);
      if (shadow.exists) shadow.delete();
      const pageUri = replacePage(staged, docId, index);

      const pages = [...current.pages];
      pages[index] = pageUri;
      const filters = setAt<PageFilter>(current.filters, n, index, 'original', () => 'original');
      const adjustments = setAt<PageAdjustment>(current.adjustments, n, index, { ...DEFAULT_ADJ }, () => ({ ...DEFAULT_ADJ }));
      const doc: Document = {
        ...current,
        pages,
        filters: filters.every(isOriginalFilter) ? undefined : filters,
        adjustments: adjustments.every(isDefaultAdj) ? undefined : adjustments,
        updatedAt: Date.now(),
      };
      if (!(await updateDocument(doc))) throw new Error('document missing');
      return { doc, undo };
    });
    supersedeStaleBake(docId, index);
    return result;
  } finally {
    deleteDisposableTemps([uri, input]);
    try {
      const staging = new Directory(Paths.document, 'scan-kit', STAGING_ID);
      if (staging.exists) staging.delete();
    } catch {}
  }
}

/**
 * A filter bake that was already running for the page when it was replaced
 * would follow the page and bake its OLD filter into the new photo (the edit
 * only makes it start over from the new pixels). The new page is 'original'
 * until the caller bakes the default filter, so a bake of 'original' takes the
 * stale one's place; the caller's own bake, if any, supersedes it in turn.
 */
function supersedeStaleBake(docId: string, index: number): void {
  if (!pendingBakesFor(docId).has(index)) return;
  bakePage(docId, index, 'original', undefined).catch(err => console.warn('Retake: superseding bake failed', err));
}

/**
 * Undo for retakePage: puts the stashed page (and its shadow) back at `index`
 * with the filter and adjustments it had. Refuses (RetakeError) when the pages
 * have been reordered or deleted since — `index` would now be another page —
 * or when the saved copy is gone (replaced by a later delete or retake, or
 * purged with the cache). Nothing is changed then.
 */
export async function undoRetake(docId: string, index: number, undo: RetakeUndo): Promise<Document> {
  return runPageEdit(docId, { pages: [index] }, async () => {
    if (pageLayoutGeneration(docId) !== undo.layout) {
      throw new RetakeError('pages-moved', 'The pages have been moved or deleted since, so the replaced page can’t be put back.');
    }
    const current = await getDocument(docId);
    if (!current) throw new Error('document missing');
    const n = current.pages.length;
    if (index >= n) throw new RetakeError('missing-page', 'That page no longer exists.');
    if (!new File(undo.stash.split('?')[0]).exists) {
      throw new RetakeError('expired', 'The replaced page is no longer available to put back.');
    }
    const pageUri = restorePageWithShadow(undo.stash, docId, index);
    const pages = [...current.pages];
    pages[index] = pageUri;
    const filters = setAt<PageFilter>(current.filters, n, index, undo.filter, () => 'original');
    const adjustments = setAt<PageAdjustment>(current.adjustments, n, index, undo.adjustment, () => ({ ...DEFAULT_ADJ }));
    const doc: Document = {
      ...current,
      pages,
      filters: filters.every(isOriginalFilter) ? undefined : filters,
      adjustments: adjustments.every(isDefaultAdj) ? undefined : adjustments,
      updatedAt: Date.now(),
    };
    if (!(await updateDocument(doc))) throw new Error('document missing');
    return doc;
  });
}
