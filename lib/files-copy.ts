// lib/files-copy.ts
// "Keep a copy in Files" (Settings › Storage): an automatic backup with no
// account. Every document is kept as a searchable PDF at the top of the app's
// Documents folder, which the Files app shows as On My iPhone › Scan Kit
// (UIFileSharingEnabled and LSSupportsOpeningDocumentsInPlace in Info.plist),
// and from there it is included in device backups and can be moved to iCloud
// Drive or a computer. A copy is rewritten when its document changes and
// removed when the document is deleted.
//
// THE FOLDER IS THE USER'S. They can add files, make folders, and edit a copy
// in place (Markup). So this feature only ever replaces or removes a file it
// can positively identify as its own copy:
//  - it is in the manifest (Application Support/files-copy.json, written
//    atomically, synchronously, before and after every change on disk), AND
//  - it still matches the fingerprint recorded when it was written (size plus
//    modification date, or MD5). A copy the user edited no longer matches: it
//    becomes the user's file, is never overwritten or deleted, and the
//    document's copy continues under a free name ("Lease 2.pdf").
// A file the user put there under a name a copy wants is left alone the same
// way. The manifest's existence also tells lib/storage-layout.ts that
// Documents has been the user's for a while.
//
// PDFs are made in Caches/files-copy and renamed into the folder only once
// complete; the manifest records the coming file first (write-ahead), so an
// app killed between the two steps still recognises it on the next pass.
//
// The work is a reconcile pass (planFilesCopy), not a hook in every writer:
// it compares the live documents with the manifest, so it catches every kind
// of change wherever it was made. Passes are requested by the Home tab (focus,
// saves, background edits, returning to the app) and are debounced and
// serial; a request during a pass runs one more. Removals come first and are
// retried on every pass until the file is gone, so a deleted document's PDF
// never outlives a failed or cancelled pass.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import { getDocSettings, getDocuments } from './storage';
import { generatePdf } from './pdf';
import { ocrAvailable } from './ocr';
import { exportFileName } from './share';
import { planFilesCopy, type CopyEntry, type CopyManifest, type Fingerprint } from './files-copy-plan';
import { applicationSupportDir, FILES_COPY_MANIFEST_NAME, readJsonSync, writeJsonSync } from './storage-layout';

const ENABLED_KEY = '@scan_kit_files_copy';
/** Where builds before round 11 kept the manifest (moved to a file on first read). */
const LEGACY_MANIFEST_KEY = '@scan_kit_files_copy_manifest';

/** Where the copies go: the Documents folder itself, what Files shows as the app's folder. */
function copyDir(): Directory {
  return new Directory(Paths.document);
}

/** Where copies are made before they're renamed into the folder (swept at startup, lib/files.ts). */
function workDir(): Directory {
  const d = new Directory(Paths.cache, 'files-copy');
  d.create({ intermediates: true, idempotent: true });
  return d;
}

/**
 * Built in. The Info.plist keys that make Documents visible in Files are set
 * (app.json), and the app's own data lives in Application Support.
 */
export const FILES_COPY_AVAILABLE = true;

/**
 * Whether to offer the feature on this device: iOS only (the Files app). Not
 * tied to how far the move out of Documents got (lib/storage-layout.ts): the
 * switch must stay reachable — and passes must keep running — in every state,
 * or copies already made could never be updated or removed.
 */
export function filesCopyAvailable(): boolean {
  if (!FILES_COPY_AVAILABLE || Platform.OS !== 'ios') return false;
  try {
    return applicationSupportDir() !== null;
  } catch {
    return false;
  }
}

export async function getFilesCopyEnabled(): Promise<boolean> {
  if (!filesCopyAvailable()) return false;
  try {
    return (await AsyncStorage.getItem(ENABLED_KEY)) === '1';
  } catch {
    return false;
  }
}

// ── The manifest ─────────────────────────────────────────────────────────────

function manifestDir(): Directory | null {
  return applicationSupportDir();
}

function cleanManifest(raw: unknown): CopyManifest {
  const out: CopyManifest = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, e] of Object.entries(raw as Record<string, unknown>)) {
    if (!e || typeof e !== 'object') continue;
    const entry = e as CopyEntry;
    if (typeof entry.name !== 'string' || !entry.name || typeof entry.stamp !== 'number') continue;
    out[id] = entry;
  }
  return out;
}

/**
 * The manifest, from its file — or, the first time, from where older builds
 * kept it (AsyncStorage), moved into the file. Null when it can't be read:
 * then nothing may be removed or replaced this pass.
 */
async function readManifest(): Promise<CopyManifest | null> {
  const dir = manifestDir();
  if (!dir) return null;
  const read = readJsonSync<unknown>(dir, FILES_COPY_MANIFEST_NAME);
  if (read.state === 'ok') return cleanManifest(read.value);
  if (read.state === 'corrupt') return null;
  let legacy: CopyManifest = {};
  try {
    const raw = await AsyncStorage.getItem(LEGACY_MANIFEST_KEY);
    if (raw) legacy = cleanManifest(JSON.parse(raw));
  } catch {
    return null;
  }
  // Re-checked: another caller may have written the file meanwhile.
  const again = readJsonSync<unknown>(dir, FILES_COPY_MANIFEST_NAME);
  if (again.state === 'ok') return cleanManifest(again.value);
  if (Object.keys(legacy).length === 0) return {};
  if (!writeJsonSync(dir, FILES_COPY_MANIFEST_NAME, legacy)) return null;
  AsyncStorage.removeItem(LEGACY_MANIFEST_KEY).catch(() => {});
  return legacy;
}

function writeManifest(m: CopyManifest): boolean {
  const dir = manifestDir();
  return !!dir && writeJsonSync(dir, FILES_COPY_MANIFEST_NAME, m);
}

// ── Recognising our own files ───────────────────────────────────────────────

function fingerprint(f: File, withMd5 = true): Fingerprint | null {
  try {
    if (!f.exists) return null;
    const info = f.info();
    const size = typeof info.size === 'number' ? info.size : f.size;
    const mtime = typeof info.modificationTime === 'number' ? info.modificationTime : null;
    let md5: string | null = null;
    if (withMd5) {
      try { md5 = f.md5 ?? null; } catch {}
    }
    return { size, mtime, md5 };
  } catch {
    return null;
  }
}

/** True when the file `f` is (still) exactly the one `fp` describes. */
function matches(f: File, fp: Fingerprint): boolean {
  const now = fingerprint(f, false);
  if (!now || now.size !== fp.size) return false;
  if (fp.mtime !== null && now.mtime !== null && Math.abs(now.mtime - fp.mtime) < 1) return true;
  if (!fp.md5) return false;
  try {
    return f.md5 === fp.md5;
  } catch {
    return false;
  }
}

type Owned = 'ours' | 'gone' | 'not-ours';

/**
 * What the file under `entry.name` is now, settling a write-ahead record:
 * 'ours' (entry updated in place to describe it), 'gone', or 'not-ours' (the
 * user replaced or edited it: it is theirs now).
 */
function checkEntry(entry: CopyEntry): Owned {
  const f = new File(copyDir(), entry.name);
  let present: boolean;
  try {
    present = f.exists;
  } catch {
    return 'not-ours'; // can't tell: hands off
  }
  if (!present) return 'gone';
  if (entry.next && matches(f, entry.next.fp)) {
    entry.stamp = entry.next.stamp;
    entry.fp = entry.next.fp;
    delete entry.next;
    return 'ours';
  }
  delete entry.next;
  if (entry.fp === undefined) {
    // Recorded by an older build without a fingerprint: it wrote this file,
    // and nothing then could edit it unnoticed. Fingerprint it from now on.
    const fp = fingerprint(f);
    if (!fp) return 'not-ours';
    entry.fp = fp;
    return 'ours';
  }
  if (entry.fp === null) return 'not-ours'; // a first copy that never landed; someone else's file is there
  return matches(f, entry.fp) ? 'ours' : 'not-ours';
}

/** Names (lower-case) of everything in the folder, dot-files aside. Null when it can't be listed. */
function folderNames(): Set<string> | null {
  try {
    const dir = copyDir();
    if (!dir.exists) return new Set();
    const out = new Set<string>();
    for (const item of dir.list()) {
      const name = item.name ?? decodeURIComponent(item.uri.replace(/\/+$/, '').split('/').pop() ?? '');
      if (name && !name.startsWith('.')) out.add(name.toLowerCase());
    }
    return out;
  } catch {
    return null;
  }
}

function deleteQuietly(f: File): void {
  try { if (f.exists) f.delete(); } catch {}
}

// ── The reconcile pass ───────────────────────────────────────────────────────

let running: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Bumped by turning the feature off: a pass in flight stops at its next step. */
let generation = 0;

/**
 * Ask for a pass soon (debounced: a burst of edits makes one pass). Cheap to
 * call often; does nothing while the feature is off.
 */
export function requestFilesCopySync(delayMs = 2000): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runSync();
  }, delayMs);
}

/** Runs passes until no more were asked for. Resolves when idle. */
export function runSync(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await syncOnce().catch(err => { console.warn('files-copy pass failed', err); });
      } while (again);
    } finally {
      running = null;
    }
  })();
  return running;
}

async function syncOnce(): Promise<void> {
  // Before the first await: turning the feature off while the setting is
  // being read must still stop this pass.
  const gen = generation;
  if (!(await getFilesCopyEnabled()) || gen !== generation) return;
  const docs = await getDocuments();
  const manifest = await readManifest();
  if (!manifest) return; // can't tell what's ours: change nothing
  const present = folderNames();
  if (!present) return;

  // Settle every entry against the disk first.
  let changed = false;
  for (const [id, entry] of Object.entries(manifest)) {
    const before = JSON.stringify(entry);
    const state = checkEntry(entry);
    if (state !== 'ours') {
      // Gone (the user moved or deleted it), or the user's now (edited): forget it.
      delete manifest[id];
      changed = true;
    } else if (JSON.stringify(entry) !== before) {
      changed = true;
    }
  }
  if (changed && !writeManifest(manifest)) return;

  const owned = new Set(Object.values(manifest).map(e => e.name.toLowerCase()));
  const occupied = [...present].filter(n => !owned.has(n));
  const plan = planFilesCopy(docs, manifest, n => exportFileName(n, 'pdf'), occupied);
  if (!plan.remove.length && !plan.write.length) return;

  // Removals first, each checked again just before it happens.
  for (const r of plan.remove) {
    const entry = manifest[r.id];
    if (!entry || entry.name !== r.name) continue;
    if (checkEntry(entry) === 'ours') {
      const f = new File(copyDir(), entry.name);
      try {
        f.delete();
      } catch {
        continue; // kept in the manifest: tried again next pass
      }
    }
    delete manifest[r.id];
    if (!writeManifest(manifest)) return;
  }

  const byId = new Map(docs.map(d => [d.id, d]));
  for (const w of plan.write) {
    if (gen !== generation) return; // turned off meanwhile
    const doc = byId.get(w.id);
    if (!doc) continue;
    const temp = await makeCopy(doc);
    if (!temp) continue; // tried again on the next pass
    // By URI: a moved handle follows its file (expo updates it on move), so
    // deleting through it would delete the placed copy.
    const tempUri = temp.uri;
    try {
      if (gen !== generation) return; // turned off while it was being made
      placeCopy(manifest, w, temp);
    } finally {
      deleteQuietly(new File(tempUri));
    }
  }
}

/** Makes a document's PDF in Caches/files-copy. Null when it couldn't. */
async function makeCopy(doc: { pages: string[]; pdfUri?: string }): Promise<File | null> {
  let temp: File | null = null;
  try {
    temp = new File(workDir(), `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.pdf`);
    if (doc.pdfUri) {
      new File(doc.pdfUri.split('?')[0]).copy(temp);
    } else {
      const settings = await getDocSettings().catch(() => null);
      const out = await generatePdf(doc.pages, {
        pageSize: settings?.pdfPageSize ?? 'A4',
        quality: 'standard',
        searchable: ocrAvailable(),
      });
      new File(out.split('?')[0]).move(temp);
    }
    return new File(temp.uri);
  } catch {
    if (temp) deleteQuietly(temp);
    return null;
  }
}

/**
 * Renames a finished copy into the folder under `w.name` — replacing only a
 * copy of ours, checked right now — and records it. Synchronous, so nothing
 * else can run between the checks and the rename.
 */
function placeCopy(manifest: CopyManifest, w: { id: string; name: string; stamp: number }, temp: File): void {
  const dest = new File(copyDir(), w.name);
  const prev = manifest[w.id];
  let replacing = false;
  // Its old copy (another name) couldn't be removed this pass: keep it listed
  // and write the new one once it's gone, so it is never lost track of.
  if (prev && prev.name !== w.name) return;
  if (prev) {
    const state = checkEntry(prev);
    if (state === 'not-ours') {
      delete manifest[w.id]; // edited meanwhile: the user's now; the next pass picks a free name
      writeManifest(manifest);
      return;
    }
    replacing = state === 'ours';
  }
  if (!replacing && dest.exists) return; // someone else's file has the name: never replace it
  const fp = fingerprint(temp);
  if (!fp) return;
  // Write-ahead: whatever is found under this name next time is recognised.
  manifest[w.id] = {
    name: w.name,
    stamp: replacing && prev ? prev.stamp : -1,
    fp: replacing && prev ? prev.fp : null,
    next: { stamp: w.stamp, fp },
  };
  if (!writeManifest(manifest)) {
    if (prev) manifest[w.id] = prev;
    else delete manifest[w.id];
    return;
  }
  try {
    if (replacing) {
      const old = new File(copyDir(), w.name);
      if (old.exists) old.delete();
    }
    temp.move(new File(copyDir(), w.name));
  } catch {
    // The old copy may be gone and the new one not in place: the manifest
    // still describes both; the next pass settles it and writes again.
    return;
  }
  const placed = fingerprint(new File(copyDir(), w.name)) ?? fp;
  manifest[w.id] = { name: w.name, stamp: w.stamp, fp: placed };
  writeManifest(manifest);
}

// ── Turning it on and off ────────────────────────────────────────────────────

/** Turns the feature on (and makes every copy now) or off. */
export async function setFilesCopyEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    // From now on Documents holds the user's copies: the manifest's existence
    // tells the storage move never to treat the folder as the app's again.
    const m = await readManifest();
    if (m && Object.keys(m).length === 0) writeManifest({});
    await AsyncStorage.setItem(ENABLED_KEY, '1');
    requestFilesCopySync(0);
  } else {
    generation++;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await AsyncStorage.removeItem(ENABLED_KEY);
  }
}

/**
 * Deletes every copy this feature wrote and still recognises (after turning
 * it off, if the user asks). A copy the user has edited is theirs and stays.
 * Waits for a pass in flight first. Returns how many were removed.
 */
export async function removeFilesCopies(): Promise<number> {
  generation++;
  if (running) await running;
  const manifest = await readManifest();
  if (!manifest) throw new Error('files-copy: manifest unreadable');
  let removed = 0;
  for (const [id, entry] of Object.entries(manifest)) {
    const state = checkEntry(entry);
    if (state === 'ours') {
      try {
        new File(copyDir(), entry.name).delete();
        removed++;
      } catch {
        continue; // still ours, still listed: removable later
      }
    }
    delete manifest[id];
  }
  writeManifest(manifest);
  return removed;
}

/** How many copies are in Files now (from the manifest). */
export async function filesCopyCount(): Promise<number> {
  return Object.keys((await readManifest()) ?? {}).length;
}
