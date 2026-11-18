// lib/files-copy-plan.ts
// Pure planning for "Keep a copy in Files" (lib/files-copy.ts): which PDF
// copies to write and which to remove, given the live documents and what was
// written last time. No native modules, so it is unit-tested.
import { uniqueNames } from './unique-names';

/** What was written for one document: its file name and the record's updatedAt then. */
export type CopyEntry = { name: string; stamp: number };
/** Document id → the copy written for it. */
export type CopyManifest = Record<string, CopyEntry>;

/** The parts of a document the plan needs. */
export type CopyDoc = { id: string; name: string; createdAt: number; updatedAt: number; pages: string[]; pdfUri?: string };

export type CopyPlan = {
  /** File names to delete first: deleted documents, and renamed documents' old names. */
  remove: string[];
  /** Documents whose copy is missing or out of date, with the file name to write. */
  write: { id: string; name: string; stamp: number }[];
  /** Ids whose manifest entries go away with the removals. */
  forget: string[];
};

/**
 * Every live document with pages (or a PDF) gets one copy. Names come from
 * `fileName` and are made unique case-insensitively, oldest document first,
 * so an existing copy keeps its name when a newer document takes the same
 * one ("Receipt.pdf", then "Receipt 2.pdf"). A copy is rewritten when its
 * document changed since (updatedAt) or its name did; a document that is gone
 * (deleted, or in Recently deleted) loses its copy. Only files this feature
 * wrote (the manifest) are ever removed.
 */
export function planFilesCopy(
  docs: CopyDoc[],
  manifest: CopyManifest,
  fileName: (docName: string) => string,
): CopyPlan {
  const live = docs
    .filter(d => !!d.pdfUri || d.pages.length > 0)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const names = uniqueNames(live.map(d => fileName(d.name)));
  const liveIds = new Set(live.map(d => d.id));
  const wanted = new Set(names.map(n => n.toLowerCase()));

  const remove: string[] = [];
  const forget: string[] = [];
  for (const [id, entry] of Object.entries(manifest)) {
    if (!liveIds.has(id)) {
      forget.push(id);
      // Another document may now own that name: it is rewritten below anyway.
      remove.push(entry.name);
    }
  }

  const write: CopyPlan['write'] = [];
  live.forEach((d, i) => {
    const entry = manifest[d.id];
    const name = names[i];
    if (entry && entry.name !== name) {
      // Renamed (or renumbered): the old file goes unless a document now wants that name.
      if (!wanted.has(entry.name.toLowerCase())) remove.push(entry.name);
    }
    if (!entry || entry.name !== name || entry.stamp !== d.updatedAt) {
      write.push({ id: d.id, name, stamp: d.updatedAt });
    }
  });

  // A name freed by one document and taken by another is overwritten, not removed.
  const writing = new Set(write.map(w => w.name.toLowerCase()));
  return {
    remove: Array.from(new Set(remove)).filter(n => !writing.has(n.toLowerCase())),
    write,
    forget,
  };
}
