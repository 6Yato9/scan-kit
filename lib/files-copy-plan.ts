// lib/files-copy-plan.ts
// Pure planning for "Keep a copy in Files" (lib/files-copy.ts): which PDF
// copies to write and which to remove, given the live documents, what was
// written before (the manifest) and the names other files already have in the
// folder. No native modules, so it is unit-tested.

/** What identifies a file this feature wrote: it is ours only while these still match. */
export type Fingerprint = { size: number; mtime: number | null; md5: string | null };

/**
 * One copy this feature wrote, for one document.
 *  - `fp`: the file as written. `undefined` only for entries an older build
 *    recorded without one (trusted once, then fingerprinted); `null` while a
 *    first copy is being put in place (there was no file of ours before).
 *  - `next`: write-ahead record of a copy being put in place under `name`. If
 *    the app dies in between, the file found there is recognised as ours by
 *    either fingerprint, never mistaken for the user's.
 */
export type CopyEntry = {
  name: string;
  stamp: number;
  fp?: Fingerprint | null;
  next?: { stamp: number; fp: Fingerprint };
};
/** Document id → the copy written for it. Entries outlive their documents until the file is gone. */
export type CopyManifest = Record<string, CopyEntry>;

/** The parts of a document the plan needs. */
export type CopyDoc = { id: string; name: string; createdAt: number; updatedAt: number; pages: string[]; pdfUri?: string };

export type CopyPlan = {
  /**
   * Copies of ours to remove, before anything is written: a deleted document's,
   * or a renamed / renumbered document's old name. Always removed, even when
   * another document's copy will take the name next — so a failed or cancelled
   * write can never leave a deleted document's PDF behind.
   */
  remove: { id: string; name: string }[];
  /** Documents whose copy is missing or out of date, with the file name to write. */
  write: { id: string; name: string; stamp: number }[];
};

/**
 * Unique names, case-insensitively, that also avoid `occupied` (files in the
 * folder that aren't this feature's — the user's own, or a copy they edited).
 * Every name a document actually has is reserved up front, so a document
 * really called "Receipt 2" keeps that name and a generated "Receipt N"
 * counts past it.
 */
export function uniqueNamesAvoiding(names: string[], occupied: Iterable<string>): string[] {
  const key = (n: string) => n.toLowerCase();
  const blocked = new Set<string>(Array.from(occupied, key));
  const taken = new Set<string>([...blocked, ...names.map(key)]);
  const kept = new Set<string>();
  return names.map(n => {
    if (!kept.has(key(n)) && !blocked.has(key(n))) {
      kept.add(key(n));
      return n;
    }
    const dot = n.lastIndexOf('.');
    const stem = dot > 0 ? n.slice(0, dot) : n;
    const ext = dot > 0 ? n.slice(dot) : '';
    let candidate = `${stem} 2${ext}`;
    for (let i = 3; taken.has(key(candidate)); i++) candidate = `${stem} ${i}${ext}`;
    taken.add(key(candidate));
    kept.add(key(candidate));
    return candidate;
  });
}

/**
 * Every live document with pages (or a PDF) gets one copy. Names come from
 * `fileName`, made unique oldest document first (so an existing copy keeps
 * its name when a newer document takes the same one) and never one an
 * `occupied` file has. A copy is rewritten when its document changed since
 * (updatedAt) or its name did; a document that is gone (deleted, or in
 * Recently deleted) loses its copy. Only files in the manifest are ever
 * removed — and lib/files-copy.ts checks each one's fingerprint first.
 */
export function planFilesCopy(
  docs: CopyDoc[],
  manifest: CopyManifest,
  fileName: (docName: string) => string,
  occupied: Iterable<string> = [],
): CopyPlan {
  const live = docs
    .filter(d => !!d.pdfUri || d.pages.length > 0)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const names = uniqueNamesAvoiding(live.map(d => fileName(d.name)), occupied);
  const wantedFor = new Map(live.map((d, i) => [d.id, names[i]]));

  const remove: CopyPlan['remove'] = [];
  for (const [id, entry] of Object.entries(manifest)) {
    const wanted = wantedFor.get(id);
    // Gone, or renamed (a case-only rename too: APFS treats them as one name,
    // and the remove-then-write order handles it).
    if (wanted === undefined || wanted !== entry.name) remove.push({ id, name: entry.name });
  }

  const write: CopyPlan['write'] = [];
  live.forEach((d, i) => {
    const entry = manifest[d.id];
    const name = names[i];
    if (!entry || entry.name !== name || entry.stamp !== d.updatedAt) {
      write.push({ id: d.id, name, stamp: d.updatedAt });
    }
  });
  return { remove, write };
}

// ── Retrying a copy that couldn't be made ────────────────────────────────────

/** A document whose PDF couldn't be made: at which version, how often, and when to try again. */
export type WriteFailure = { stamp: number; count: number; until: number };

/** First retry after 30 s, doubling each time, at most an hour apart. */
export const RETRY_BASE_MS = 30 * 1000;
export const RETRY_MAX_MS = 60 * 60 * 1000;

/** How long to wait after the `count`-th failure in a row. */
export function retryDelayMs(count: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, count - 1));
}

/** The record after another failure of the document at version `stamp`. */
export function noteWriteFailure(prev: WriteFailure | undefined, stamp: number, now: number): WriteFailure {
  const count = prev && prev.stamp === stamp ? prev.count + 1 : 1;
  return { stamp, count, until: now + retryDelayMs(count) };
}

/**
 * Whether to try making the copy now: always for a document that hasn't
 * failed, or that changed since it did (the change may be the fix); otherwise
 * only once its delay is over.
 */
export function mayAttemptWrite(failure: WriteFailure | undefined, stamp: number, now: number): boolean {
  return !failure || failure.stamp !== stamp || now >= failure.until;
}
