// lib/merge-undo.ts
// Undo for merging.
//
// MERGING INTO AN EXISTING DOCUMENT (lib/doc-ops mergeIntoWithUndo) appends
// another document's pages, with their shadows (.orig, source photo, crop
// geometry), after the target's own. The source is only read, never written,
// so Undo has nothing to put back there: it takes the appended pages out of
// the target again — their files, shadows and recognised text — and nothing
// else.
//
// That is only safe while the appended pages are still exactly what the merge
// wrote, at the indices it wrote them. The merge records a fingerprint
// (MergeUndo): how many pages came before, how many were appended, the page
// layout generation (lib/files.ts: bumped by every reorder and delete) and
// each appended page file's identity (byte size + modification time, the same
// identity the OCR cache trusts; every edit that changes a page's pixels —
// filter bake, rotate, crop, mark-up, retake, stamp — writes a new file).
// Undo refuses, changing nothing, when:
//  - the document is gone, in Recently deleted, or no longer a scan;
//  - its page count differs (pages were added or deleted since);
//  - its pages were reordered or deleted (the layout generation moved);
//  - any appended page's file changed (it was edited after the merge).
// Edits to the target's OWN pages (before the appended ones) don't block it:
// taking trailing pages off leaves every other page's index unchanged.
//
// Undo runs under the document's page lock (runPageEdit) with a remap that
// drops the removed pages, so an in-flight filter bake for one of them is
// dropped and the cached filter previews are cleared (lib/bake.ts applyEdit).
//
// MERGES THAT MAKE A NEW DOCUMENT (Tools › Merge, Files' select mode, merging
// with an imported PDF) leave every original untouched; Undo removes the new
// document. It is a copy of pages that still exist in the originals, so when
// it is exactly as the merge saved it (same updatedAt) it is deleted outright
// — nothing is lost and Recently deleted doesn't fill with duplicates. If it
// was changed since (renamed, edited), it moves to Recently deleted instead,
// so that work can still be restored. The originals are never touched.
import { File } from 'expo-file-system';
import type { Document, PageAdjustment, PageFilter } from '../types/document';
import { docDir } from './storage-layout';
import { pageLayoutGeneration } from './files';
import { PAGE_FAMILY_SUFFIXES } from './page-family';
import { fileIdentity, pruneDocumentOcr } from './ocr-cache';
import { deleteForever, getDocument, trashDocument, updateDocumentWith } from './storage';
import { runPageEdit, withDocLock, type PageRemap } from './bake';
import { indexDocText } from './save-scan';

// ── Merging into an existing document ────────────────────────────────────────

/** What Undo needs to take a merge's pages out of the target again. */
export type MergeUndo = {
  docId: string;
  /** The target's page count before the merge: the appended pages start here. */
  start: number;
  /** How many pages the merge appended. */
  count: number;
  /** lib/files.ts pageLayoutGeneration right after the merge. */
  layout: number;
  /** File identity (lib/ocr-cache fileIdentity) of each appended page right after the merge. */
  identities: string[];
};

export type MergeUndoRefusal = 'missing' | 'pages-changed' | 'pages-edited';

export class MergeUndoError extends Error {
  constructor(readonly kind: MergeUndoRefusal) {
    super(`merge undo refused: ${kind}`);
    this.name = 'MergeUndoError';
  }
}

const pageFile = (docId: string, i: number) => new File(docDir(docId), `page-${i}.jpg`);

/** Identities of pages [start, start + count) of `docId`'s folder (null where unreadable). */
function identitiesOf(docId: string, start: number, count: number): (string | null)[] {
  return Array.from({ length: count }, (_, k) => fileIdentity(pageFile(docId, start + k).uri));
}

/**
 * The fingerprint of a merge that just appended `count` pages at `start` of
 * `docId`. Take it inside the merge's page lock, after the files are written.
 * Null when a page's identity can't be read (Undo couldn't verify it later,
 * so none is offered).
 */
export function mergeUndoToken(docId: string, start: number, count: number): MergeUndo | null {
  if (count <= 0) return null;
  const ids = identitiesOf(docId, start, count);
  if (ids.some(id => !id)) return null;
  return { docId, start, count, layout: pageLayoutGeneration(docId), identities: ids as string[] };
}

/**
 * Why Undo must refuse for `doc` as it is now (`now`: the layout generation
 * and the identities of the appended pages' files), or null when it may go
 * ahead. Pure, for tests.
 */
export function mergeUndoRefusal(
  undo: MergeUndo,
  doc: Pick<Document, 'pages' | 'pdfUri' | 'trashedAt'> | null,
  now: { layout: number; identities: (string | null)[] },
): MergeUndoRefusal | null {
  if (!doc || doc.trashedAt != null || doc.pdfUri) return 'missing';
  if (undo.start < 1 || undo.count < 1) return 'pages-changed';
  if (doc.pages.length !== undo.start + undo.count) return 'pages-changed';
  if (now.layout !== undo.layout) return 'pages-changed';
  if (now.identities.length !== undo.identities.length) return 'pages-edited';
  for (let k = 0; k < undo.identities.length; k++) {
    if (!now.identities[k] || now.identities[k] !== undo.identities[k]) return 'pages-edited';
  }
  return null;
}

/** The refusal for the stored record `doc`, reading the files now. */
export function checkMergeUndo(undo: MergeUndo, doc: Pick<Document, 'pages' | 'pdfUri' | 'trashedAt'> | null): MergeUndoRefusal | null {
  return mergeUndoRefusal(undo, doc, {
    layout: pageLayoutGeneration(undo.docId),
    identities: identitiesOf(undo.docId, undo.start, undo.count),
  });
}

/** The page remap for Undo (runPageEdit): the appended pages go, the others keep their index. */
export function mergeUndoRemap(undo: MergeUndo): PageRemap {
  return i => (i >= undo.start ? -1 : i);
}

const isDefaultAdj = (a: PageAdjustment) => !a.brightness && !a.contrast && !a.saturation && !a.sharpness;

/** The record fields once the appended pages are gone (per-page lists cut to `start`, collapsed when all default). */
export function trimmedPageMeta(doc: Pick<Document, 'pages' | 'filters' | 'adjustments'>, start: number): Pick<Document, 'pages' | 'filters' | 'adjustments'> {
  const pages = doc.pages.slice(0, start);
  const filters = doc.filters ? pages.map((_, i): PageFilter => doc.filters?.[i] ?? 'original') : undefined;
  const adjustments = doc.adjustments
    ? pages.map((_, i): PageAdjustment => doc.adjustments?.[i] ?? { brightness: 0, contrast: 0, saturation: 0 })
    : undefined;
  return {
    pages,
    filters: filters && filters.some(f => f !== 'original') ? filters : undefined,
    adjustments: adjustments && adjustments.some(a => !isDefaultAdj(a)) ? adjustments : undefined,
  };
}

/**
 * Removes the appended pages' files (each page with every shadow) and their
 * recognised text, and returns the record patch. Run it under the page lock
 * with mergeUndoRemap(undo), on the record read there; throws MergeUndoError
 * (having changed nothing) when Undo must refuse.
 */
export function removeMergedPages(fresh: Document, undo: MergeUndo): Pick<Document, 'pages' | 'filters' | 'adjustments'> {
  const refusal = checkMergeUndo(undo, fresh);
  if (refusal) throw new MergeUndoError(refusal);
  const dir = docDir(undo.docId);
  // Trailing pages: nothing after them shifts, so the other pages' files are
  // never renamed. The page goes first, its shadows after it, so an
  // interruption can't leave a page paired with a missing record entry.
  for (let i = undo.start; i < undo.start + undo.count; i++) {
    for (const suffix of PAGE_FAMILY_SUFFIXES) {
      try {
        const f = new File(dir, `page-${i}${suffix}`);
        if (f.exists) f.delete();
      } catch {}
    }
  }
  // Their recognised text must not stay behind in the folder (lib/ocr-cache).
  pruneDocumentOcr(undo.docId);
  return trimmedPageMeta(fresh, undo.start);
}

/**
 * Undo for a merge into `undo.docId`, from outside the viewer (Home, Files).
 * Returns the updated document; throws MergeUndoError when it must refuse.
 * The text index is refreshed afterwards, in the background.
 */
export async function undoMergeInto(undo: MergeUndo): Promise<Document> {
  const doc = await runPageEdit(undo.docId, { remap: mergeUndoRemap(undo) }, async () => {
    const fresh = await getDocument(undo.docId);
    // Checked before anything is touched.
    const refusal = checkMergeUndo(undo, fresh);
    if (refusal || !fresh) throw new MergeUndoError(refusal ?? 'missing');
    const patch = { ...removeMergedPages(fresh, undo), updatedAt: Date.now() };
    let next: Document | null = null;
    const written = await updateDocumentWith(undo.docId, latest => {
      next = { ...latest, ...patch };
      return patch;
    });
    if (!written || !next) throw new MergeUndoError('missing');
    return next as Document;
  });
  reindexAfterMergeUndo(doc);
  return doc;
}

/** The text index no longer holds the removed pages' words (outside the page lock). */
export function reindexAfterMergeUndo(doc: Pick<Document, 'id' | 'pages'>): void {
  indexDocText(doc.id, doc.pages).catch(err => console.warn('Re-index after merge undo failed', err));
}

/** What to tell the user when Undo refused. */
export function mergeUndoRefusalMessage(kind: MergeUndoRefusal): string {
  switch (kind) {
    case 'missing':
      return 'The document is no longer here, so the added pages can’t be taken out.';
    case 'pages-changed':
      return 'Pages have been added, moved or deleted since, so the merge can’t be undone.';
    case 'pages-edited':
      return 'The added pages have been edited since, so the merge can’t be undone. You can still delete them one by one.';
  }
}

// ── Merges that make a new document ──────────────────────────────────────────

/** What Undo needs to remove a document a merge created. */
export type NewMergeUndo = { docId: string; updatedAt: number };

export function newMergeUndo(doc: Pick<Document, 'id' | 'updatedAt'>): NewMergeUndo {
  return { docId: doc.id, updatedAt: doc.updatedAt };
}

export type NewMergeUndoOutcome = 'deleted' | 'trashed' | 'missing';

/** What Undo does with the merged document as it is now. Pure, for tests. */
export function newMergeUndoAction(undo: NewMergeUndo, doc: Pick<Document, 'updatedAt' | 'trashedAt'> | null): NewMergeUndoOutcome {
  if (!doc || doc.trashedAt != null) return 'missing';
  return doc.updatedAt === undo.updatedAt ? 'deleted' : 'trashed';
}

/**
 * Undo for a merge that created `undo.docId`: deletes it when unchanged since,
 * else moves it to Recently deleted (see the header). The originals are never
 * touched. Runs under the new document's page lock.
 */
export async function undoNewMerge(undo: NewMergeUndo): Promise<NewMergeUndoOutcome> {
  return withDocLock(undo.docId, async () => {
    const doc = await getDocument(undo.docId);
    const action = newMergeUndoAction(undo, doc);
    if (action === 'deleted') await deleteForever(undo.docId);
    else if (action === 'trashed' && !(await trashDocument(undo.docId))) return 'missing';
    return action;
  });
}
