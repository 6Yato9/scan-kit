// lib/pdf-edit.ts
//
// Page edits on an imported PDF that keep it a PDF: rotate, delete, reorder,
// insert a blank page, split, and merge with other documents. PDFKit moves the
// pages (VisionOcr.pdfEditPages), never redraws them, so the text stays
// selectable and searchable and nothing is rasterised.
//
// Every edit is one "plan" (pure helpers below): the output's pages in order,
// each an input page (turned or not) or a blank page shaped like one.
//
// Writing an edit to a stored document, crash-safe:
//  1. Native writes the edited PDF into a work folder in private storage
//     (Application Support/pdf-edit/<session>-…, which iOS never purges) and
//     reads it back: page count, rotations, unlocked. Nothing stored has
//     changed yet; any failure ends here.
//  2. The stored PDF is copied into the same folder (before.pdf). It is the
//     Undo stash and the way back after a crash.
//  3. A journal (journal.json) records the swap about to happen.
//  4. The edited file is renamed over the stored document.pdf in ONE atomic
//     rename(2) (VisionOcr.replaceFile): at every instant the record points
//     at either the old PDF or the new one, complete. Never a missing or
//     half-written file.
//  5. The record is updated (updatedAt, and the search text read from the new
//     file), then the journal is removed.
// Killed after 4 and before 5: the next launch (recoverInterruptedPdfEdits)
// finds the journal and clears the record's search text so it is read again
// from the PDF that is actually there. Work folders of earlier sessions are
// removed at launch.
//
// All of it runs under the document's page lock (lib/bake withDocLock), like
// Convert to pages, unlocking and text indexing, so two PDF operations on one
// document never interleave; the record write goes through the documents lock
// (updateDocumentWith) and only if the record still points at the same PDF.
//
// Undo: the token keeps before.pdf and a fingerprint (size + MD5) of what the
// edit wrote. Undo puts before.pdf back the same atomic way, only if the stored
// PDF is still exactly what the edit wrote. One Undo per document: a newer edit
// drops the older stash; unused stashes are dropped after UNDO_TTL_MS.
import * as Crypto from 'expo-crypto';
import { Directory, File } from 'expo-file-system';
import { VisionOcr } from '../modules/vision-ocr/src';
import type { Document } from '../types/document';
import { withDocLock } from './bake';
import { copyPdfToStorage, deleteDocumentFiles } from './files';
import { deleteDocument, getDocSettings, getDocument, saveDocument, trashDocument, updateDocumentWith } from './storage';
import { deleteJsonSync, privateStateDir, readJsonSync, writeJsonSync } from './storage-layout';
import { bumpPdfTextGeneration, joinPdfPageTexts } from './pdf-text';
import { generatePdf } from './pdf';
import { ocrAvailable } from './ocr';

// ── Plans (pure) ─────────────────────────────────────────────────────────────

/** One output page: input page `source` turned by `rotate` degrees, or (source < 0) a blank page shaped like input page -(source + 1). */
export type PageStep = { source: number; rotate: number };
export type PdfPlan = PageStep[];

/** Blank page shaped like input page `like`. */
export const blankLike = (like: number): number => -like - 1;

export function identityPlan(count: number): PdfPlan {
  return Array.from({ length: count }, (_, i) => ({ source: i, rotate: 0 }));
}

/** Turns page `index` by `degrees` (±90, 180). */
export function rotatePlan(count: number, index: number, degrees: number): PdfPlan {
  if (index < 0 || index >= count) throw new RangeError('page out of range');
  return identityPlan(count).map(s => (s.source === index ? { ...s, rotate: degrees } : s));
}

/** Leaves page `index` out. A PDF keeps at least one page. */
export function deletePlan(count: number, index: number): PdfPlan {
  if (index < 0 || index >= count) throw new RangeError('page out of range');
  if (count <= 1) throw new RangeError('a PDF keeps at least one page');
  return identityPlan(count).filter(s => s.source !== index);
}

/** A blank page after page `after`, the same size and orientation as it. */
export function insertBlankPlan(count: number, after: number): PdfPlan {
  if (after < 0 || after >= count) throw new RangeError('page out of range');
  const plan = identityPlan(count);
  plan.splice(after + 1, 0, { source: blankLike(after), rotate: 0 });
  return plan;
}

/** True when `order` lists 0…count-1 each exactly once. */
export function isPermutation(order: number[], count: number): boolean {
  if (order.length !== count) return false;
  const seen = new Set<number>();
  for (const i of order) {
    if (!Number.isInteger(i) || i < 0 || i >= count || seen.has(i)) return false;
    seen.add(i);
  }
  return true;
}

/** `order[newIndex] = oldIndex`. */
export function reorderPlan(order: number[]): PdfPlan {
  if (!isPermutation(order, order.length) || order.length === 0) throw new RangeError('not a permutation');
  return order.map(source => ({ source, rotate: 0 }));
}

/** Pages 1…after+1 and the rest, as two plans. */
export function splitPlans(count: number, after: number): [PdfPlan, PdfPlan] {
  if (after < 0 || after >= count - 1) throw new RangeError('nothing to split');
  const all = identityPlan(count);
  return [all.slice(0, after + 1), all.slice(after + 1)];
}

/** True when the plan changes nothing (same pages, same order, no turn). */
export function isIdentityPlan(plan: PdfPlan, count: number): boolean {
  return plan.length === count && plan.every((s, i) => s.source === i && s.rotate % 360 === 0);
}

/** Native arguments for a plan. */
export function planArgs(plan: PdfPlan): { sources: number[]; rotations: number[] } {
  return { sources: plan.map(s => s.source), rotations: plan.map(s => s.rotate) };
}

/** Where the page that was at `index` sits after a reorder (`order[new] = old`). */
export function newIndexOf(order: number[], index: number): number {
  const at = order.indexOf(index);
  return at < 0 ? 0 : at;
}

/** "<name> (1)" / "<name> (2)". */
export function splitNames(name: string): [string, string] {
  return [`${name} (1)`, `${name} (2)`];
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type PdfEditErrorKind = 'unavailable' | 'missing' | 'locked' | 'changed' | 'unreadable' | 'failed';

/** An edit that didn't happen. The document is unchanged. */
export class PdfEditError extends Error {
  readonly kind: PdfEditErrorKind;
  /** For 'locked' in a merge: which document needs its password. */
  readonly docId?: string;
  constructor(kind: PdfEditErrorKind, message: string, docId?: string) {
    super(message);
    this.name = 'PdfEditError';
    this.kind = kind;
    this.docId = docId;
  }
}

function classify(err: unknown): PdfEditError {
  if (err instanceof PdfEditError) return err;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const code = (err as { code?: string } | null)?.code ?? '';
  if (code === 'ERR_PDF_LOCKED' || /^locked$|password|encrypt/i.test(msg)) return new PdfEditError('locked', msg);
  if (/could not open|no pages/i.test(msg)) return new PdfEditError('unreadable', msg);
  return new PdfEditError('failed', msg);
}

// ── Availability ─────────────────────────────────────────────────────────────

/** True when this build can edit PDF pages in place (and swap the result in atomically). */
export function canEditPdfPages(): boolean {
  return typeof VisionOcr?.pdfEditPages === 'function' && typeof VisionOcr?.replaceFile === 'function';
}

/** True when this build can combine PDFs (PDF + PDF, PDF + scan). */
export function canMergePdfDocuments(): boolean {
  return typeof VisionOcr?.mergePdfs === 'function';
}

// ── Work folders, fingerprints, journal ──────────────────────────────────────

const WORK_ROOT = 'pdf-edit';
const JOURNAL = 'journal.json';
/** This process: work folders named with it are this session's. */
const SESSION = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** An Undo nobody pressed is dropped after this (the toast's action lasts 6 s, 10 s with VoiceOver). */
export const UNDO_TTL_MS = 30_000;

const clean = (uri: string) => uri.split('?')[0];

function workRoot(): Directory {
  return new Directory(privateStateDir(), WORK_ROOT);
}

let workSeq = 0;
function newWorkDir(docId: string): Directory {
  workSeq += 1;
  const dir = new Directory(workRoot(), `${SESSION}-${docId}-${Date.now().toString(36)}-${workSeq}`);
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function deleteQuietly(item: File | Directory | null | undefined): void {
  try {
    if (item?.exists) item.delete();
  } catch {
    // best effort: work folders of earlier sessions are removed at launch
  }
}

/** Identifies a file's bytes (null fields: couldn't be read). */
export type FilePrint = { size: number | null; md5: string | null };

function printOf(uri: string): FilePrint {
  const f = new File(clean(uri));
  let size: number | null = null;
  let md5: string | null = null;
  try { size = typeof f.size === 'number' ? f.size : null; } catch {}
  try { md5 = typeof f.md5 === 'string' ? f.md5 : null; } catch {}
  return { size, md5 };
}

/** True when both prints are known and equal on everything both know. */
export function samePrint(a: FilePrint, b: FilePrint): boolean {
  let checked = false;
  if (a.size !== null && b.size !== null) {
    if (a.size !== b.size) return false;
    checked = true;
  }
  if (a.md5 && b.md5) {
    if (a.md5 !== b.md5) return false;
    checked = true;
  }
  return checked;
}

type Journal = { v: 1; session: string; docId: string; target: string; written: FilePrint };

async function readText(uri: string): Promise<string | null> {
  const read = VisionOcr?.pdfPageTexts;
  if (typeof read !== 'function') return null;
  try {
    const pages = await read(clean(uri), null);
    return joinPdfPageTexts(Array.isArray(pages) ? pages : []);
  } catch {
    return null;
  }
}

/**
 * Renames `src` over the stored PDF and updates the record, journaled (see the
 * header). Runs inside the page lock. Returns whether the record was written.
 */
async function swapIn(docId: string, target: string, src: File, work: Directory, patch: Partial<Document>): Promise<boolean> {
  const replace = VisionOcr?.replaceFile;
  if (typeof replace !== 'function') throw new PdfEditError('unavailable', 'replaceFile missing');
  const written = printOf(src.uri);
  const journal: Journal = { v: 1, session: SESSION, docId, target, written };
  if (!writeJsonSync(work, JOURNAL, journal)) throw new PdfEditError('failed', 'journal not written');
  try {
    await replace(src.uri, target);
  } catch (err) {
    deleteJsonSync(work, JOURNAL); // nothing was swapped: the stored PDF is as it was
    throw classify(err);
  }
  bumpPdfTextGeneration(docId);
  const ok = await updateDocumentWith(docId, latest =>
    latest.pdfUri && clean(latest.pdfUri) === target ? { ...patch, updatedAt: Date.now() } : null,
  );
  deleteJsonSync(work, JOURNAL);
  return ok;
}

// ── Undo ─────────────────────────────────────────────────────────────────────

export type PdfEditUndo = {
  docId: string;
  /** The work folder holding before.pdf. */
  dir: string;
  /** The stored PDF (document.pdf) the edit replaced. */
  target: string;
  /** What the edit wrote there: Undo refuses if the file has changed since. */
  written: FilePrint;
  /** The record's search text before the edit, put back with the PDF. */
  ocrText?: string;
};

const undoSlots = new Map<string, { undo: PdfEditUndo; timer: ReturnType<typeof setTimeout> }>();

/** Drops an Undo stash that will no longer be used. Never throws. */
export function discardPdfEditUndo(undo: PdfEditUndo | null | undefined): void {
  if (!undo) return;
  const slot = undoSlots.get(undo.docId);
  if (slot?.undo === undo) {
    clearTimeout(slot.timer);
    undoSlots.delete(undo.docId);
  }
  deleteQuietly(new Directory(undo.dir));
}

function keepUndo(undo: PdfEditUndo): void {
  const old = undoSlots.get(undo.docId);
  if (old) discardPdfEditUndo(old.undo);
  const timer = setTimeout(() => discardPdfEditUndo(undo), UNDO_TTL_MS);
  // Never keeps a test runner (or the JS thread) alive on its own.
  (timer as { unref?: () => void }).unref?.();
  undoSlots.set(undo.docId, { undo, timer });
}

// ── Editing a stored PDF ─────────────────────────────────────────────────────

export type PdfEditResult = { doc: Document; pageCount: number; undo: PdfEditUndo | null };

/**
 * Applies `plan` to document `docId`'s PDF in place (see the header).
 * Resolves with the updated record, the new page count and an Undo token
 * (null if the old PDF couldn't be kept). Rejects with PdfEditError, leaving
 * the document as it was.
 */
export async function editStoredPdf(
  docId: string,
  plan: PdfPlan,
  options: { password?: string | null } = {},
): Promise<PdfEditResult> {
  const edit = VisionOcr?.pdfEditPages;
  if (typeof edit !== 'function' || !canEditPdfPages()) throw new PdfEditError('unavailable', 'pdfEditPages missing');
  if (plan.length === 0) throw new PdfEditError('failed', 'empty plan');
  return withDocLock(docId, async () => {
    const doc = await getDocument(docId);
    if (!doc) throw new PdfEditError('missing', 'document missing');
    if (!doc.pdfUri || doc.pages.length > 0) throw new PdfEditError('changed', 'not a PDF document');
    const target = clean(doc.pdfUri);
    if (!new File(target).exists) throw new PdfEditError('unreadable', 'stored PDF missing');

    const work = newWorkDir(docId);
    let keepWork = false;
    try {
      const after = new File(work, 'after.pdf');
      const { sources, rotations } = planArgs(plan);
      let pageCount: number;
      try {
        pageCount = await edit(target, after.uri, sources, rotations, options.password ?? null);
      } catch (err) {
        throw classify(err);
      }
      if (!after.exists || pageCount !== plan.length) throw new PdfEditError('failed', 'edit not verified');
      const text = await readText(after.uri);

      // The way back (Undo, and after a crash): a copy of the PDF as it is now.
      let before: File | null = new File(work, 'before.pdf');
      try {
        new File(target).copy(before);
      } catch (err) {
        console.warn('PDF edit: could not keep the previous PDF for Undo', err);
        deleteQuietly(before);
        before = null;
      }

      const written = printOf(after.uri);
      const ok = await swapIn(docId, target, after, work, {
        // '' (an image-only PDF) is stored as no text, like lib/pdf-text.
        ocrText: text ? text : undefined,
      });
      if (!ok) throw new PdfEditError('missing', 'document missing');
      const next = await getDocument(docId);
      if (!next) throw new PdfEditError('missing', 'document missing');
      let undo: PdfEditUndo | null = null;
      if (before) {
        undo = { docId, dir: work.uri, target, written, ocrText: doc.ocrText };
        keepUndo(undo);
        keepWork = true;
      }
      return { doc: next, pageCount, undo };
    } finally {
      if (!keepWork) deleteQuietly(work);
    }
  });
}

/**
 * Puts back the PDF an edit replaced. Single-use. Rejects with PdfEditError
 * 'changed' when the stored PDF is no longer what the edit wrote (edited again
 * since), leaving it alone.
 */
export async function undoPdfEdit(undo: PdfEditUndo): Promise<Document> {
  const slot = undoSlots.get(undo.docId);
  if (slot?.undo === undo) clearTimeout(slot.timer);
  try {
    return await withDocLock(undo.docId, async () => {
      const work = new Directory(undo.dir);
      const before = new File(work, 'before.pdf');
      if (!before.exists) throw new PdfEditError('changed', 'undo stash is gone');
      const doc = await getDocument(undo.docId);
      if (!doc) throw new PdfEditError('missing', 'document missing');
      if (!doc.pdfUri || clean(doc.pdfUri) !== undo.target) throw new PdfEditError('changed', 'document changed');
      if (!samePrint(printOf(undo.target), undo.written)) throw new PdfEditError('changed', 'PDF changed since');
      const ok = await swapIn(undo.docId, undo.target, before, work, { ocrText: undo.ocrText });
      if (!ok) throw new PdfEditError('missing', 'document missing');
      const next = await getDocument(undo.docId);
      if (!next) throw new PdfEditError('missing', 'document missing');
      return next;
    });
  } finally {
    discardPdfEditUndo(undo);
  }
}

// ── Startup recovery ─────────────────────────────────────────────────────────

/**
 * Finishes what an edit the app died in the middle of left behind (see the
 * header), then removes every work folder of earlier sessions. Never throws;
 * returns how many documents were repaired.
 */
export async function recoverInterruptedPdfEdits(): Promise<number> {
  let repaired = 0;
  let items: (File | Directory)[] = [];
  try {
    const root = workRoot();
    if (!root.exists) return 0;
    items = root.list();
  } catch {
    return 0;
  }
  for (const item of items) {
    try {
      const name = item.uri.replace(/\/+$/, '').split('/').pop() ?? '';
      if (name.startsWith(`${SESSION}-`)) continue; // this session's (in use)
      if (item instanceof Directory) {
        const j = readJsonSync<Journal>(item, JOURNAL);
        if (j.state === 'ok' && j.value?.docId && j.value.target) {
          const { docId, target } = j.value;
          await withDocLock(docId, async () => {
            // rename(2) never leaves the target missing; should anything have,
            // put the newest complete file there.
            if (!new File(target).exists) {
              const after = new File(item, 'after.pdf');
              const before = new File(item, 'before.pdf');
              const src = after.exists ? after : before.exists ? before : null;
              if (src) src.move(new File(target));
            }
            // Which PDF is there now isn't known for sure: its text is read again
            // the next time the document is shown (lib/pdf-text needsPdfText).
            const ok = await updateDocumentWith(docId, latest =>
              latest.pdfUri && clean(latest.pdfUri) === target ? { ocrText: undefined, updatedAt: Date.now() } : null,
            );
            if (ok) repaired++;
          });
        }
      }
      deleteQuietly(item);
    } catch (err) {
      console.warn('PDF edit recovery', err);
    }
  }
  return repaired;
}

// ── Split ────────────────────────────────────────────────────────────────────

export type SplitResult = { first: Document; second: Document; originalTrashed: boolean };

/**
 * Splits document `docId`'s PDF after page `after` (zero-based) into two new
 * documents, "<name> (1)" and "<name> (2)", in the same folder. The original
 * is kept unless `trashOriginal` (then it moves to Recently deleted, where it
 * can be restored). Rejects with PdfEditError; nothing is created then.
 */
export async function splitStoredPdf(
  docId: string,
  after: number,
  options: { trashOriginal?: boolean; password?: string | null } = {},
): Promise<SplitResult> {
  const edit = VisionOcr?.pdfEditPages;
  const info = VisionOcr?.pdfInfo;
  if (typeof edit !== 'function' || typeof info !== 'function') throw new PdfEditError('unavailable', 'pdfEditPages missing');
  const made = await withDocLock(docId, async () => {
    const doc = await getDocument(docId);
    if (!doc) throw new PdfEditError('missing', 'document missing');
    if (!doc.pdfUri || doc.pages.length > 0) throw new PdfEditError('changed', 'not a PDF document');
    const source = clean(doc.pdfUri);
    let count: number;
    try {
      const i = await info(source, options.password ?? null);
      if (i.locked) throw new PdfEditError('locked', 'locked');
      count = i.pageCount;
    } catch (err) {
      throw classify(err);
    }
    let plans: [PdfPlan, PdfPlan];
    try {
      plans = splitPlans(count, after);
    } catch {
      throw new PdfEditError('changed', 'nothing to split');
    }
    const work = newWorkDir(docId);
    const created: string[] = [];
    try {
      const names = splitNames(doc.name);
      const docs: Document[] = [];
      for (let k = 0; k < 2; k++) {
        const out = new File(work, `part-${k + 1}.pdf`);
        const { sources, rotations } = planArgs(plans[k]);
        try {
          const n = await edit(source, out.uri, sources, rotations, options.password ?? null);
          if (n !== plans[k].length) throw new PdfEditError('failed', 'split not verified');
        } catch (err) {
          throw classify(err);
        }
        const text = await readText(out.uri);
        const id = Crypto.randomUUID();
        created.push(id);
        const now = Date.now() + k; // the first part sorts as the newer of the two in "Date added"
        const pdfUri = copyPdfToStorage(out.uri, id);
        const part: Document = {
          id,
          name: names[k],
          pages: [],
          pdfUri,
          folder: doc.folder,
          createdAt: now,
          updatedAt: now,
          ...(text ? { ocrText: text } : {}),
        };
        await saveDocument(part);
        docs.push(part);
      }
      return { first: docs[0], second: docs[1] };
    } catch (err) {
      // Nothing half-made stays: the parts saved so far go again.
      for (const id of created) {
        try { await deleteDocument(id); } catch {}
        try { deleteDocumentFiles(id); } catch {}
      }
      throw classify(err);
    } finally {
      deleteQuietly(work);
    }
  });
  let originalTrashed = false;
  if (options.trashOriginal) {
    try {
      originalTrashed = await trashDocument(docId);
    } catch (err) {
      console.warn('Split: could not move the original to Recently deleted', err);
    }
  }
  return { ...made, originalTrashed };
}

// ── Merge ────────────────────────────────────────────────────────────────────

export type MergeProgress = { done: number; total: number };

/** True when merging these documents needs the PDF path (at least one is an imported PDF). */
export function needsPdfMerge(docs: Pick<Document, 'pdfUri'>[]): boolean {
  return docs.some(d => !!d.pdfUri);
}

/**
 * Combines `docs` in order into ONE new PDF document named `name` (in the
 * first document's folder). Imported PDFs keep their pages as they are (text
 * stays selectable); scanned documents are rendered on the paper size from
 * Document settings, searchable when text recognition is available. The
 * originals are untouched. Rejects with PdfEditError ('locked' carries the
 * document that needs its password); nothing is created then.
 */
export async function mergeDocumentsToPdf(
  docs: Document[],
  name: string,
  options: { onProgress?: (p: MergeProgress) => void } = {},
): Promise<Document> {
  const merge = VisionOcr?.mergePdfs;
  if (typeof merge !== 'function') throw new PdfEditError('unavailable', 'mergePdfs missing');
  if (docs.length < 2) throw new PdfEditError('failed', 'nothing to merge');
  const info = VisionOcr?.pdfInfo;
  const settings = await getDocSettings().catch(() => null);
  const work = newWorkDir('merge');
  const rendered: string[] = [];
  try {
    const parts: string[] = [];
    let expected = 0;
    for (let k = 0; k < docs.length; k++) {
      const doc = (await getDocument(docs[k].id)) ?? docs[k];
      if (doc.pdfUri) {
        const uri = clean(doc.pdfUri);
        if (!new File(uri).exists) throw new PdfEditError('unreadable', 'stored PDF missing', doc.id);
        if (typeof info === 'function') {
          let i: { pageCount: number; locked: boolean };
          try {
            i = await info(uri, null);
          } catch (err) {
            const e = classify(err);
            throw new PdfEditError(e.kind, e.message, doc.id);
          }
          if (i.locked) throw new PdfEditError('locked', 'locked', doc.id);
          expected += i.pageCount;
        } else {
          expected = NaN;
        }
        parts.push(uri);
      } else if (doc.pages.length > 0) {
        const pdf = await generatePdf(doc.pages, {
          pageSize: settings?.pdfPageSize ?? 'Auto',
          quality: settings?.pdfQuality ?? 'standard',
          searchable: ocrAvailable(),
        });
        rendered.push(pdf);
        parts.push(clean(pdf));
        expected += doc.pages.length;
      } else {
        throw new PdfEditError('changed', 'empty document', doc.id);
      }
      options.onProgress?.({ done: k + 1, total: docs.length + 1 });
    }
    const out = new File(work, 'merged.pdf');
    try {
      await merge(parts, out.uri);
    } catch (err) {
      throw classify(err);
    }
    if (!out.exists) throw new PdfEditError('failed', 'merge wrote nothing');
    if (typeof info === 'function' && Number.isFinite(expected)) {
      const check = await info(out.uri, null).catch(() => null);
      if (!check || check.locked || check.pageCount !== expected) throw new PdfEditError('failed', 'merge not verified');
    }
    const text = await readText(out.uri);
    const id = Crypto.randomUUID();
    const now = Date.now();
    const doc: Document = {
      id,
      name,
      pages: [],
      pdfUri: copyPdfToStorage(out.uri, id),
      folder: docs[0].folder,
      createdAt: now,
      updatedAt: now,
      ...(text ? { ocrText: text } : {}),
    };
    try {
      await saveDocument(doc);
    } catch (err) {
      try { deleteDocumentFiles(id); } catch {}
      throw err;
    }
    options.onProgress?.({ done: docs.length + 1, total: docs.length + 1 });
    return doc;
  } catch (err) {
    throw classify(err);
  } finally {
    for (const r of rendered) deleteQuietly(new File(clean(r)));
    deleteQuietly(work);
  }
}

export function resetPdfEditForTests(): void {
  for (const { timer } of undoSlots.values()) clearTimeout(timer);
  undoSlots.clear();
}
