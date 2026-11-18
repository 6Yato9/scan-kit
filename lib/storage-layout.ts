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
// folder is what the Files app shows once UIFileSharingEnabled is on ("Keep a
// copy in Files"), and anything there would be visible — and deletable —
// outside App Lock. Application Support is private to the app, backed up the
// same way as Documents, and never cleaned up by iOS (it is also where
// AsyncStorage already keeps the document records).
//
// THE MOVE (migrateStorageLayout) runs once per process, synchronously, the
// first time anything asks for a path here — so nothing can read or write a
// page before it has happened. It is:
//  - rename-only: each folder is moved with one rename (FileManager.moveItem on
//    the same volume), never copied and deleted, so there is no moment where a
//    file exists in neither place and nothing is ever deleted;
//  - all-or-nothing per folder: when a rename fails, the folder stays where it
//    was and this session keeps using it from there (state 'documents'); the
//    move is tried again on the next launch;
//  - resumable and idempotent: when both the old and the new folder exist (an
//    interrupted merge, or an older build run after a newer one re-created the
//    old folder) their contents are merged item by item, again by rename; an
//    item present in both is never overwritten — the one in Documents is kept
//    in Application Support/scan-kit-recovered/. Until the merge completes
//    (state 'split') each document is looked up in both places;
//  - recorded: Application Support/storage-layout.json notes when it finished.
//    The record is informational; the folders on disk are the truth, so a
//    lost record can never cause a second, wrong move.
//
// Stored records hold absolute file:// URIs written under the old layout (and
// possibly an old container path). rebaseStoredUri maps every one of them to
// where the file is now; lib/storage.ts applies it to every record it reads
// and writes, so old records heal on read and are rewritten on the next save.
//
// Documents/ also held a few other things the app wrote before it was visible
// in Files: Documents/documents/ (pages of documents merged by an April 2026
// build) and development leftovers. Once, on the first launch of this layout,
// everything in Documents except Inbox (iOS's "Open in" copies), the scanner's
// transient output and dot-files is moved to Application Support/
// legacy-documents/, and rebaseStoredUri points any record still referring to
// one of those files at its new place. After that one pass Documents belongs
// to the user and is never touched again.
//
// Android, web and any container this code does not recognise keep the old
// layout (state 'documents', nothing is moved): their Documents folder is
// already private.
import { Directory, File, Paths } from 'expo-file-system';

/** Name of the folder holding one sub-folder per document (in both layouts). */
export const SCAN_DIR_NAME = 'scan-kit';
export const SIGNATURES_DIR_NAME = 'signatures';
/** Items in Documents that a Documents-root move keeps there. */
const INBOX = 'Inbox';
const RECOVERED_DIR_NAME = 'scan-kit-recovered';
const LEGACY_DOCS_DIR_NAME = 'legacy-documents';
const MARKER_NAME = 'storage-layout.json';
const LAYOUT_VERSION = 2;
/** The document scanner writes its pages straight into Documents/ (lib/files.ts sweeps them). */
const SCANNER_OUTPUT = /^DOCUMENT_SCAN_\d+_[^/]*\.jpe?g$/i;

/**
 * - 'app-support': everything is in Application Support (the normal case).
 * - 'split': the move is part done; documents are looked up in both places.
 * - 'documents': nothing has moved (not iOS, or the move failed this launch).
 */
export type LayoutState = 'app-support' | 'split' | 'documents';

export type LayoutReport = {
  state: LayoutState;
  /** Where new document folders are made. */
  scanRoot: string;
  /** Documents/scan-kit while it still exists next to the new root. */
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

type Marker = {
  version?: number;
  /** 'pending' while the one-time Documents-root pass runs; 'done' after. */
  strays?: 'pending' | 'done';
  straysAt?: number;
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

function documentsDir(): Directory {
  return new Directory(Paths.document);
}

function readMarker(support: Directory): Marker {
  try {
    const f = new File(support, MARKER_NAME);
    if (!f.exists) return {};
    const parsed = JSON.parse(f.textSync());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeMarker(support: Directory, marker: Marker): boolean {
  try {
    const f = new File(support, MARKER_NAME);
    if (!f.exists) f.create();
    f.write(JSON.stringify({ ...marker, version: LAYOUT_VERSION }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Moves the folder `src` to `dest` by rename. When `dest` already exists the
 * two are merged item by item (recursively), still by rename; an item present
 * in both stays in `dest`, and the one from `src` is moved to `recovered()`
 * under its relative path `rel`. `src` is removed only once it is empty.
 * Never deletes a file. Returns true when `src` is gone (everything moved).
 */
function relocateDir(
  srcDir: Directory,
  destDir: Directory,
  rel: string,
  recovered: (rel: string) => Directory,
  log: Layout,
): boolean {
  // Handles are re-made from these URIs for every check: a moved handle
  // follows its file (expo-file-system updates its url on move), so asking the
  // moved `src` whether it still exists would answer for the destination.
  const srcUri = srcDir.uri;
  const destUri = destDir.uri;
  const src = () => new Directory(srcUri);
  const dest = () => new Directory(destUri);
  if (!src().exists) return true;
  if (!dest().exists) {
    try {
      // dest does not exist, so this is a rename of src to dest — not a move
      // INTO dest (Directory.move nests when the destination exists).
      src().move(dest());
    } catch (e) {
      log.errors.push(`move ${rel}: ${String(e)}`);
    }
    if (!src().exists && dest().exists) {
      log.actions.push(`moved ${rel}`);
      return true;
    }
    if (!dest().exists) return false; // nothing happened: src is intact where it was
    // Both exist now (should not happen with a rename): merge below.
  }
  let items: (File | Directory)[];
  try {
    items = src().list();
  } catch (e) {
    log.errors.push(`list ${rel}: ${String(e)}`);
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
          item.move(target);
          log.actions.push(`merged ${childRel}`);
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
  return !src().exists;
}

/** Moves `item` into `dir` under `name` (or `name 2`, `name 3`, …), never over anything. */
function moveAside(item: File | Directory, dir: Directory, name: string, log: Layout, rel: string, verb = 'kept aside'): boolean {
  try {
    dir.create({ intermediates: true, idempotent: true });
    for (let n = 1; n < 100; n++) {
      const candidate = n === 1 ? name : `${name} ${n}`;
      const asFile = new File(dir, candidate);
      const asDir = new Directory(dir, candidate);
      if (asFile.exists || asDir.exists) continue;
      if (item instanceof Directory) item.move(asDir);
      else item.move(asFile);
      log.actions.push(`${verb} ${rel} → ${nameOf(dir)}/${candidate}`);
      return true;
    }
  } catch (e) {
    log.errors.push(`keep aside ${rel}: ${String(e)}`);
  }
  return false; // left where it was
}

/**
 * The one-time pass over the Documents root (see the header): everything but
 * the folders handled by the move itself, Inbox, scanner output and dot-files
 * goes to Application Support/legacy-documents/. Runs once: the marker says
 * 'pending' before anything moves and 'done' after, so an interrupted pass is
 * finished on the next launch, and a completed one never runs again (Documents
 * may then hold the user's own files). Skipped entirely if the marker can't be
 * written.
 */
function moveDocumentsLeftovers(support: Directory, marker: Marker, log: Layout, now: number): Marker {
  if (marker.strays === 'done') return marker;
  const pending: Marker = { ...marker, strays: 'pending' };
  if (!writeMarker(support, pending)) {
    log.errors.push('marker not writable: leftovers pass skipped');
    return marker;
  }
  const legacy = new Directory(support, LEGACY_DOCS_DIR_NAME);
  let items: (File | Directory)[] = [];
  try {
    const docs = documentsDir();
    if (docs.exists) items = docs.list();
  } catch (e) {
    log.errors.push(`list Documents: ${String(e)}`);
    return pending; // retried next launch
  }
  let allMoved = true;
  for (const item of items) {
    const name = nameOf(item);
    if (name === SCAN_DIR_NAME || name === SIGNATURES_DIR_NAME || name === INBOX) continue;
    if (name.startsWith('.') || SCANNER_OUTPUT.test(name)) continue;
    if (item instanceof Directory) {
      if (!relocateDir(item, new Directory(legacy, name), `Documents/${name}`, r => recoveredDir(support, now, r), log)) allMoved = false;
    } else {
      if (!moveAside(item, legacy, name, log, `Documents/${name}`, 'moved')) allMoved = false;
    }
  }
  if (!allMoved) return pending;
  const done: Marker = { ...pending, strays: 'done', straysAt: now };
  writeMarker(support, done);
  return done;
}

function recoveredDir(support: Directory, now: number, rel: string): Directory {
  return new Directory(support, RECOVERED_DIR_NAME, String(now), ...rel.split('/').filter(Boolean));
}

/**
 * Moves the app's data out of Documents (see the header). Safe to call any
 * number of times; does real work only when something is still in Documents.
 * Never throws. Normally called through the path getters below; exported for
 * tests and for the app's startup.
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
  const recovered = (rel: string) => recoveredDir(support, now, rel);
  try {
    support.create({ intermediates: true, idempotent: true });
    if (support.exists) {
      relocateDir(oldScan, newScan, SCAN_DIR_NAME, recovered, next);
      // Saved signatures: a convenience (two PNGs and an index).
      relocateDir(oldSigs, newSigs, SIGNATURES_DIR_NAME, recovered, next);
      const marker = moveDocumentsLeftovers(support, readMarker(support), next, now);
      if (!exists(oldScan, true) && !exists(oldSigs, true) && !marker.migratedAt) {
        writeMarker(support, { ...marker, migratedAt: now });
      }
    } else {
      next.errors.push('Application Support missing');
    }
  } catch (e) {
    next.errors.push(`migration: ${String(e)}`);
  }

  // Which folders to use follows from what is on disk now, whatever happened
  // above — never from what the steps meant to do.
  const oldScanLeft = exists(oldScan, true);
  if (!oldScanLeft) {
    next.scanRoot = newScan.uri; // made on demand on a fresh install
    next.state = 'app-support';
  } else if (exists(newScan, false)) {
    // Part merged: new folders go to the new root, old ones are still found.
    next.scanRoot = newScan.uri;
    next.legacyScanRoot = oldScan.uri;
    next.state = 'split';
  } // else nothing moved: stay in Documents ('documents'), try again next launch.
  // A signatures folder that couldn't be moved whole keeps being used as it is.
  next.signatures = (!exists(oldSigs, true) || exists(newSigs, false) ? newSigs : oldSigs).uri;
  const legacyDocs = new Directory(support, LEGACY_DOCS_DIR_NAME);
  next.legacyDocs = exists(legacyDocs, false) ? legacyDocs.uri : null;

  if (next.actions.length || next.errors.length) {
    console.log(`storage-layout: ${next.state}; ${next.actions.length} moved, ${next.errors.length} errors`, next.errors.slice(0, 5));
  }
  return report(next);
}

/** `dir.exists`, or `fallback` when even that can't be read. */
function exists(dir: Directory, fallback: boolean): boolean {
  try {
    return dir.exists;
  } catch {
    return fallback;
  }
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
    const rebuilt = slash(docDir(decoded).uri) + rest.slice(cut + 1);
    return rebuilt;
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

/** Tests only: forget the layout so the next call migrates again. */
export function resetStorageLayoutForTests(): void {
  layout = null;
}
