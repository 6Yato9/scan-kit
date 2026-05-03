// lib/storage.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Document, PageFilter } from '../types/document';

const KEY = '@scan_kit_documents';
const SORT_KEY = '@scan_kit_sort';
const FOLDERS_KEY = '@scan_kit_folders';
const SCAN_SETTINGS_KEY = '@scan_kit_scan_settings';
const DOC_SETTINGS_KEY = '@scan_kit_doc_settings';

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

async function readDocsRaw(): Promise<Document[]> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    console.warn('storage: corrupt documents JSON, resetting to []');
    await AsyncStorage.setItem(KEY, '[]');
    return [];
  }
}

export function getDocuments(): Promise<Document[]> {
  return withDocsLock(readDocsRaw);
}

export function saveDocument(doc: Document): Promise<void> {
  return withDocsLock(async () => {
    const docs = await readDocsRaw();
    await AsyncStorage.setItem(KEY, JSON.stringify([doc, ...docs]));
  });
}

export function updateDocument(doc: Document): Promise<void> {
  return withDocsLock(async () => {
    const docs = await readDocsRaw();
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify(docs.map(d => (d.id === doc.id ? doc : d)))
    );
  });
}

export function deleteDocument(id: string): Promise<void> {
  return withDocsLock(async () => {
    const docs = await readDocsRaw();
    await AsyncStorage.setItem(KEY, JSON.stringify(docs.filter(d => d.id !== id)));
  });
}

export function deleteDocuments(ids: string[]): Promise<void> {
  return withDocsLock(async () => {
    const set = new Set(ids);
    const docs = await readDocsRaw();
    await AsyncStorage.setItem(KEY, JSON.stringify(docs.filter(d => !set.has(d.id))));
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

export async function saveFolder(name: string): Promise<void> {
  const folders = await getFolders();
  if (folders.includes(name)) return;
  await AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify([...folders, name]));
}

export function deleteFolder(name: string): Promise<void> {
  return withDocsLock(async () => {
    // Remove from folders list
    const folders = await getFolders();
    await AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify(folders.filter(f => f !== name)));
    // Clear folder field on all docs that had this folder
    const docs = await readDocsRaw();
    const updated = docs.map(d => {
      if (d.folder !== name) return d;
      const { folder: _removed, ...rest } = d;
      return rest as Document;
    });
    await AsyncStorage.setItem(KEY, JSON.stringify(updated));
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

export function getThemePreferenceSync(): ThemePreference {
  return _themePrefCache;
}

export async function getThemePreference(): Promise<ThemePreference> {
  const raw = await AsyncStorage.getItem(THEME_KEY);
  const pref = (raw === 'light' || raw === 'dark' || raw === 'system') ? raw : 'system';
  _themePrefCache = pref;
  return pref;
}

export async function saveThemePreference(p: ThemePreference): Promise<void> {
  _themePrefCache = p;
  await AsyncStorage.setItem(THEME_KEY, p);
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
