// lib/add-pages-undo.ts
// Undo for the viewer's Add pages (camera or Photos): takes exactly the pages
// that were added out again — their files, shadows (.orig, source photo, crop
// geometry) and recognised text — and nothing else.
//
// Add pages appends trailing pages, just like merging into a document, so it
// shares merge Undo's fingerprint and removal (lib/merge-undo.ts): how many
// pages came before, how many were added, the page layout generation and each
// added page file's identity. Undo refuses, changing nothing, when pages were
// added, moved or deleted since, or when an added page was edited since.
//
// One difference: the added pages are stored as Original and get the look
// chosen in the review through a filter bake straight afterwards
// (lib/add-pages.ts finishAddedPages), which writes a new page file. That
// bake is part of adding the pages, not an edit made since, so when it has
// written a page the fingerprint takes the new file's identity
// (noteAddedPageBaked). A filter the user picks for an added page later is a
// newer bake that supersedes this one: that one is not noted, and Undo then
// refuses ('pages-edited') rather than throw the user's change away.
//
// A bake still running when Undo goes ahead is dropped (the removal's remap,
// lib/bake.ts applyEdit); a refused Undo re-targets no bake (isEditRefused).
import { File } from 'expo-file-system';
import { docDir } from './storage-layout';
import { pageLayoutGeneration } from './files';
import { fileIdentity } from './ocr-cache';
import {
  mergeUndoRemap,
  mergeUndoToken,
  removeMergedPages,
  type MergeUndo,
  type MergeUndoRefusal,
} from './merge-undo';
import type { Document } from '../types/document';
import type { PageRemap } from './bake';

/** What Undo needs to take the added pages out again (the same fingerprint as merge Undo). */
export type AddPagesUndo = MergeUndo;

/**
 * The fingerprint of `count` pages just added at `start` of `docId`. Take it
 * under the page lock, right after the pages are written. Null when none can
 * be offered (nothing added, or a page's identity can't be read).
 */
export function addPagesUndoToken(docId: string, start: number, count: number): AddPagesUndo | null {
  return mergeUndoToken(docId, start, count);
}

/**
 * The bake that gives added page `index` its look (finishAddedPages) has
 * written it: the new file is still "as added". Ignored for other pages, and
 * once the layout moved (the index may mean another page; Undo refuses then
 * anyway).
 */
export function noteAddedPageBaked(undo: AddPagesUndo, index: number): void {
  const k = index - undo.start;
  if (k < 0 || k >= undo.count) return;
  if (pageLayoutGeneration(undo.docId) !== undo.layout) return;
  const id = fileIdentity(new File(docDir(undo.docId), `page-${index}.jpg`).uri);
  if (id) undo.identities[k] = id;
}

/** The page remap for Undo (runPageEdit): the added pages go, the others keep their index. */
export function addPagesUndoRemap(undo: AddPagesUndo): PageRemap {
  return mergeUndoRemap(undo);
}

/**
 * Removes the added pages and returns the record patch. Run it under the page
 * lock with addPagesUndoRemap(undo), on the record read there; throws
 * MergeUndoError (having changed nothing) when Undo must refuse.
 */
export function removeAddedPages(fresh: Document, undo: AddPagesUndo): Pick<Document, 'pages' | 'filters' | 'adjustments'> {
  return removeMergedPages(fresh, undo);
}

const pages = (n: number) => (n === 1 ? '1 page' : `${n} pages`);

/** The toast after adding pages: "Added 3 pages" (its menu row: "Undo add 3 pages", lib/last-undo.ts). */
export function addedPagesMessage(count: number): string {
  return `Added ${pages(count)}`;
}

/** The confirmation once Undo took them out again. */
export function addPagesUndoneMessage(count: number): string {
  return count === 1 ? 'Added page removed' : `${count} added pages removed`;
}

/** What to tell the user when Undo refused (nothing was changed). */
export function addPagesUndoRefusalMessage(kind: MergeUndoRefusal, count: number): string {
  const them = count === 1 ? 'the added page' : 'the added pages';
  const instead = count === 1 ? 'You can still delete it.' : 'You can still delete them one by one.';
  switch (kind) {
    case 'missing':
      return `The document is no longer here, so ${them} can’t be taken out.`;
    case 'pages-changed':
      return `Pages have been added, moved or deleted since, so ${them} can’t be taken out. ${instead}`;
    case 'pages-edited':
      return `${count === 1 ? 'The added page has' : 'The added pages have'} been edited since, so ${count === 1 ? 'it' : 'they'} can’t be taken out. ${instead}`;
  }
}
