// lib/storage.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Document, PageFilter } from '../types/document';

const KEY = '@scan_kit_documents'; // legacy single-blob key — kept as a read-only backup, never written after migration
const DOC_INDEX_KEY = '@scan_kit_doc_index'; // JSON array of doc ids, newest-first
const DOC_PREFIX = '@scan_kit_doc:'; // per-document key prefix: `${DOC_PREFIX}${id}`
const SCHEMA_VERSION_KEY = '@scan_kit_schema_version';
const CURRENT_SCHEMA_VERSION = '2';
const SORT_KEY = '@scan_kit_sort';
const FOLDERS_KEY = '@scan_kit_folders';
const SCAN_SETTINGS_KEY = '@scan_kit_scan_settings';
const DOC_SETTINGS_KEY = '@scan_kit_doc_settings';
const PENDING_KEY = '@scan_kit_pending';

export type SortKey = 'dateAdded' | 'dateModified' | 'nameAZ';

export type ScanSettings = {
  quality: 'low' | 'medium' | 'high';
  autoCrop: boolean;
  defaultFilter: PageFilter;
};

export type DocSettings = {
  namePrefix: string;
  pdfPageSize: 'A4' | 'Letter';
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
// Read the id index. If the index JSON is missing, treat as empty. If it's
// corrupt, recover by scanning for `@scan_kit_doc:` keys rather than nuking data
// (only fall back to [] when there are genuinely no doc keys).
async function readIndex(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(DOC_INDEX_KEY);
  if (raw == null) return [];
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
        const version = await AsyncStorage.getItem(SCHEMA_VERSION_KEY);
        if (version === CURRENT_SCHEMA_VERSION) return;

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
        } else {
          // Fresh install (or unrecoverable legacy blob): initialise empty index.
          await writeIndex([]);
        }

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
      docs.push(JSON.parse(value) as Document);
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

export function getDocuments(): Promise<Document[]> {
  return withDocsLock(async () => {
    await ensureMigrated();
    return getDocumentsUnlocked();
  });
}

export function saveDocument(doc: Document): Promise<void> {
  return withDocsLock(async () => {
    await ensureMigrated();
    await AsyncStorage.setItem(docKey(doc.id), JSON.stringify(doc));
    const index = await readIndex();
    // Prepend, dedupe (keep at front if it was already present).
    await writeIndex([doc.id, ...index.filter(id => id !== doc.id)]);
  });
}

export function updateDocument(doc: Document): Promise<void> {
  return withDocsLock(async () => {
    await ensureMigrated();
    await AsyncStorage.setItem(docKey(doc.id), JSON.stringify(doc));
    const index = await readIndex();
    // Ensure the id is present (append if somehow missing) without reordering.
    if (!index.includes(doc.id)) await writeIndex([...index, doc.id]);
  });
}

export function deleteDocument(id: string): Promise<void> {
  return withDocsLock(async () => {
    await ensureMigrated();
    await AsyncStorage.removeItem(docKey(id));
    const index = await readIndex();
    await writeIndex(index.filter(x => x !== id));
  });
}

export function deleteDocuments(ids: string[]): Promise<void> {
  return withDocsLock(async () => {
    await ensureMigrated();
    const set = new Set(ids);
    await AsyncStorage.multiRemove(ids.map(docKey));
    const index = await readIndex();
    await writeIndex(index.filter(x => !set.has(x)));
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

const DEFAULT_SCAN_SETTINGS: ScanSettings = { quality: 'high', autoCrop: true, defaultFilter: 'original' };

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

const DEFAULT_DOC_SETTINGS: DocSettings = { namePrefix: 'Scan', pdfPageSize: 'A4', pdfQuality: 'standard' };

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

// ── Pending review state ────────────────────────────────────────────────────
// Persisted so an in-progress review survives the JS side getting killed
// while backgrounded (common on iOS). Not subject to the docs lock — it has
// a single writer (the scan context's AppState listener).
export type PendingState = {
  pages: string[];          // file URIs (may be in cache)
  pdfUri: string | null;
  quality: number;
  defaultFilter: PageFilter | 'original';
  reviewVisible: boolean;
};

export async function getPendingState(): Promise<PendingState | null> {
  const raw = await AsyncStorage.getItem(PENDING_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingState;
  } catch {
    console.warn('storage: corrupt pending state, resetting to null');
    await AsyncStorage.removeItem(PENDING_KEY);
    return null;
  }
}

export async function setPendingState(s: PendingState): Promise<void> {
  await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(s));
}

export async function clearPendingState(): Promise<void> {
  await AsyncStorage.removeItem(PENDING_KEY);
}

// ── First-run onboarding flag ────────────────────────────────────────────────
const ONBOARDED_KEY = '@scan_kit_onboarded';

export async function getOnboarded(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(ONBOARDED_KEY)) === '1';
  } catch {
    return false;
  }
}

export async function setOnboarded(): Promise<void> {
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

export async function setAppLockEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    await AsyncStorage.setItem(APP_LOCK_KEY, '1');
  } else {
    await AsyncStorage.removeItem(APP_LOCK_KEY);
  }
}

// ── AI key ──────────────────────────────────────────────────────────────────
const AI_KEY_STORAGE = '@scan_kit_ai_key';

export async function getAiKey(): Promise<string | null> {
  const val = await AsyncStorage.getItem(AI_KEY_STORAGE);
  return val && val.length > 0 ? val : null;
}

export async function saveAiKey(key: string): Promise<void> {
  return AsyncStorage.setItem(AI_KEY_STORAGE, key);
}

export async function clearAiKey(): Promise<void> {
  return AsyncStorage.removeItem(AI_KEY_STORAGE);
}
