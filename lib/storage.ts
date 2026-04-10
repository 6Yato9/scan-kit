// lib/storage.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Document } from '../types/document';

const KEY = '@scan_kit_documents';
const SORT_KEY = '@scan_kit_sort';

export type SortKey = 'dateAdded' | 'dateModified' | 'nameAZ';

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

export async function getSortPreference(): Promise<SortKey> {
  const raw = await AsyncStorage.getItem(SORT_KEY);
  if (raw === 'dateModified' || raw === 'nameAZ') return raw;
  return 'dateAdded';
}

export async function saveSortPreference(key: SortKey): Promise<void> {
  await AsyncStorage.setItem(SORT_KEY, key);
}
