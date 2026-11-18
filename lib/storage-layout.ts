// lib/storage-layout.ts
//
// WHERE THE APP KEEPS ITS FILES, and the one-time move that put them there.
//
// Every document's pages (page-N.jpg and their .orig shadows), imported PDFs,
// recognised text (ocr/) and the Sign tool's saved signatures live in
//
//   <container>/Library/Application Support/scan-kit/<docId>/…
//   <container>/Library/Application Support/signatures/…
//
// Builds up to round 9 kept them in <container>/Documents/. The Documents
// folder is what the Files app shows (UIFileSharingEnabled), so from this
// layout on it BELONGS TO THE USER: they can make folders there — one may well
// be called "scan-kit" or "signatures" — and drop or edit files in it. The
// rule everything below follows: the app never moves, merges, overwrites or
// deletes anything in Documents except what it can positively identify as its
// own:
//  - a document folder: named with a document id (a UUID) and holding nothing
//    but what the app writes into one (page-N.jpg, page-N.orig.jpg, their side
//    files, document.pdf, ocr/*.json) — see looksLikeDocFolder;
//  - the saved-signatures folder: nothing but index.json and sig-XXXXXXXX.png;
//  - the April 2026 Merge tool's pages: documents/<UUID>/page_N.jpg;
//  - its own "Keep a copy in Files" PDFs (lib/files-copy.ts, by manifest and
//    fingerprint) and the scanner's / Files-copy temp files (lib/files.ts).
// Anything else — a user's "scan-kit" folder with their own files in it, a
// PDF, a sub-folder — is never touched, whatever state the move is in.
//
// THE MOVE (migrateStorageLayout) runs once per process, synchronously, the
// first time anything asks for a path here — so nothing can read or write a
// page before it has happened. It is:
//  - rename-based: a document folder is moved with one rename on the same
//    volume. Only when a rename fails is a file copied, verified (size and
//    MD5) and then removed from Documents — never removed unverified;
//  - per document: a folder that can't be moved stays where it was and is
//    used from there (state 'split'); it is tried again on the next launch;
//  - merging, never overwriting: when a document's folder exists in both
//    places (an older build run after a newer one re-created it), the contents
//    are merged item by item; an item present in both is never overwritten —
//    the one from Documents is kept in Application Support/scan-kit-recovered/,
//    which Settings › Recovered files shows (lib/recovered-files via
//    listRecoveredGroups below);
//  - recorded: Application Support/storage-layout.json, written atomically
//    (a verified side file renamed into place, and read back from the side
//    file if the app died in between). A marker that exists but can't be read
//    is taken as "already migrated" — the conservative reading.
//
// Stored records hold absolute file:// URIs written under the old layout (and
// possibly an old container path). rebaseStoredUri maps every one of them to
// where the file is now; lib/storage.ts applies it to every record it reads
// and writes, so old records heal on read and are rewritten on the next save.
//
// Android, web and any container this code does not recognise keep the old
// layout (state 'documents', nothing is moved): their Documents folder is
// already private.
import { Directory, File, Paths } from 'expo-file-system';

/** Name of the folder holding one sub-folder per document (in both layouts). */
export const SCAN_DIR_NAME = 'scan-kit';
export const SIGNATURES_DIR_NAME = 'signatures';
const INBOX = 'Inbox';
export const RECOVERED_DIR_NAME = 'scan-kit-recovered';
export const LEGACY_DOCS_DIR_NAME = 'legacy-documents';
const MARKER_NAME = 'storage-layout.json';
/** lib/files-copy.ts keeps its manifest here; its existence means copies were made. */
export const FILES_COPY_MANIFEST_NAME = 'files-copy.json';
const LAYOUT_VERSION = 3;
/** The April 2026 Merge tool kept merged documents' pages in Documents/documents/<id>/. */
const APRIL_MERGE_DIR = 'documents';
/** How many launches the Documents-root pass is tried before it is given up. */
const MAX_LEFTOVER_ATTEMPTS = 3;

/** A document id (every id the app has ever made is Crypto.randomUUID()). */
export const DOC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Every file name the app writes directly into a document's folder: pages,
 * their .orig shadows and (R12) .src source photos with .src.json geometry
 * (lib/page-source.ts), their side and reorder-temp files, the PDF.
 */
const DOC_FOLDER_FILE =
  /^(?:page-\d+(?:\.orig|\.src)?(?:\.new|\.part|\.shifting|\.tmp)?\.jpg|page-tmp-\d+(?:\.orig|\.src)?\.jpg|page-(?:tmp-)?\d+\.src\.json|document\.pdf|reorder\.commit)$/;
/** A page or a PDF: what makes a folder a document's rather than an empty look-alike. */
const DOC_CONTENT = /^(?:page-\d+\.jpg|document\.pdf)$/;
const OCR_DIR = 'ocr';
const SIGNATURE_FILE = /^(?:index\.json|sig-[0-9a-f]{8}\.png(?:\.new)?)$/;
const APRIL_PAGE = /^page_\d+\.jpg$/;

/**
 * - 'app-support': everything is in Application Support (the normal case).
 * - 'split': some document folders couldn't be moved this launch; they are
 *   used from Documents until a later launch moves them.
 * - 'documents': nothing has moved (not iOS, or the move failed this launch).
 */
export type LayoutState = 'app-support' | 'split' | 'documents';

export type LayoutReport = {
  state: LayoutState;
  /** Where new document folders are made. */
  scanRoot: string;
  /** Documents/scan-kit while app document folders are still in it. */
  legacyScanRoot: string | null;
  signaturesDir: string;
  /** What this launch's migration did (empty when there was nothing to do). */
  actions: string[];
  errors: string[];
};

// URIs, not Directory handles: a handle is made fresh for each use.
type Layout = {
  state: LayoutState;
  support: string | null;
  scanRoot: string;
  legacyScanRoot: string | null;
  signatures: string;
  legacyDocs: string | null;
  actions: string[];
  errors: string[];
};

/** Where the move steps report what they did. */
type Log = { actions: string[]; errors: string[] };

type Marker = {
  version?: number;
  /** The one-time Documents-root pass: 'pending' while it runs, 'done' after. */
  strays?: 'pending' | 'done';
  straysAt?: number;
  strayAttempts?: number;
  migratedAt?: number;
};

let layout: Layout | null = null;

function slash(uri: string): string {
  return uri.endsWith('/') ? uri : `${uri}/`;
}

function nameOf(item: File | Directory): string {
  try {
    if (item.name) return item.name;
  } catch {}
  const clean = item.uri.replace(/\/+$/, '');
  try {
    return decodeURIComponent(clean.slice(clean.lastIndexOf('/') + 1));
  } catch {
    return clean.slice(clean.lastIndexOf('/') + 1);
  }
}

/** `dir.exists`, or `fallback` when even that can't be read. */
function exists(item: File | Directory, fallback: boolean): boolean {
  try {
    return item.exists;
  } catch {
    return fallback;
  }
}

function listOf(dir: Directory): (File | Directory)[] | null {
  try {
    return dir.exists ? dir.list() : [];
  } catch {
    return null;
  }
}

/**
 * <container>/Library/Application Support, derived from the Documents and
 * Caches folders expo-file-system reports (it has no constant for it). Only
 * when both have the exact iOS shape and share one container; null otherwise.
 */
export function applicationSupportDir(): Directory | null {
  try {
    const docs = slash(Paths.document.uri);
    const cache = slash(Paths.cache.uri);
    if (!docs.endsWith('/Documents/') || !cache.endsWith('/Library/Caches/')) return null;
    const container = docs.slice(0, -'Documents/'.length);
    if (cache.slice(0, -'Library/Caches/'.length) !== container) return null;
    return new Directory(`${container}Library/`, 'Application Support');
  } catch {
    return null;
  }
}

/**
 * A folder for the app's own small state files that is never shown in Files:
 * Application Support on iOS, the (private) Documents folder elsewhere.
 */
export function privateStateDir(): Directory {
  const support = applicationSupportDir();
  if (support) {
    try {
      support.create({ intermediates: true, idempotent: true });
    } catch {}
    return support;
  }
  return new Directory(Paths.document);
}

function documentsDir(): Directory {
  return new Directory(Paths.document);
}

// ── Atomic JSON files ───────────────────────────────────────────────────────
//
// expo-file-system writes text non-atomically (atomically: false): an app
// killed mid-write leaves a truncated file. These helpers write a side file
// "<name>.new", read it back to check it, and only then rename it into place.
// The app can die after the old file is removed and before the rename, so a
// reader falls back to the side file, and a writer finishes that rename first.

export type JsonRead<T> = { state: 'absent' } | { state: 'ok'; value: T } | { state: 'corrupt' };

function parseFile(f: File): { ok: true; value: unknown } | { ok: false; present: boolean } {
  try {
    if (!f.exists) return { ok: false, present: false };
  } catch {
    return { ok: false, present: true };
  }
  try {
    return { ok: true, value: JSON.parse(f.textSync()) };
  } catch {
    return { ok: false, present: true };
  }
}

/** Reads `<dir>/<name>` (or its side file, see above). Never throws. */
export function readJsonSync<T = unknown>(dir: Directory, name: string): JsonRead<T> {
  const main = parseFile(new File(dir, name));
  if (main.ok) return { state: 'ok', value: main.value as T };
  const side = parseFile(new File(dir, `${name}.new`));
  if (side.ok) return { state: 'ok', value: side.value as T };
  return main.present || side.present ? { state: 'corrupt' } : { state: 'absent' };
}

/** Writes `value` to `<dir>/<name>` atomically (see above). Returns false when it couldn't. */
export function writeJsonSync(dir: Directory, name: string, value: unknown): boolean {
  const text = JSON.stringify(value);
  const main = new File(dir, name);
  const side = new File(dir, `${name}.new`);
  try {
    // A previous write died between removing the old file and the rename: the
    // side file is the current content, so finish that first.
    if (!main.exists && side.exists && parseFile(side).ok) side.move(new File(dir, name));
    const fresh = new File(dir, `${name}.new`);
    if (fresh.exists) fresh.delete();
    fresh.create();
    fresh.write(text);
    if (fresh.textSync() !== text) throw new Error('write did not verify');
    const target = new File(dir, name);
    if (target.exists) target.delete();
    fresh.move(new File(dir, name));
    return true;
  } catch {
    return false;
  }
}

/** Removes `<dir>/<name>` and its side file. */
export function deleteJsonSync(dir: Directory, name: string): void {
  for (const n of [name, `${name}.new`]) {
    try {
      const f = new File(dir, n);
      if (f.exists) f.delete();
    } catch {}
  }
}

// ── What counts as the app's own ────────────────────────────────────────────

/**
 * True when `dir` holds nothing but what the app writes into a document's
 * folder (dot-files aside). With `requireId`, its name must also be a
 * document id; with `requireContent` (the default when `requireId`), it must
 * hold at least one page or PDF. A user's folder — whatever it is called —
 * fails this as soon as it holds one file of their own.
 */
export function looksLikeDocFolder(dir: Directory, requireId: boolean, requireContent = requireId): boolean {
  if (requireId && !DOC_ID.test(nameOf(dir))) return false;
  const items = listOf(dir);
  if (!items) return false;
  let content = false;
  for (const item of items) {
    const name = nameOf(item);
    if (name.startsWith('.')) continue;
    if (item instanceof Directory) {
      if (name !== OCR_DIR) return false;
      const ocr = listOf(item);
      if (!ocr) return false;
      for (const o of ocr) {
        const n = nameOf(o);
        if (n.startsWith('.')) continue;
        if (o instanceof Directory || !/\.json$/.test(n)) return false;
      }
    } else {
      if (!DOC_FOLDER_FILE.test(name)) return false;
      if (DOC_CONTENT.test(name)) content = true;
    }
  }
  return content || !requireContent;
}

/** True when `dir` holds only the saved signatures' index and images. */
export function looksLikeSignaturesFolder(dir: Directory): boolean {
  const items = listOf(dir);
  if (!items) return false;
  let any = false;
  for (const item of items) {
    const name = nameOf(item);
    if (name.startsWith('.')) continue;
    if (item instanceof Directory || !SIGNATURE_FILE.test(name)) return false;
    any = true;
  }
  return any;
}

/** documents/<UUID>/ of the April 2026 Merge tool: page_N.jpg files only. */
function looksLikeAprilMergeFolder(dir: Directory): boolean {
  if (!DOC_ID.test(nameOf(dir))) return false;
  const items = listOf(dir);
  if (!items) return false;
  let any = false;
  for (const item of items) {
    const name = nameOf(item);
    if (name.startsWith('.')) continue;
    if (item instanceof Directory || !APRIL_PAGE.test(name)) return false;
    any = true;
  }
  return any;
}

// ── Moving ──────────────────────────────────────────────────────────────────

/**
 * Moves file `item` to `target` (which must not exist). By rename; if the
 * rename fails, by copying, checking the copy against the original (size, and
 * MD5 where it can be read) and only then removing the original. On any doubt
 * the original stays and the copy is removed. Returns true when it moved.
 */
function moveFile(item: File, target: File, rel: string, log: Log): boolean {
  const srcUri = item.uri;
  try {
    item.move(target);
    return true;
  } catch (e) {
    log.errors.push(`move ${rel}: ${String(e)}`);
  }
  const src = new File(srcUri);
  if (!exists(src, false)) return exists(target, false); // it went after all
  try {
    src.copy(target);
    const copy = new File(target.uri);
    const same = copy.exists && copy.size === src.size && sameMd5(src, copy);
    if (!same) {
      try { if (copy.exists) copy.delete(); } catch {}
      log.errors.push(`copy ${rel}: did not verify`);
      return false;
    }
    try {
      src.delete();
    } catch (e) {
      // Both exist now; the copy is used, and the original is tried again
      // next launch (it then merges as identical-name, kept aside).
      log.errors.push(`remove copied ${rel}: ${String(e)}`);
    }
    log.actions.push(`copied ${rel}`);
    return true;
  } catch (e) {
    log.errors.push(`copy ${rel}: ${String(e)}`);
    try { const t = new File(target.uri); if (t.exists) t.delete(); } catch {}
    return false;
  }
}

/** MD5s agree, or can't be read on this platform (the size check stands then). */
function sameMd5(a: File, b: File): boolean {
  try {
    const x = a.md5;
    const y = b.md5;
    if (typeof x !== 'string' || typeof y !== 'string') return true;
    return x === y;
  } catch {
    return true;
  }
}

/**
 * Moves the folder `src` to `dest`. When `dest` doesn't exist, by one rename;
 * otherwise (or when that rename fails) the two are merged item by item; an
 * item present in both stays in `dest`, and the one from `src` is moved to
 * `recovered(rel)`. `src` is removed only once it is empty. Never deletes a
 * file that hasn't been verified to exist elsewhere. Returns true when `src`
 * is gone (everything moved).
 */
function relocateDir(
  srcDir: Directory,
  destDir: Directory,
  rel: string,
  recovered: (rel: string) => Directory,
  log: Log,
): boolean {
  // Handles are re-made from these URIs for every check: a moved handle
  // follows its file (expo-file-system updates its url on move), so asking the
  // moved `src` whether it still exists would answer for the destination.
  const srcUri = srcDir.uri;
  const destUri = destDir.uri;
  const src = () => new Directory(srcUri);
  const dest = () => new Directory(destUri);
  if (!exists(src(), true)) return true;
  let created = false;
  if (!exists(dest(), true)) {
    try {
      // dest does not exist, so this is a rename of src to dest — not a move
      // INTO dest (Directory.move nests when the destination exists).
      src().move(dest());
    } catch (e) {
      log.errors.push(`move ${rel}: ${String(e)}`);
    }
    if (!exists(src(), true) && exists(dest(), false)) {
      log.actions.push(`moved ${rel}`);
      return true;
    }
    // The rename failed: move what's inside one item at a time instead.
    try {
      dest().create({ intermediates: true, idempotent: true });
      created = true;
    } catch (e) {
      log.errors.push(`create ${rel}: ${String(e)}`);
      return false;
    }
  }
  const items = listOf(src());
  if (!items) {
    log.errors.push(`list ${rel}`);
    return false;
  }
  for (const item of items) {
    const name = nameOf(item);
    const childRel = `${rel}/${name}`;
    try {
      if (item instanceof Directory) {
        const target = new Directory(dest(), name);
        const clash = new File(dest(), name);
        if (!target.exists && clash.exists) {
          // A file where the folder should go: keep both, the folder aside.
          moveAside(item, recovered(rel), name, log, childRel);
        } else {
          relocateDir(item, target, childRel, recovered, log);
        }
      } else {
        const target = new File(dest(), name);
        const clash = new Directory(dest(), name);
        if (!target.exists && !clash.exists) {
          if (moveFile(item, target, childRel, log)) log.actions.push(`merged ${childRel}`);
        } else {
          moveAside(item, recovered(rel), name, log, childRel);
        }
      }
    } catch (e) {
      log.errors.push(`merge ${childRel}: ${String(e)}`);
    }
  }
  try {
    if (src().list().length === 0) src().delete();
  } catch (e) {
    log.errors.push(`remove empty ${rel}: ${String(e)}`);
  }
  // A folder made here that nothing could be moved into would be found
  // first (docDir) and hide the one still holding the files: remove it.
  if (created) {
    try {
      if (dest().exists && dest().list().length === 0) dest().delete();
    } catch {}
  }
  return !exists(src(), true);
}

/** Moves `item` into `dir` under `name` (or `name 2`, `name 3`, …), never over anything. */
function moveAside(item: File | Directory, dir: Directory, name: string, log: Log, rel: string, verb = 'kept aside'): boolean {
  try {
    dir.create({ intermediates: true, idempotent: true });
    for (let n = 1; n < 100; n++) {
      const candidate = n === 1 ? name : `${name} ${n}`;
      const asFile = new File(dir, candidate);
      const asDir = new Directory(dir, candidate);
      if (asFile.exists || asDir.exists) continue;
      if (item instanceof Directory) {
        if (!relocateDir(item, asDir, rel, () => new Directory(dir, `${candidate} conflicts`), log)) return false;
      } else if (!moveFile(item, asFile, rel, log)) {
        return false;
      }
      log.actions.push(`${verb} ${rel} → ${nameOf(dir)}/${candidate}`);
      return true;
    }
  } catch (e) {
    log.errors.push(`keep aside ${rel}: ${String(e)}`);
  }
  return false; // left where it was
}

function recoveredDir(support: Directory, now: number, rel: string): Directory {
  return new Directory(support, RECOVERED_DIR_NAME, String(now), ...rel.split('/').filter(Boolean));
}

// ── The steps ───────────────────────────────────────────────────────────────

/**
 * Document folders in Documents/scan-kit that are the app's. Before the move
 * has completed once, the folder was the app's alone (no shipped build made
 * Documents visible in Files), so every folder named with a document id or
 * holding a page or a PDF goes, whatever else is in it (an older build's side
 * file must not keep a document behind), as does any other folder holding only
 * what the app writes into a document's folder, and dot-named temp folders
 * (.retake-staging). After that
 * only document-id folders holding nothing but the app's files are taken:
 * see looksLikeDocFolder.
 */
function appDocFolders(oldScan: Directory, completed: boolean): Directory[] {
  const items = listOf(oldScan) ?? [];
  return items.filter((c): c is Directory => {
    if (!(c instanceof Directory)) return false;
    const name = nameOf(c);
    if (name.startsWith('.')) return !completed;
    if (completed) return looksLikeDocFolder(c, true, true);
    return DOC_ID.test(name) || holdsDocContent(c) || looksLikeDocFolder(c, false, false);
  });
}

/**
 * True when Documents/scan-kit still holds a folder a document may be using:
 * one appDocFolders would take, or ANY folder holding a page or a PDF,
 * whatever it is called and whatever else is in it. Decided from what is
 * there, not from what the move managed: while one exists the old root stays
 * in use (docDir finds a document's folder there), so no document's pages can
 * go missing because its folder wasn't moved (r11 #1). Generous on purpose:
 * keeping the old root readable for a folder that turns out to be the user's
 * costs nothing (no document id names it, and nothing is swept while it is
 * read); dropping it while a document is in it hides that document.
 */
function docFoldersRemain(oldScan: Directory, completed: boolean): boolean {
  if (appDocFolders(oldScan, completed).length > 0) return true;
  return (listOf(oldScan) ?? []).some(c => c instanceof Directory && !nameOf(c).startsWith('.') && holdsDocContent(c));
}

/** True when `dir` directly holds a page or a PDF (anything else in it aside). */
function holdsDocContent(dir: Directory): boolean {
  return (listOf(dir) ?? []).some(i => !(i instanceof Directory) && DOC_CONTENT.test(nameOf(i)));
}

/** Moves the app's document folders out of Documents/scan-kit (see the header). */
function moveScanRoot(oldScan: Directory, newScan: Directory, completed: boolean, support: Directory, now: number, log: Layout): void {
  if (!exists(oldScan, false)) return;
  const items = listOf(oldScan);
  if (!items) {
    log.errors.push('list scan-kit');
    return;
  }
  const ours = appDocFolders(oldScan, completed);
  if (ours.length === 0) return; // nothing of the app's (or a user's folder of that name)
  const recovered = (rel: string) => recoveredDir(support, now, rel);
  // The usual first launch: the whole folder is the app's, one rename.
  if (!completed && !exists(newScan, true) && ours.length === items.length) {
    if (relocateDir(oldScan, newScan, SCAN_DIR_NAME, recovered, log)) return;
  }
  try {
    newScan.create({ intermediates: true, idempotent: true });
  } catch (e) {
    log.errors.push(`create scan-kit: ${String(e)}`);
    return;
  }
  let moved = false;
  for (const d of appDocFolders(oldScan, completed)) {
    const name = nameOf(d);
    if (relocateDir(d, new Directory(newScan, name), `${SCAN_DIR_NAME}/${name}`, recovered, log)) moved = true;
  }
  // Only a folder this pass emptied of the app's own document folders is removed.
  if (moved) {
    try {
      const left = new Directory(oldScan.uri);
      if (left.exists && left.list().length === 0) {
        left.delete();
        log.actions.push('removed empty Documents/scan-kit');
      }
    } catch {}
  }
}

/** Moves the saved signatures out of Documents/signatures, if that folder is the app's. */
function moveSignatures(oldSigs: Directory, newSigs: Directory, support: Directory, now: number, log: Layout): void {
  if (!exists(oldSigs, false) || !looksLikeSignaturesFolder(oldSigs)) return;
  // Both indexes, read before the merge sets the older one aside.
  const oldIndex = readJsonSync<unknown[]>(oldSigs, 'index.json');
  const newIndex = exists(newSigs, false) ? readJsonSync<unknown[]>(newSigs, 'index.json') : ({ state: 'absent' } as const);
  relocateDir(oldSigs, newSigs, SIGNATURES_DIR_NAME, rel => recoveredDir(support, now, rel), log);
  // An older build saved signatures after a newer one: list them in one index
  // (the newer build's first), so none of them disappears from the Sign tool.
  if (oldIndex.state === 'ok' && newIndex.state === 'ok' && Array.isArray(oldIndex.value) && Array.isArray(newIndex.value)) {
    const seen = new Set<string>();
    const merged: unknown[] = [];
    for (const e of [...newIndex.value, ...oldIndex.value]) {
      const id = e && typeof e === 'object' ? (e as { id?: unknown }).id : null;
      if (typeof id !== 'string' || seen.has(id)) continue;
      if (!exists(new File(newSigs, `${id}.png`), false)) continue;
      seen.add(id);
      merged.push(e);
    }
    if (writeJsonSync(new Directory(newSigs.uri), 'index.json', merged)) log.actions.push('merged signatures index');
  }
}

/**
 * The one-time pass over the Documents root: the April 2026 Merge tool's
 * pages (Documents/documents/<UUID>/page_N.jpg — the only other thing any
 * build wrote there) go to Application Support/legacy-documents/documents/,
 * where rebaseStoredUri finds them. Nothing else in Documents is looked at, so
 * even a pass run at the wrong time can't move a user's file or a Files copy.
 * Refused outright (`refuse`) when the marker can't be read or Files copies
 * exist — both mean Documents has been the user's for a while. A pass cut
 * short is finished on a later launch (it can only ever pick up those
 * folders), at most MAX_LEFTOVER_ATTEMPTS launches in all.
 */
function moveDocumentsLeftovers(support: Directory, marker: Marker, refuse: boolean, log: Layout, now: number): Marker {
  if (marker.strays === 'done') return marker;
  const attempts = (marker.strayAttempts ?? 0) + 1;
  if (refuse || attempts > MAX_LEFTOVER_ATTEMPTS) {
    const done: Marker = { ...marker, strays: 'done', straysAt: now };
    writeJsonSync(support, MARKER_NAME, { ...done, version: LAYOUT_VERSION });
    return done;
  }
  const pending: Marker = { ...marker, strays: 'pending', strayAttempts: attempts };
  if (!writeJsonSync(support, MARKER_NAME, { ...pending, version: LAYOUT_VERSION })) {
    log.errors.push('marker not writable: leftovers pass skipped');
    return marker;
  }
  let allMoved = true;
  const april = new Directory(documentsDir(), APRIL_MERGE_DIR);
  if (exists(april, false)) {
    const legacy = new Directory(support, LEGACY_DOCS_DIR_NAME, APRIL_MERGE_DIR);
    const children = listOf(april);
    if (!children) allMoved = false;
    let moved = false;
    for (const c of children ?? []) {
      if (!(c instanceof Directory) || !looksLikeAprilMergeFolder(c)) continue; // not ours: left alone
      try {
        legacy.create({ intermediates: true, idempotent: true });
      } catch {
        allMoved = false;
        break;
      }
      const name = nameOf(c);
      if (relocateDir(c, new Directory(legacy, name), `Documents/${APRIL_MERGE_DIR}/${name}`, r => recoveredDir(support, now, r), log)) moved = true;
      else allMoved = false;
    }
    if (moved) {
      try {
        const left = new Directory(april.uri);
        if (left.exists && left.list().length === 0) left.delete();
      } catch {}
    }
  }
  if (!allMoved) return pending;
  const done: Marker = { ...pending, strays: 'done', straysAt: now };
  writeJsonSync(support, MARKER_NAME, { ...done, version: LAYOUT_VERSION });
  return done;
}

/**
 * Moves the app's data out of Documents (see the header). Safe to call any
 * number of times; does real work only when something of the app's is still
 * in Documents. Never throws. Normally called through the path getters below;
 * exported for tests and for the app's startup.
 */
export function migrateStorageLayout(now: number = Date.now()): LayoutReport {
  const docs = documentsDir();
  const oldScan = new Directory(docs, SCAN_DIR_NAME);
  const oldSigs = new Directory(docs, SIGNATURES_DIR_NAME);
  const support = applicationSupportDir();
  const next: Layout = {
    state: 'documents',
    support: support?.uri ?? null,
    scanRoot: oldScan.uri,
    legacyScanRoot: null,
    signatures: oldSigs.uri,
    legacyDocs: null,
    actions: [],
    errors: [],
  };
  layout = next;
  if (!support) return report(next);

  const newScan = new Directory(support, SCAN_DIR_NAME);
  const newSigs = new Directory(support, SIGNATURES_DIR_NAME);
  let completed = true; // until known otherwise: the careful reading
  try {
    support.create({ intermediates: true, idempotent: true });
    if (!support.exists) throw new Error('Application Support missing');
    const read = readJsonSync<Marker>(support, MARKER_NAME);
    let marker: Marker = read.state === 'ok' && read.value && typeof read.value === 'object' && !Array.isArray(read.value) ? read.value : {};
    const copiesMade = readJsonSync(support, FILES_COPY_MANIFEST_NAME).state !== 'absent';
    completed = read.state === 'corrupt' || !!marker.migratedAt || copiesMade;

    moveScanRoot(oldScan, newScan, completed, support, now, next);
    // Saved signatures: a convenience (a few PNGs and an index).
    moveSignatures(oldSigs, newSigs, support, now, next);
    marker = moveDocumentsLeftovers(support, marker, read.state === 'corrupt' || copiesMade, next, now);
    const leftBehind = docFoldersRemain(oldScan, completed);
    if (read.state === 'corrupt') {
      // Unreadable: it was written by a launch that ran the move. Repair it.
      writeJsonSync(support, MARKER_NAME, { version: LAYOUT_VERSION, strays: 'done', straysAt: now, migratedAt: now });
    } else if (!leftBehind && !marker.migratedAt) {
      writeJsonSync(support, MARKER_NAME, { ...marker, migratedAt: now, version: LAYOUT_VERSION });
    }
  } catch (e) {
    next.errors.push(`migration: ${String(e)}`);
  }

  // Which folders to use follows from what is on disk now, whatever happened
  // above — never from what the steps meant to do.
  const leftBehind = docFoldersRemain(oldScan, completed);
  if (!leftBehind) {
    next.scanRoot = newScan.uri; // made on demand on a fresh install
    next.state = 'app-support';
  } else if (exists(newScan, false)) {
    // Part moved: new folders go to the new root, old ones are still found.
    next.scanRoot = newScan.uri;
    next.legacyScanRoot = oldScan.uri;
    next.state = 'split';
  } // else nothing moved: stay in Documents ('documents'), try again next launch.
  // A signatures folder of the app's that couldn't be moved keeps being used as it is.
  const sigsStayed = exists(oldSigs, false) && !exists(newSigs, false) && looksLikeSignaturesFolder(oldSigs);
  next.signatures = (sigsStayed ? oldSigs : newSigs).uri;
  const legacyDocs = new Directory(support, LEGACY_DOCS_DIR_NAME);
  next.legacyDocs = exists(legacyDocs, false) ? legacyDocs.uri : null;

  if (next.actions.length || next.errors.length) {
    console.log(`storage-layout: ${next.state}; ${next.actions.length} moved, ${next.errors.length} errors`, next.errors.slice(0, 5));
  }
  return report(next);
}

function report(l: Layout): LayoutReport {
  return {
    state: l.state,
    scanRoot: l.scanRoot,
    legacyScanRoot: l.legacyScanRoot,
    signaturesDir: l.signatures,
    actions: [...l.actions],
    errors: [...l.errors],
  };
}

function current(): Layout {
  if (!layout) {
    try {
      migrateStorageLayout();
    } catch (e) {
      // migrateStorageLayout never throws; this is belt and braces.
      console.warn('storage-layout: migration crashed; using Documents', e);
    }
  }
  if (!layout) {
    const docs = documentsDir();
    layout = {
      state: 'documents',
      support: null,
      scanRoot: new Directory(docs, SCAN_DIR_NAME).uri,
      legacyScanRoot: null,
      signatures: new Directory(docs, SIGNATURES_DIR_NAME).uri,
      legacyDocs: null,
      actions: [],
      errors: ['migration crashed'],
    };
  }
  return layout;
}

/** Runs the move if it hasn't run in this process. Call early at startup. */
export function ensureStorageLayout(): LayoutReport | null {
  try {
    return report(current());
  } catch (e) {
    // Never take the app down at startup; the path getters report it later.
    console.warn('storage-layout: unavailable', e);
    return null;
  }
}

/** The layout in use (runs the move first if needed). */
export function storageLayout(): LayoutReport {
  return report(current());
}

/** Where new document folders are made. */
export function scanRoot(): Directory {
  return new Directory(current().scanRoot);
}

/**
 * Every folder that can hold document folders, the current one first. Two only
 * while the move is part done ('split').
 */
export function scanRoots(): Directory[] {
  const l = current();
  return (l.legacyScanRoot ? [l.scanRoot, l.legacyScanRoot] : [l.scanRoot]).map(u => new Directory(u));
}

/**
 * Document `docId`'s folder: where it is, or where it will be made. While the
 * move is part done, a folder still in Documents is found there.
 */
export function docDir(docId: string): Directory {
  const l = current();
  const primary = new Directory(l.scanRoot, docId);
  if (!l.legacyScanRoot) return primary;
  try {
    if (primary.exists) return primary;
    const legacy = new Directory(l.legacyScanRoot, docId);
    if (legacy.exists) return legacy;
  } catch {}
  return primary;
}

/** Every existing folder of document `docId` (two only while the move is part done). */
export function docDirs(docId: string): Directory[] {
  return scanRoots()
    .map(root => new Directory(root, docId))
    .filter(d => exists(d, true));
}

/** True when `dir` directly holds any file the app writes into a document's folder, or OCR text. */
function holdsAppFiles(dir: Directory): boolean {
  for (const item of listOf(dir) ?? []) {
    const name = nameOf(item);
    if (item instanceof Directory) {
      if (name === OCR_DIR && (listOf(item) ?? []).some(o => !nameOf(o).startsWith('.'))) return true;
    } else if (DOC_FOLDER_FILE.test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Document `docId`'s ONE folder, for anything that writes, renames or deletes
 * its pages. Normally docDir. While the move is part done ('split') a crash or
 * a failed move can leave a document's files in both roots; an edit that
 * shifts or reorders pages by index in one root only would pair pages with the
 * wrong shadows and lose some (r11 #5). So the app's files are first merged
 * into the new root — an item in both stays in the new root, the old one is
 * kept aside in Recovered files, never overwritten — and if that can't be
 * finished this throws, and the edit doesn't happen.
 */
export function resolveDocDir(docId: string): Directory {
  const l = current();
  const primary = new Directory(l.scanRoot, docId);
  if (!l.legacyScanRoot) return primary;
  const legacy = new Directory(l.legacyScanRoot, docId);
  if (!exists(legacy, true)) return primary;
  if (!exists(primary, true)) return legacy;
  if (!holdsAppFiles(legacy)) return primary;
  const log: Log = { actions: [], errors: [] };
  const now = Date.now();
  const support = l.support ? new Directory(l.support) : null;
  const rel = `${SCAN_DIR_NAME}/${docId}`;
  const aside = (r: string) => (support ? recoveredDir(support, now, r) : new Directory(l.scanRoot, `${docId} conflicts`));
  for (const item of listOf(new Directory(legacy.uri)) ?? []) {
    const name = nameOf(item);
    try {
      if (item instanceof Directory) {
        if (name !== OCR_DIR) continue; // not the app's: left where it is
        relocateDir(item, new Directory(primary, OCR_DIR), `${rel}/${OCR_DIR}`, aside, log);
      } else if (DOC_FOLDER_FILE.test(name)) {
        const target = new File(primary, name);
        if (!exists(target, true) && !exists(new Directory(primary, name), true)) {
          if (moveFile(item, target, `${rel}/${name}`, log)) log.actions.push(`merged ${rel}/${name}`);
        } else {
          moveAside(item, aside(rel), name, log, `${rel}/${name}`);
        }
      }
    } catch (e) {
      log.errors.push(`merge ${rel}/${name}: ${String(e)}`);
    }
  }
  try {
    const left = new Directory(legacy.uri);
    if (left.exists && left.list().length === 0) left.delete();
  } catch {}
  if (log.actions.length || log.errors.length) console.log(`storage-layout: merged ${docId} into one folder`, log.errors.slice(0, 5));
  if (exists(new Directory(legacy.uri), false) && holdsAppFiles(new Directory(legacy.uri))) {
    throw new Error(`storage-layout: document ${docId} is still in two folders`);
  }
  return primary;
}

/**
 * True when `uri` is inside the Documents folder AND that folder is (or may
 * become) visible in the Files app — iOS, where the app's data lives in
 * Application Support. Elsewhere Documents is private and this is false.
 */
export function isUserVisibleUri(uri: string): boolean {
  if (!current().support) return false;
  const docs = sameFileKey(slash(Paths.document.uri));
  return sameFileKey(uri).startsWith(docs);
}

/**
 * Removes only what the app writes into a document's folder from `dir` (page
 * files, side files, document.pdf, ocr/*.json), then the folder if that left
 * it empty. Anything else — a file the user put there — stays, and so does
 * the folder holding it. Returns true when the folder is gone.
 */
export function removeAppFiles(dir: Directory): boolean {
  for (const item of listOf(dir) ?? []) {
    const name = nameOf(item);
    try {
      if (item instanceof Directory) {
        if (name !== OCR_DIR) continue;
        for (const o of listOf(item) ?? []) {
          if (!(o instanceof Directory) && /\.json$/.test(nameOf(o))) o.delete();
        }
        if (item.list().length === 0) item.delete();
      } else if (DOC_FOLDER_FILE.test(name)) {
        item.delete();
      }
    } catch {}
  }
  try {
    const left = new Directory(dir.uri);
    if (left.exists && left.list().length === 0) left.delete();
    return !left.exists;
  } catch {
    return false;
  }
}

/**
 * One spelling per file, for comparing URIs that may name the same file
 * differently: no ?query, percent-escapes decoded, and iOS's /private/var
 * firmlink as /var (FileManager hands out either, r11 #7).
 */
export function sameFileKey(uri: string): string {
  let u = String(uri).split('?')[0];
  try {
    u = decodeURIComponent(u);
  } catch {}
  return u.replace(/^file:\/\/\/private\/var\//, 'file:///var/');
}

/** The saved signatures' folder (lib/saved-signatures.ts). */
export function signaturesDir(): Directory {
  return new Directory(current().signatures);
}

/** True when `uri` is inside the app's private storage (never a temp file). */
export function isAppDataUri(uri: string): boolean {
  const l = current();
  const clean = uri.split('?')[0];
  if (clean.includes(`/${SCAN_DIR_NAME}/`)) return true;
  const roots = [l.support, l.signatures].filter((d): d is string => !!d);
  return roots.some(d => clean.startsWith(slash(d)));
}

/**
 * Where a file:// URI stored by any version of the app points now:
 *  - …/scan-kit/<docId>/<rest> (Documents or Application Support, this
 *    container or an earlier one) → <docDir(docId)>/<rest>;
 *  - …/Documents/<rest> of a file the one-time leftovers pass moved
 *    (Documents/documents/… of April 2026 merged documents) → its place in
 *    legacy-documents, when it is there;
 *  - anything else (a file the app doesn't own) → unchanged.
 * Pure string work except for the leftovers case, which checks the file exists.
 */
export function rebaseStoredUri(uri: string): string {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return uri;
  const marker = `/${SCAN_DIR_NAME}/`;
  const i = uri.indexOf(marker);
  if (i !== -1) {
    const rest = uri.slice(i + marker.length);
    const cut = rest.indexOf('/');
    if (cut <= 0) return uri;
    const id = rest.slice(0, cut);
    let decoded = id;
    try {
      decoded = decodeURIComponent(id);
    } catch {}
    const tail = rest.slice(cut + 1);
    const l = current();
    if (l.legacyScanRoot) {
      // A document part moved: each file is where it is.
      const primary = slash(new Directory(l.scanRoot, decoded).uri) + tail;
      const legacy = slash(new Directory(l.legacyScanRoot, decoded).uri) + tail;
      try {
        if (new File(primary.split('?')[0]).exists) return primary;
        if (new File(legacy.split('?')[0]).exists) return legacy;
      } catch {}
    }
    return slash(docDir(decoded).uri) + tail;
  }
  const l = current();
  const j = uri.indexOf('/Documents/');
  if (j !== -1 && l.legacyDocs) {
    const rel = uri.slice(j + '/Documents/'.length);
    if (rel && !rel.startsWith(`${INBOX}/`)) {
      const candidate = slash(l.legacyDocs) + rel;
      try {
        if (new File(candidate.split('?')[0]).exists) return candidate;
      } catch {}
    }
  }
  return uri;
}

// ── Recovered files (Settings › Recovered files) ────────────────────────────

/** One set of files the app set aside, shown as one row. */
export type RecoveredGroup = {
  /** Stable key: the folder's URI. */
  key: string;
  /** The folder holding the group (deleted with it). */
  dir: string;
  kind: 'pages' | 'pdf' | 'signatures' | 'files';
  /** When it was set aside (ms), when known. */
  savedAt: number | null;
  /** Page images in page order (pages), the PDF (pdf), or every file. */
  files: string[];
  bytes: number;
};

const IMAGE_FILE = /\.(?:jpe?g|png|heic)$/i;
const PAGE_ORDER = /^page[-_](\d+)\.jpg$/i;

function filesUnder(dir: Directory, out: File[] = []): File[] {
  for (const item of listOf(dir) ?? []) {
    if (nameOf(item).startsWith('.')) continue;
    if (item instanceof Directory) filesUnder(item, out);
    else out.push(item);
  }
  return out;
}

function sizeOf(f: File): number {
  try {
    return f.size ?? 0;
  } catch {
    return 0;
  }
}

function groupOf(dir: Directory, savedAt: number | null, referenced: Set<string>, signatures = false): RecoveredGroup | null {
  const all = filesUnder(dir);
  // A file a document still uses (legacy-documents) is not "recovered": it is in use.
  if (all.some(f => referenced.has(sameFileKey(f.uri)))) return null;
  // Shadows (.orig) and source photos (.src) belong to their page: not shown on their own.
  const visible = all.filter(f => !/\.json$/i.test(nameOf(f)) && !/\.(?:orig|src)\.jpg$/i.test(nameOf(f)));
  if (visible.length === 0) return null;
  const bytes = all.reduce((s, f) => s + sizeOf(f), 0);
  const pages = visible
    .map(f => ({ f, m: PAGE_ORDER.exec(nameOf(f)) }))
    .filter(x => x.m)
    .sort((a, b) => Number(a.m![1]) - Number(b.m![1]))
    .map(x => x.f.uri);
  const pdf = visible.find(f => nameOf(f) === 'document.pdf');
  if (signatures) return { key: dir.uri, dir: dir.uri, kind: 'signatures', savedAt, files: visible.filter(f => IMAGE_FILE.test(nameOf(f))).map(f => f.uri), bytes };
  if (pdf && pages.length === 0) return { key: dir.uri, dir: dir.uri, kind: 'pdf', savedAt, files: [pdf.uri], bytes };
  if (pages.length > 0 && pages.length === visible.filter(f => f !== pdf).length) {
    return { key: dir.uri, dir: dir.uri, kind: 'pages', savedAt, files: pages, bytes };
  }
  return { key: dir.uri, dir: dir.uri, kind: 'files', savedAt, files: visible.map(f => f.uri), bytes };
}

/**
 * What the app has set aside and the user can't otherwise see: files an
 * update merge kept aside (scan-kit-recovered/<when>/…), and files the
 * one-time Documents pass moved that no document uses (legacy-documents/).
 * `referenced` holds every file URI a document record (live or deleted) uses;
 * those are never offered. Null when the records couldn't all be read: then
 * legacy-documents is left out entirely (any file there might be in use).
 * iOS only; empty elsewhere.
 */
export function listRecoveredGroups(referenced: Set<string> | null): RecoveredGroup[] {
  const support = applicationSupportDir();
  if (!support) return [];
  current(); // the move first: it may set more aside
  const out: RecoveredGroup[] = [];
  const push = (g: RecoveredGroup | null) => { if (g) out.push(g); };
  const none = new Set<string>();
  // Compared in one spelling: records and directory listings can name a file
  // with or without /private, escaped or not.
  if (referenced) referenced = new Set([...referenced].map(sameFileKey));
  for (const batch of listOf(new Directory(support, RECOVERED_DIR_NAME)) ?? []) {
    if (!(batch instanceof Directory)) continue;
    const when = Number(nameOf(batch));
    const savedAt = Number.isFinite(when) && when > 0 ? when : null;
    for (const top of listOf(batch) ?? []) {
      const topName = nameOf(top);
      if (top instanceof Directory && topName === SCAN_DIR_NAME) {
        for (const d of listOf(top) ?? []) {
          if (d instanceof Directory) push(groupOf(d, savedAt, referenced ?? none));
        }
      } else if (top instanceof Directory) {
        push(groupOf(top, savedAt, referenced ?? none, topName === SIGNATURES_DIR_NAME));
      }
    }
    const loose = (listOf(batch) ?? []).filter((f): f is File => f instanceof File && !nameOf(f).startsWith('.'));
    if (loose.length) {
      out.push({ key: `${batch.uri}#files`, dir: '', kind: 'files', savedAt, files: loose.map(f => f.uri), bytes: loose.reduce((s, f) => s + sizeOf(f), 0) });
    }
  }
  const legacy = new Directory(support, LEGACY_DOCS_DIR_NAME);
  const inUse = referenced ?? none;
  for (const top of referenced ? listOf(legacy) ?? [] : []) {
    if (top instanceof Directory && nameOf(top) === APRIL_MERGE_DIR) {
      for (const d of listOf(top) ?? []) if (d instanceof Directory) push(groupOf(d, null, inUse));
    } else if (top instanceof Directory) {
      push(groupOf(top, null, inUse));
    } else if (!nameOf(top).startsWith('.') && !inUse.has(sameFileKey(top.uri))) {
      out.push({ key: top.uri, dir: '', kind: IMAGE_FILE.test(nameOf(top)) ? 'pages' : 'files', savedAt: null, files: [top.uri], bytes: sizeOf(top as File) });
    }
  }
  return out.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
}

/**
 * Permanently removes a recovered group's files (and its folder, and any
 * folder above it that is left empty, up to the recovered / legacy root).
 * Only ever inside those two folders. Returns true when everything went.
 */
export function deleteRecoveredGroup(group: RecoveredGroup): boolean {
  const support = applicationSupportDir();
  if (!support) return false;
  const key = (u: string) => sameFileKey(u).replace(/\/+$/, '');
  const roots = [new Directory(support, RECOVERED_DIR_NAME).uri, new Directory(support, LEGACY_DOCS_DIR_NAME).uri].map(key);
  const inside = (u: string) => {
    const k = key(u);
    return !k.split('/').includes('..') && roots.some(r => k.startsWith(`${r}/`));
  };
  let ok = true;
  try {
    if (group.dir && inside(group.dir)) {
      const d = new Directory(group.dir);
      if (d.exists) d.delete();
    } else {
      for (const u of group.files) {
        if (!inside(u)) { ok = false; continue; }
        const f = new File(u);
        if (f.exists) f.delete();
      }
    }
  } catch {
    ok = false;
  }
  // Tidy now-empty parents (a batch folder, scan-kit/ inside it, the roots).
  const start = group.dir || group.files[0] || '';
  let parent = start.replace(/\/+$/, '');
  for (let i = 0; i < 4 && parent; i++) {
    parent = parent.slice(0, parent.lastIndexOf('/'));
    const dir = new Directory(parent);
    const isRoot = roots.includes(key(dir.uri));
    if (!inside(dir.uri) && !isRoot) break;
    try {
      if (dir.exists && dir.list().length === 0) dir.delete();
      else break;
    } catch {
      break;
    }
    if (isRoot) break;
  }
  return ok;
}

/** Tests only: forget the layout so the next call migrates again. */
export function resetStorageLayoutForTests(): void {
  layout = null;
}
