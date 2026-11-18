// lib/storage.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { File } from 'expo-file-system';
import { Document, PageAdjustment, PageFilter } from '../types/document';
import { deleteDocumentFiles, originalUri } from './files';
import { rebaseStoredUri } from './storage-layout';

const KEY = '@scan_kit_documents'; // legacy single-blob key — kept as a read-only backup, never written after migration
const DOC_INDEX_KEY = '@scan_kit_doc_index'; // JSON array of doc ids, newest-first
const DOC_PREFIX = '@scan_kit_doc:'; // per-document key prefix: `${DOC_PREFIX}${id}`
const SCHEMA_VERSION_KEY = '@scan_kit_schema_version';
// v3: filters/adjustments are now baked into page pixels via a WebView canvas
// instead of being applied at render time (RN's iOS filter style only honors
// brightness/opacity — grayscale/contrast/saturate silently no-op there). See
// pendingBakeMigrations below for the sweep that bakes anything a pre-v3 app
// only ever recorded as metadata.
const CURRENT_SCHEMA_VERSION = '3';
const SORT_KEY = '@scan_kit_sort';
/** Removed feature's secret; deleted on every launch (see ensureMigrated). */
const LEGACY_AI_KEY = '@scan_kit_ai_key';
const FOLDERS_KEY = '@scan_kit_folders';
const SCAN_SETTINGS_KEY = '@scan_kit_scan_settings';
const DOC_SETTINGS_KEY = '@scan_kit_doc_settings';
/** Ids of documents still being made (savePendingDocument): hidden, and purged at startup. */
const PENDING_KEY = '@scan_kit_pending_docs';

export type SortKey = 'dateAdded' | 'dateModified' | 'nameAZ';

export type ScanSettings = {
  quality: 'low' | 'medium' | 'high';
  autoCrop: boolean;
  defaultFilter: PageFilter;
};

export type DocSettings = {
  namePrefix: string;
  /** 'Auto' sizes PDF pages to match the scans (see lib/pdf.ts autoPaperSize). */
  pdfPageSize: 'Auto' | 'A4' | 'Letter';
  pdfQuality: 'standard' | 'high';
};

// Serialize all docs read-modify-write ops so concurrent mutations don't lose writes.
let _docsQueue: Promise<unknown> = Promise.resolve();
function withDocsLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = _docsQueue.then(fn, fn);
  _docsQueue = next.catch(() => {});
  return next;
}

const docKey = (id: string) => `${DOC_PREFIX}${id}`;

// ── Index helpers ────────────────────────────────────────────────────────────
// Read the id index. If the index is missing or corrupt, recover it by
// scanning for `@scan_kit_doc:` keys rather than reporting "no documents" —
// an empty answer here is what the startup orphan sweep acts on, so treating a
// lost index as empty would delete every document's files. Only fall back to
// [] when there are genuinely no doc keys.
async function readIndex(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(DOC_INDEX_KEY);
  if (raw == null) return recoverIndexFromKeys();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string');
    // Not an array → treat as corrupt and recover below.
    throw new Error('index is not an array');
  } catch {
    console.warn('storage: corrupt doc index, attempting recovery from doc keys');
    return recoverIndexFromKeys();
  }
}

// Rebuild an index by scanning all `@scan_kit_doc:` keys. Order is best-effort
// (newest-first not recoverable here) — callers re-sort anyway. The rebuilt
// index is persisted so the recovery cost is paid once.
async function recoverIndexFromKeys(): Promise<string[]> {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const ids = allKeys
      .filter(k => k.startsWith(DOC_PREFIX))
      .map(k => k.slice(DOC_PREFIX.length));
    if (ids.length === 0) return [];
    await AsyncStorage.setItem(DOC_INDEX_KEY, JSON.stringify(ids));
    return ids;
  } catch (e) {
    console.warn('storage: index recovery failed', e);
    return [];
  }
}

async function writeIndex(ids: string[]): Promise<void> {
  await AsyncStorage.setItem(DOC_INDEX_KEY, JSON.stringify(ids));
}

// ── One-time migration: legacy single-blob → per-doc keys + index ────────────
// Memoized so it runs at most once per process and is safe under concurrency.
let _migrated: Promise<void> | null = null;

function ensureMigrated(): Promise<void> {
  if (!_migrated) {
    _migrated = (async () => {
      try {
        // Builds that had "Ask AI" kept the user's API key here in plain text.
        // The feature is gone, so the key must not linger on the device.
        await AsyncStorage.removeItem(LEGACY_AI_KEY).catch(() => {});

        const version = await AsyncStorage.getItem(SCHEMA_VERSION_KEY);
        if (version === CURRENT_SCHEMA_VERSION) return;

        // v1 → v2: fold the legacy single-blob store into per-doc keys + an index.
        //
        // This ONLY runs for an install that has no schema version at all. A v2+
        // install already keeps its documents in per-doc keys with a populated
        // index and has no legacy blob, so running this on it would fall through
        // to writeIndex([]) and erase every document from the app — the data keys
        // would survive but readIndex only self-heals corrupt JSON, not a valid
        // empty array, so nothing would be reachable again.
        if (version == null) {
          const legacyRaw = await AsyncStorage.getItem(KEY);
          let legacyDocs: Document[] = [];
          if (legacyRaw != null) {
            try {
              const parsed = JSON.parse(legacyRaw);
              if (Array.isArray(parsed)) legacyDocs = parsed;
            } catch {
              // Corrupt legacy blob — leave it untouched and start fresh below.
              console.warn('storage: corrupt legacy documents blob during migration; starting with empty index');
            }
          }

          if (legacyDocs.length > 0) {
            const pairs: [string, string][] = legacyDocs.map(d => [docKey(d.id), JSON.stringify(d)]);
            await AsyncStorage.multiSet(pairs);
            await writeIndex(legacyDocs.map(d => d.id));
          } else if ((await AsyncStorage.getItem(DOC_INDEX_KEY)) == null) {
            // Fresh install: initialise an empty index. Never overwrite one that
            // already exists.
            await writeIndex([]);
          }
        }

        // v2 → v3: filters moved from render-time to baked-in pixels. Nothing to
        // rewrite in storage — the per-page pixel work is reported by
        // pendingBakeMigrations and performed by the app, so this step only
        // records the new version.

        // NOTE: legacy KEY is intentionally NOT deleted — it stays as a backup.
        await AsyncStorage.setItem(SCHEMA_VERSION_KEY, CURRENT_SCHEMA_VERSION);
      } catch (e) {
        // Never crash the app on migration failure; leave storage as-is and let
        // a later call retry by clearing the memo.
        console.warn('storage: migration failed, leaving data as-is', e);
        _migrated = null;
      }
    })();
  }
  return _migrated;
}


// ── Container-relative path healing ──────────────────────────────────────────
// Stored records hold absolute file:// URIs, and those go stale two ways:
//  - iOS does not guarantee the app's container path is stable. It changes on
//    reinstall, on restore from backup, on device migration, and can change on
//    update — including between TestFlight builds;
//  - the app's files moved from Documents/ to Library/Application Support/
//    (lib/storage-layout.ts) so the Files app never shows them.
// Every path this app owns is derivable — <root>/scan-kit/<docId>/… — so every
// stored URI is re-anchored to where the file is NOW on every read
// (rebaseStoredUri), and every write stores the re-anchored form, so an old
// record is rewritten on its next save. URIs outside scan-kit/ (an external
// file the user picked) are left alone.

/** Returns a document whose page/pdf URIs point at the current location. */
export function healDocPaths(doc: Document): Document {
  const pages = Array.isArray(doc.pages) ? doc.pages.map(rebaseStoredUri) : doc.pages;
  const pdfUri = doc.pdfUri ? rebaseStoredUri(doc.pdfUri) : doc.pdfUri;
  return { ...doc, pages, pdfUri };
}

// ── Document CRUD (per-doc keys + id index) ──────────────────────────────────

// Core read used by getDocuments and by other already-locked writers
// (e.g. deleteFolder). Caller is responsible for holding withDocsLock and
// having run ensureMigrated().
async function getDocumentsUnlocked(): Promise<Document[]> {
  const index = await readIndex();
  if (index.length === 0) return [];

  const pairs = await AsyncStorage.multiGet(index.map(docKey));
  const docs: Document[] = [];
  const survivors: string[] = [];
  let healed = false;

  // pairs are returned in the same order as the requested keys.
  for (let i = 0; i < index.length; i++) {
    const value = pairs[i]?.[1] ?? null;
    if (value == null) {
      // Dangling index entry (data key missing) — drop it.
      healed = true;
      continue;
    }
    try {
      docs.push(healDocPaths(JSON.parse(value) as Document));
      survivors.push(index[i]);
    } catch {
      // Corrupt single doc — skip it but keep the rest of the read alive.
      console.warn(`storage: corrupt doc ${index[i]}, skipping`);
      healed = true;
    }
  }

  // Self-heal: rewrite the index without the dangling/corrupt entries.
  if (healed) await writeIndex(survivors);
  return docs;
}

/**
 * Every live document. Documents in "Recently deleted" are excluded, so every
 * list, search and tool that starts from here never sees them.
 */
export function getDocuments(): Promise<Document[]> {
  return withDocsLock(async () => {
    await ensureMigrated();
    const pending = new Set(await readPendingUnlocked());
    return (await getDocumentsUnlocked()).filter(d => d.trashedAt == null && !pending.has(d.id));
  });
}

// ── Pending documents ────────────────────────────────────────────────────────
// A document that is saved before it is finished (Sign / Watermark / Timestamp
// "Save as a copy" draws into the copy's pages after creating it) is saved as
// pending: getDocument finds it, so the work can run on it, but no list shows
// it. commitPendingDocument makes it a normal document. A crash before that
// leaves it pending, and the startup sweep (documentIdsForCleanup) deletes it,
// so a half-made copy never shows up.

async function readPendingUnlocked(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function writePendingUnlocked(ids: string[]): Promise<void> {
  if (ids.length) await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(ids));
  else await AsyncStorage.removeItem(PENDING_KEY);
}

async function unmarkPendingUnlocked(ids: string[]): Promise<void> {
  const pending = await readPendingUnlocked();
  if (!pending.some(id => ids.includes(id))) return;
  await writePendingUnlocked(pending.filter(id => !ids.includes(id)));
}

/** Saves a new document hidden and marked pending (see above). The mark is written first. */
export function savePendingDocument(doc: Document): Promise<void> {
  return withDocsLock(async () => {
    await ensureMigrated();
    const pending = await readPendingUnlocked();
    if (!pending.includes(doc.id)) await writePendingUnlocked([...pending, doc.id]);
    await AsyncStorage.setItem(docKey(doc.id), JSON.stringify(doc));
    const index = await readIndex();
    await writeIndex([doc.id, ...index.filter(id => id !== doc.id)]);
  });
}

/**
 * Makes a pending document a normal one, merging `patch` in under the same
 * lock. False (and nothing written) when its record is gone.
 */
export function commitPendingDocument(id: string, patch: Partial<Document> = {}): Promise<boolean> {
  return withDocsLock(async () => {
    await ensureMigrated();
    const raw = await AsyncStorage.getItem(docKey(id));
    if (raw == null) return false;
    try {
      await AsyncStorage.setItem(docKey(id), JSON.stringify(healDocPaths({ ...(JSON.parse(raw) as Document), ...patch, id })));
    } catch {
      return false;
    }
    await unmarkPendingUnlocked([id]);
    return true;
  }).then(ok => {
    if (ok) notifyDocumentChanged(id);
    return ok;
  });
}

/** Deletes every pending document (record, then files). Caller holds withDocsLock. */
async function purgePendingUnlocked(): Promise<string[]> {
  const pending = await readPendingUnlocked();
  if (!pending.length) return [];
  await removeRecordsUnlocked(pending);
  deleteFilesQuietly(pending);
  await writePendingUnlocked([]);
  return pending;
}

/** One live document by id, or null when it is missing or in the trash. */
export function getDocument(id: string): Promise<Document | null> {
  return withDocsLock(async () => {
    await ensureMigrated();
    const raw = await AsyncStorage.getItem(docKey(id));
    if (raw == null) return null;
    try {
      const doc = healDocPaths(JSON.parse(raw) as Document);
      return doc.trashedAt == null ? doc : null;
    } catch {
      console.warn(`storage: corrupt doc ${id}`);
      return null;
    }
  });
}

export function saveDocument(doc: Document): Promise<void> {
  return withDocsLock(async () => {
    await ensureMigrated();
    await AsyncStorage.setItem(docKey(doc.id), JSON.stringify(healDocPaths(doc)));
    const index = await readIndex();
    // Prepend, dedupe (keep at front if it was already present).
    await writeIndex([doc.id, ...index.filter(id => id !== doc.id)]);
  });
}

/**
 * Replaces an EXISTING document. Refuses (resolves false, writes nothing) when
 * the id is no longer stored — a stale screen saving a document that was
 * deleted meanwhile must not resurrect it as a "ghost" whose files are gone.
 * Use saveDocument to create a document.
 */
export function updateDocument(doc: Document): Promise<boolean> {
  return withDocsLock(async () => {
    await ensureMigrated();
    if ((await AsyncStorage.getItem(docKey(doc.id))) == null) return false;
    await AsyncStorage.setItem(docKey(doc.id), JSON.stringify(healDocPaths(doc)));
    const index = await readIndex();
    // Ensure the id is present (append if somehow missing) without reordering.
    if (!index.includes(doc.id)) await writeIndex([...index, doc.id]);
    return true;
  });
}

/**
 * Merge a partial update onto a document by id inside a SINGLE lock acquisition,
 * so a concurrent write can't be lost to a stale read-modify-write. No-op if the
 * document no longer exists (e.g. deleted while a background pass was running).
 */
export function patchDocument(id: string, patch: Partial<Document>): Promise<boolean> {
  return updateDocumentWith(id, () => patch);
}

// ── Change notifications ──────────────────────────────────────────────────────
// Background writes (OCR indexing, auto-rename) land while a screen is showing
// the document; screens subscribe so they re-read instead of showing stale data.
const docChangeListeners = new Set<(id: string) => void>();

/** Subscribe to background updates of stored documents. Returns an unsubscribe fn. */
export function subscribeDocumentChanges(listener: (id: string) => void): () => void {
  docChangeListeners.add(listener);
  return () => {
    docChangeListeners.delete(listener);
  };
}

function notifyDocumentChanged(id: string): void {
  for (const l of docChangeListeners) {
    try {
      l(id);
    } catch {
      // a listener's failure must not affect the write or other listeners
    }
  }
}

/**
 * Like patchDocument, but the patch is computed from the CURRENT stored record
 * inside the same lock acquisition — for conditional updates such as "rename
 * only if the user hasn't". Return null from `fn` to write nothing. Keys set to
 * `undefined` in the patch are removed from the record.
 */
export function updateDocumentWith(
  id: string,
  fn: (current: Document) => Partial<Document> | null,
): Promise<boolean> {
  return withDocsLock(async () => {
    await ensureMigrated();
    const raw = await AsyncStorage.getItem(docKey(id));
    if (raw == null) return false; // deleted or never existed — don't resurrect
    let current: Document;
    try {
      current = JSON.parse(raw) as Document;
    } catch {
      console.warn(`storage: corrupt doc ${id}, skipping patch`);
      return false;
    }
    const healed = healDocPaths(current);
    const patch = fn(healed);
    if (!patch) return false;
    // The healed paths are written back, so the record no longer depends on healing.
    await AsyncStorage.setItem(docKey(id), JSON.stringify(healDocPaths({ ...healed, ...patch })));
    return true;
  }).then(written => {
    if (written) notifyDocumentChanged(id);
    return written;
  });
}

/**
 * Document ids whose folders the startup orphan sweep must keep, or null when
 * it is not safe to sweep at all. Sweeping deletes every doc folder not in the
 * list, so the answer is every id that has a stored record — parsed or not, in
 * the trash or not. A record that fails to parse is dropped from the index but
 * its key stays, so its files are kept for a later repair instead of swept.
 *
 * Expired trash is purged first (see purgeExpiredTrash), so its folders are
 * swept along with any other orphans.
 */
export function documentIdsForCleanup(): Promise<string[] | null> {
  return withDocsLock(async () => {
    await ensureMigrated();
    try {
      await purgeExpiredTrashUnlocked(TRASH_RETENTION_DAYS, Date.now());
    } catch (e) {
      console.warn('storage: trash purge failed', e);
    }
    try {
      // Copies whose making was interrupted (see savePendingDocument).
      await purgePendingUnlocked();
    } catch (e) {
      console.warn('storage: pending purge failed', e);
    }
    const index = await readIndex();
    let keys: readonly string[];
    try {
      keys = await AsyncStorage.getAllKeys();
    } catch {
      return null; // can't see every record — don't sweep anything
    }
    const ids = new Set(index);
    for (const k of keys) if (k.startsWith(DOC_PREFIX)) ids.add(k.slice(DOC_PREFIX.length));
    return [...ids];
  });
}

/**
 * Every document id that has a stored record (parsed or not, trashed or not,
 * pending or not), or null when the keys can't be read. READ-ONLY: unlike
 * documentIdsForCleanup it purges nothing, so screens can call it any time
 * (Settings › Recovered files counts on every focus of the Me tab; purging
 * there would delete a copy still being made, r11 #4).
 */
export function storedDocumentIds(): Promise<string[] | null> {
  return withDocsLock(async () => {
    await ensureMigrated();
    const index = await readIndex();
    let keys: readonly string[];
    try {
      keys = await AsyncStorage.getAllKeys();
    } catch {
      return null;
    }
    const ids = new Set(index);
    for (const k of keys) if (k.startsWith(DOC_PREFIX)) ids.add(k.slice(DOC_PREFIX.length));
    return [...ids];
  });
}

/**
 * What each document's record points at (pages and PDF), trashed documents
 * included, for the startup sweep of files a record no longer references
 * (lib/files.ts sweepConvertLeftovers). Records that don't parse are left
 * out, so their folders are never touched. Null when the records can't be read.
 */
export function documentFileRefsForCleanup(): Promise<
  { id: string; pages: string[]; pdfUri?: string; updatedAt: number }[] | null
> {
  return withDocsLock(async () => {
    await ensureMigrated();
    let keys: readonly string[];
    try {
      keys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(DOC_PREFIX));
    } catch {
      return null;
    }
    const pairs = await AsyncStorage.multiGet(keys);
    const out: { id: string; pages: string[]; pdfUri?: string; updatedAt: number }[] = [];
    for (const [key, value] of pairs) {
      if (value == null) continue;
      try {
        const doc = healDocPaths(JSON.parse(value) as Document);
        if (!doc || typeof doc.id !== 'string' || !Array.isArray(doc.pages)) continue;
        out.push({ id: doc.id, pages: doc.pages, pdfUri: doc.pdfUri, updatedAt: doc.updatedAt ?? 0 });
      } catch {
        console.warn(`storage: corrupt doc ${key.slice(DOC_PREFIX.length)}, kept out of the sweep`);
      }
    }
    return out;
  });
}

/**
 * Reads document `id`'s file references afresh and runs `act` on them inside
 * the docs lock, so no record write lands between the read and what `act`
 * does with the files (lib/files.ts sweepConvertLeftovers deletes strays this
 * way). Trashed documents included. `act` gets null when the record is gone or
 * doesn't parse, and must be synchronous: the lock is held only until it returns.
 */
export function withDocumentFileRefs<T>(
  id: string,
  act: (fresh: { id: string; pages: string[]; pdfUri?: string; updatedAt: number } | null) => T,
): Promise<T> {
  return withDocsLock(async () => {
    await ensureMigrated();
    let refs: { id: string; pages: string[]; pdfUri?: string; updatedAt: number } | null = null;
    try {
      const raw = await AsyncStorage.getItem(docKey(id));
      if (raw != null) {
        const doc = healDocPaths(JSON.parse(raw) as Document);
        if (doc && doc.id === id && Array.isArray(doc.pages)) {
          refs = { id: doc.id, pages: doc.pages, pdfUri: doc.pdfUri, updatedAt: doc.updatedAt ?? 0 };
        }
      }
    } catch {
      console.warn(`storage: corrupt doc ${id}, kept out of the sweep`);
    }
    return act(refs);
  });
}

// ── Recently deleted (trash) ─────────────────────────────────────────────────
// Deleting a document moves it to the trash: the record and files stay, the
// record gets `trashedAt`, and getDocuments stops returning it. It can be
// restored until it is purged — by the user (deleteForever / emptyTrash) or
// automatically TRASH_RETENTION_DAYS after it was trashed (purgeExpiredTrash,
// run by the startup sweep). Trashed ids stay in documentIdsForCleanup, so the
// orphan sweep never touches their files.

/** Days a trashed document is kept before it is purged automatically. */
export const TRASH_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function isExpired(doc: Document, days: number, now: number): boolean {
  return doc.trashedAt != null && now - doc.trashedAt >= days * DAY_MS;
}

/** Moves documents to "Recently deleted". Returns how many were moved. */
export function trashDocuments(ids: string[]): Promise<number> {
  return withDocsLock(async () => {
    await ensureMigrated();
    const now = Date.now();
    const pairs = await AsyncStorage.multiGet(ids.map(docKey));
    const changed: [string, string][] = [];
    for (const [key, raw] of pairs) {
      if (raw == null) continue;
      try {
        const doc = JSON.parse(raw) as Document;
        if (doc.trashedAt != null) continue;
        changed.push([key, JSON.stringify(healDocPaths({ ...doc, trashedAt: now }))]);
      } catch {
        console.warn(`storage: corrupt doc ${key}, not trashed`);
      }
    }
    if (changed.length) await AsyncStorage.multiSet(changed);
    return changed.length;
  });
}

/** Moves one document to "Recently deleted". False when it doesn't exist. */
export async function trashDocument(id: string): Promise<boolean> {
  return (await trashDocuments([id])) > 0;
}

/** Brings trashed documents back. Returns how many were restored. */
export function restoreDocuments(ids: string[]): Promise<number> {
  return withDocsLock(async () => {
    await ensureMigrated();
    const pairs = await AsyncStorage.multiGet(ids.map(docKey));
    const changed: [string, string][] = [];
    for (const [key, raw] of pairs) {
      if (raw == null) continue;
      try {
        const { trashedAt, ...doc } = JSON.parse(raw) as Document;
        if (trashedAt == null) continue;
        // Folder renames and deletions already reached it while it was in the
        // trash (they update every record), so it returns to the right place.
        changed.push([key, JSON.stringify(healDocPaths(doc))]);
      } catch {
        console.warn(`storage: corrupt doc ${key}, not restored`);
      }
    }
    if (changed.length) await AsyncStorage.multiSet(changed);
    return changed.length;
  });
}

/** Brings one trashed document back. False when it isn't in the trash. */
export async function restoreDocument(id: string): Promise<boolean> {
  return (await restoreDocuments([id])) > 0;
}

/**
 * Documents in "Recently deleted", most recently trashed first. Ones already
 * past the retention period (about to be purged) are left out.
 */
export function getTrashedDocuments(now: number = Date.now()): Promise<Document[]> {
  return withDocsLock(async () => {
    await ensureMigrated();
    return (await getDocumentsUnlocked())
      .filter(d => d.trashedAt != null && !isExpired(d, TRASH_RETENTION_DAYS, now))
      .sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0));
  });
}

/** Days left before a trashed document is purged (0 = today). */
export function trashDaysLeft(doc: Pick<Document, 'trashedAt'>, now: number = Date.now()): number {
  if (doc.trashedAt == null) return TRASH_RETENTION_DAYS;
  const left = TRASH_RETENTION_DAYS - (now - doc.trashedAt) / DAY_MS;
  return Math.min(TRASH_RETENTION_DAYS, Math.max(0, Math.ceil(left)));
}

// Removes the records and their index entries. Caller holds withDocsLock.
async function removeRecordsUnlocked(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const set = new Set(ids);
  await AsyncStorage.multiRemove(ids.map(docKey));
  const index = await readIndex();
  await writeIndex(index.filter(x => !set.has(x)));
  await unmarkPendingUnlocked(ids);
}

function deleteFilesQuietly(ids: string[]): void {
  for (const id of ids) {
    try { deleteDocumentFiles(id); } catch (e) { console.warn(`storage: couldn't delete files of ${id}`, e); }
  }
}

/**
 * Permanently deletes documents — record first, then files — whether or not
 * they are in the trash. Cannot be undone. A crash between the two steps only
 * leaves an orphan folder, which the startup sweep removes.
 */
export async function deleteForeverMany(ids: string[]): Promise<void> {
  await withDocsLock(async () => {
    await ensureMigrated();
    await removeRecordsUnlocked(ids);
  });
  deleteFilesQuietly(ids);
}

/** Permanently deletes one document and its files. Cannot be undone. */
export function deleteForever(id: string): Promise<void> {
  return deleteForeverMany([id]);
}

/** Permanently deletes everything in "Recently deleted". Returns the count. */
export async function emptyTrash(): Promise<number> {
  const ids = await withDocsLock(async () => {
    await ensureMigrated();
    const trashed = (await getDocumentsUnlocked()).filter(d => d.trashedAt != null).map(d => d.id);
    await removeRecordsUnlocked(trashed);
    return trashed;
  });
  deleteFilesQuietly(ids);
  return ids.length;
}

async function purgeExpiredTrashUnlocked(days: number, now: number): Promise<string[]> {
  const expired = (await getDocumentsUnlocked()).filter(d => isExpired(d, days, now)).map(d => d.id);
  await removeRecordsUnlocked(expired);
  deleteFilesQuietly(expired);
  return expired;
}

/**
 * Permanently deletes documents that have been in the trash for `days` or
 * more. Runs at startup as part of documentIdsForCleanup; safe to call any
 * time. Returns how many were purged.
 */
export async function purgeExpiredTrash(days: number = TRASH_RETENTION_DAYS, now: number = Date.now()): Promise<number> {
  return withDocsLock(async () => {
    await ensureMigrated();
    return (await purgeExpiredTrashUnlocked(days, now)).length;
  });
}

/**
 * Records that page `pageIndex` now has `filter`/`adjustment` baked into its
 * pixels. Models `patchDocument`'s single-lock read-modify-write, but since
 * `document.filters`/`document.adjustments` are ARRAYS shared across all
 * pages, this must build the new array from the current one under the SAME
 * lock acquisition as the read — otherwise two sibling pages baking
 * concurrently (or a rename landing mid-bake) could clobber each other via a
 * stale read-modify-write. No-op if the document was deleted mid-bake, and
 * tolerates a corrupt record the way `patchDocument` does.
 */
export function setPageBaked(
  id: string,
  pageIndex: number,
  filter: PageFilter,
  adjustment: PageAdjustment | undefined,
): Promise<void> {
  return withDocsLock(async () => {
    await ensureMigrated();
    const raw = await AsyncStorage.getItem(docKey(id));
    if (raw == null) return; // deleted or never existed — don't resurrect
    let current: Document;
    try {
      current = JSON.parse(raw) as Document;
    } catch {
      console.warn(`storage: corrupt doc ${id}, skipping setPageBaked`);
      return;
    }

    const filters = current.filters ?? current.pages.map((): PageFilter => 'original');
    const newFilters = [...filters];
    newFilters[pageIndex] = filter;
    const allOriginal = newFilters.every(f => f === 'original');

    const patch: Partial<Document> = {
      filters: allOriginal ? undefined : newFilters,
      updatedAt: Date.now(),
    };

    if (adjustment !== undefined) {
      const adjustments = current.adjustments ?? current.pages.map(
        (): PageAdjustment => ({ brightness: 0, contrast: 0, saturation: 0 })
      );
      const newAdjustments = [...adjustments];
      newAdjustments[pageIndex] = adjustment;
      patch.adjustments = newAdjustments;
    }

    await AsyncStorage.setItem(docKey(id), JSON.stringify(healDocPaths({ ...current, ...patch })));
  });
}

function isDefaultAdjustment(adj: PageAdjustment | undefined): boolean {
  return !adj || (adj.brightness === 0 && adj.contrast === 0 && adj.saturation === 0);
}

/**
 * True when a page's pixels can't carry a recorded non-original look: there is
 * no `.orig` (it was never baked), or the page is byte-for-byte its `.orig`
 * (a bake made the shadow and then failed, timed out or was killed before it
 * wrote the filtered pixels). A real bake always re-encodes the page, so it
 * never stays identical to its shadow.
 */
function pixelsLackLook(docId: string, pageIndex: number, pageUri: string): boolean {
  const orig = new File(originalUri(docId, pageIndex));
  if (!orig.exists) return true;
  const page = new File(pageUri.split('?')[0]);
  if (!page.exists) return false; // nothing to bake into; leave it alone
  if (page.size == null || orig.size == null || page.size !== orig.size) return false;
  return page.md5 != null && page.md5 === orig.md5;
}

/**
 * Self-heal sweep: every page whose metadata records a look (a non-`original`
 * filter or a non-default adjustment) that its pixels don't actually have.
 * Two ways to get there:
 *  - a page saved by a pre-v3 app, which only ever recorded the filter as
 *    metadata and applied it at render time (now removed; see lib/filters.ts);
 *  - a page whose metadata was written before a bake that then never finished
 *    (older builds recorded a new scan's default filter up front).
 * Detection looks at the files, not a flag (see pixelsLackLook), so the sweep
 * is idempotent: re-running it after a partial drain only returns the pages
 * still outstanding. A caller with a mounted WebView (app/_layout.tsx) drains
 * the result through bakePage; it can't bake here — that needs a WebView.
 *
 * Trashed documents are skipped. Each document is swept inside its own
 * try/catch so one malformed record can't abort the rest.
 */
export async function pendingBakeMigrations(): Promise<
  { docId: string; pageIndex: number; filter: PageFilter; adjustment?: PageAdjustment }[]
> {
  const docs = await getDocuments();
  const pending: { docId: string; pageIndex: number; filter: PageFilter; adjustment?: PageAdjustment }[] = [];

  for (const doc of docs) {
    try {
      const filters = doc.filters;
      const adjustments = doc.adjustments;
      if (!filters && !adjustments) continue; // nothing but 'original'/defaults recorded

      for (let i = 0; i < doc.pages.length; i++) {
        const filter: PageFilter = filters?.[i] ?? 'original';
        const adjustment = adjustments?.[i];
        if (filter === 'original' && isDefaultAdjustment(adjustment)) continue;
        if (!pixelsLackLook(doc.id, i, doc.pages[i])) continue; // already baked
        pending.push({ docId: doc.id, pageIndex: i, filter, adjustment });
      }
    } catch (e) {
      console.warn(`storage: pendingBakeMigrations skipping doc ${doc.id}`, e);
    }
  }

  return pending;
}

export function deleteDocument(id: string): Promise<void> {
  return deleteDocuments([id]);
}

export function deleteDocuments(ids: string[]): Promise<void> {
  return withDocsLock(async () => {
    await ensureMigrated();
    await removeRecordsUnlocked(ids);
  });
}

export async function getSortPreference(): Promise<SortKey> {
  const raw = await AsyncStorage.getItem(SORT_KEY);
  if (raw === 'dateModified' || raw === 'nameAZ') return raw;
  return 'dateAdded';
}

export async function saveSortPreference(key: SortKey): Promise<void> {
  await AsyncStorage.setItem(SORT_KEY, key);
}

export async function getFolders(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(FOLDERS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...parsed].sort();
  } catch {
    return [];
  }
}

export function saveFolder(name: string): Promise<void> {
  // Shares the docs lock because deleteFolder also writes both keys; using one
  // lock for both keeps the two writers strictly ordered.
  return withDocsLock(async () => {
    const folders = await getFolders();
    if (folders.includes(name)) return;
    await AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify([...folders, name]));
  });
}

/**
 * Renames a folder and moves every document in it to the new name, under one
 * lock. If `to` already exists the two folders are merged. Returns false when
 * the new name is empty or unchanged.
 */
export function renameFolder(from: string, to: string): Promise<boolean> {
  const next = to.trim();
  return withDocsLock(async () => {
    if (!next || next === from) return false;
    await ensureMigrated();
    const folders = await getFolders();
    const renamed = folders.filter(f => f !== from && f !== next);
    await AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify([...renamed, next]));
    const docs = await getDocumentsUnlocked();
    const changed: [string, string][] = [];
    for (const d of docs) {
      if (d.folder !== from) continue;
      changed.push([docKey(d.id), JSON.stringify({ ...d, folder: next })]);
    }
    if (changed.length > 0) await AsyncStorage.multiSet(changed);
    return true;
  });
}

export function deleteFolder(name: string): Promise<void> {
  return withDocsLock(async () => {
    await ensureMigrated();
    // Remove from folders list
    const folders = await getFolders();
    await AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify(folders.filter(f => f !== name)));
    // Clear the folder field on every doc that had this folder, writing only the
    // changed docs back via their per-id keys (no global rewrite).
    const docs = await getDocumentsUnlocked();
    const changed: [string, string][] = [];
    for (const d of docs) {
      if (d.folder !== name) continue;
      const { folder: _removed, ...rest } = d;
      changed.push([docKey(d.id), JSON.stringify(rest as Document)]);
    }
    if (changed.length > 0) await AsyncStorage.multiSet(changed);
  });
}

// 'medium' is shown as "High" in Scan settings: sharp text at about half the size of "Best".
const DEFAULT_SCAN_SETTINGS: ScanSettings = { quality: 'medium', autoCrop: true, defaultFilter: 'enhanced' };

export async function getScanSettings(): Promise<ScanSettings> {
  const raw = await AsyncStorage.getItem(SCAN_SETTINGS_KEY);
  if (!raw) return DEFAULT_SCAN_SETTINGS;
  try {
    return { ...DEFAULT_SCAN_SETTINGS, ...JSON.parse(raw) };
  } catch {
    console.warn('storage: corrupt scan settings, resetting to defaults');
    await AsyncStorage.setItem(SCAN_SETTINGS_KEY, JSON.stringify(DEFAULT_SCAN_SETTINGS));
    return DEFAULT_SCAN_SETTINGS;
  }
}

export async function saveScanSettings(s: ScanSettings): Promise<void> {
  await AsyncStorage.setItem(SCAN_SETTINGS_KEY, JSON.stringify(s));
}

const DEFAULT_DOC_SETTINGS: DocSettings = { namePrefix: 'Scan', pdfPageSize: 'Auto', pdfQuality: 'standard' };

export async function getDocSettings(): Promise<DocSettings> {
  const raw = await AsyncStorage.getItem(DOC_SETTINGS_KEY);
  if (!raw) return DEFAULT_DOC_SETTINGS;
  try {
    return { ...DEFAULT_DOC_SETTINGS, ...JSON.parse(raw) };
  } catch {
    console.warn('storage: corrupt doc settings, resetting to defaults');
    await AsyncStorage.setItem(DOC_SETTINGS_KEY, JSON.stringify(DEFAULT_DOC_SETTINGS));
    return DEFAULT_DOC_SETTINGS;
  }
}

export async function saveDocSettings(s: DocSettings): Promise<void> {
  await AsyncStorage.setItem(DOC_SETTINGS_KEY, JSON.stringify(s));
}

const THEME_KEY = '@scan_kit_theme';
type ThemePreference = 'light' | 'dark' | 'system';

// In-memory cache so ThemeProvider can read synchronously on every render
// after the first async load — prevents the light→dark flash on nav push.
let _themePrefCache: ThemePreference = 'system';
// Monotonic version: any write bumps it; reads only write the cache if the
// version hasn't changed since the read started. Prevents a stale getter
// from clobbering a more recent saveThemePreference value.
let _themePrefVersion = 0;
let _themePrefQueue: Promise<unknown> = Promise.resolve();

function withThemeLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = _themePrefQueue.then(fn, fn);
  _themePrefQueue = next.catch(() => {});
  return next;
}

export function getThemePreferenceSync(): ThemePreference {
  return _themePrefCache;
}

export function getThemePreference(): Promise<ThemePreference> {
  return withThemeLock(async () => {
    const versionAtStart = _themePrefVersion;
    const raw = await AsyncStorage.getItem(THEME_KEY);
    const pref: ThemePreference = (raw === 'light' || raw === 'dark' || raw === 'system') ? raw : 'system';
    // Only update the cache if no write has happened since we started.
    if (_themePrefVersion === versionAtStart) {
      _themePrefCache = pref;
    }
    return pref;
  });
}

export function saveThemePreference(p: ThemePreference): Promise<void> {
  return withThemeLock(async () => {
    _themePrefVersion++;
    _themePrefCache = p;
    await AsyncStorage.setItem(THEME_KEY, p);
  });
}

// ── First-run onboarding flag ────────────────────────────────────────────────
const ONBOARDED_KEY = '@scan_kit_onboarded';

// In-memory mirror so the onboarding gate can consult the *current* value
// synchronously. Without it the gate keeps its mount-time `false` after
// setOnboarded() runs and redirects the user straight back into onboarding,
// making first run impossible to complete without force-quitting.
let _onboardedCache: boolean | null = null;

export function getOnboardedSync(): boolean | null {
  return _onboardedCache;
}

export async function getOnboarded(): Promise<boolean> {
  try {
    const v = (await AsyncStorage.getItem(ONBOARDED_KEY)) === '1';
    _onboardedCache = v;
    return v;
  } catch {
    return false;
  }
}

export async function setOnboarded(): Promise<void> {
  // Set before the await so a redirect racing this write still sees `true`.
  _onboardedCache = true;
  await AsyncStorage.setItem(ONBOARDED_KEY, '1');
}

// ── App lock flag ────────────────────────────────────────────────────────────
const APP_LOCK_KEY = '@scan_kit_app_lock';

export async function getAppLockEnabled(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(APP_LOCK_KEY)) === '1';
  } catch {
    return false;
  }
}

// Listeners so the lock gate reacts the moment the setting changes, without
// waiting for a restart.
const _appLockListeners = new Set<(enabled: boolean) => void>();

/** Subscribe to App Lock on/off changes. Returns an unsubscribe function. */
export function subscribeAppLock(listener: (enabled: boolean) => void): () => void {
  _appLockListeners.add(listener);
  return () => { _appLockListeners.delete(listener); };
}

export async function setAppLockEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    await AsyncStorage.setItem(APP_LOCK_KEY, '1');
  } else {
    await AsyncStorage.removeItem(APP_LOCK_KEY);
  }
  for (const l of Array.from(_appLockListeners)) {
    try { l(enabled); } catch {}
  }
}
