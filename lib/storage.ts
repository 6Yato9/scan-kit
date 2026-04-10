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

export async function getDocuments(): Promise<Document[]> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function saveDocument(doc: Document): Promise<void> {
  const docs = await getDocuments();
  await AsyncStorage.setItem(KEY, JSON.stringify([doc, ...docs]));
}

export async function updateDocument(doc: Document): Promise<void> {
  const docs = await getDocuments();
  await AsyncStorage.setItem(
    KEY,
    JSON.stringify(docs.map(d => (d.id === doc.id ? doc : d)))
  );
}

export async function deleteDocument(id: string): Promise<void> {
  const docs = await getDocuments();
  await AsyncStorage.setItem(KEY, JSON.stringify(docs.filter(d => d.id !== id)));
}

export async function deleteDocuments(ids: string[]): Promise<void> {
  const set = new Set(ids);
  const docs = await getDocuments();
  await AsyncStorage.setItem(KEY, JSON.stringify(docs.filter(d => !set.has(d.id))));
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

export async function deleteFolder(name: string): Promise<void> {
  // Remove from folders list
  const folders = await getFolders();
  await AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify(folders.filter(f => f !== name)));
  // Clear folder field on all docs that had this folder
  const docs = await getDocuments();
  const updated = docs.map(d => {
    if (d.folder !== name) return d;
    const { folder: _removed, ...rest } = d;
    return rest as Document;
  });
  await AsyncStorage.setItem(KEY, JSON.stringify(updated));
}

export async function getScanSettings(): Promise<ScanSettings> {
  const raw = await AsyncStorage.getItem(SCAN_SETTINGS_KEY);
  if (!raw) return { quality: 'high', autoCrop: true, defaultFilter: 'original' };
  try {
    return JSON.parse(raw);
  } catch {
    return { quality: 'high', autoCrop: true, defaultFilter: 'original' };
  }
}

export async function saveScanSettings(s: ScanSettings): Promise<void> {
  await AsyncStorage.setItem(SCAN_SETTINGS_KEY, JSON.stringify(s));
}

export async function getDocSettings(): Promise<DocSettings> {
  const raw = await AsyncStorage.getItem(DOC_SETTINGS_KEY);
  if (!raw) return { namePrefix: 'Scan', pdfPageSize: 'A4', pdfQuality: 'standard' };
  try {
    return JSON.parse(raw);
  } catch {
    return { namePrefix: 'Scan', pdfPageSize: 'A4', pdfQuality: 'standard' };
  }
}

export async function saveDocSettings(s: DocSettings): Promise<void> {
  await AsyncStorage.setItem(DOC_SETTINGS_KEY, JSON.stringify(s));
}

const THEME_KEY = '@scan_kit_theme';
type ThemePreference = 'light' | 'dark' | 'system';

export async function getThemePreference(): Promise<ThemePreference> {
  const raw = await AsyncStorage.getItem(THEME_KEY);
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  return 'system';
}

export async function saveThemePreference(p: ThemePreference): Promise<void> {
  await AsyncStorage.setItem(THEME_KEY, p);
}
