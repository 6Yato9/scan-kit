// __tests__/storage.test.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getDocuments,
  saveDocument,
  updateDocument,
  deleteDocument,
  getSortPreference,
  saveSortPreference,
  getFolders,
  saveFolder,
  deleteFolder,
  getScanSettings,
  saveScanSettings,
  getDocSettings,
  saveDocSettings,
} from '../lib/storage';
import { Document } from '../types/document';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const doc: Document = {
  id: 'test-id',
  name: 'Scan Apr 10, 2026',
  pages: ['file:///page1.jpg'],
  createdAt: 1000,
  updatedAt: 1000,
};

beforeEach(() => AsyncStorage.clear());

test('getDocuments returns empty array when nothing stored', async () => {
  expect(await getDocuments()).toEqual([]);
});

test('saveDocument prepends document to list', async () => {
  await saveDocument(doc);
  const docs = await getDocuments();
  expect(docs).toHaveLength(1);
  expect(docs[0]).toEqual(doc);
});

test('saveDocument prepends newest first', async () => {
  const doc2: Document = { ...doc, id: 'test-id-2', name: 'Scan Apr 11, 2026' };
  await saveDocument(doc);
  await saveDocument(doc2);
  const docs = await getDocuments();
  expect(docs[0].id).toBe('test-id-2');
});

test('updateDocument replaces matching document by id', async () => {
  await saveDocument(doc);
  await updateDocument({ ...doc, name: 'Renamed' });
  const docs = await getDocuments();
  expect(docs[0].name).toBe('Renamed');
});

test('deleteDocument removes document by id', async () => {
  await saveDocument(doc);
  await deleteDocument(doc.id);
  expect(await getDocuments()).toHaveLength(0);
});

describe('getSortPreference', () => {
  it('returns dateAdded by default when nothing stored', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockResolvedValueOnce(null);
    const key = await getSortPreference();
    expect(key).toBe('dateAdded');
  });

  it('returns stored value when valid', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockResolvedValueOnce('nameAZ');
    const key = await getSortPreference();
    expect(key).toBe('nameAZ');
  });

  it('returns dateAdded for unknown stored value', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockResolvedValueOnce('invalid');
    const key = await getSortPreference();
    expect(key).toBe('dateAdded');
  });
});

describe('saveSortPreference', () => {
  it('saves the sort key to AsyncStorage', async () => {
    const spy = jest.spyOn(AsyncStorage, 'setItem').mockResolvedValueOnce(undefined as any);
    await saveSortPreference('dateModified');
    expect(spy).toHaveBeenCalledWith('@scan_kit_sort', 'dateModified');
  });
});

// --- Folders ---

describe('getFolders', () => {
  it('returns empty array when nothing stored', async () => {
    const folders = await getFolders();
    expect(folders).toEqual([]);
  });

  it('returns sorted folder names', async () => {
    await AsyncStorage.setItem('@scan_kit_folders', JSON.stringify(['Zebra', 'Alpha']));
    const folders = await getFolders();
    expect(folders).toEqual(['Alpha', 'Zebra']);
  });
});

describe('saveFolder', () => {
  it('adds a new folder name', async () => {
    await saveFolder('Work');
    const folders = await getFolders();
    expect(folders).toContain('Work');
  });

  it('does not add duplicate names', async () => {
    await saveFolder('Work');
    await saveFolder('Work');
    const folders = await getFolders();
    expect(folders.filter(f => f === 'Work')).toHaveLength(1);
  });
});

describe('deleteFolder', () => {
  it('removes the folder from the list', async () => {
    await saveFolder('Old');
    await deleteFolder('Old');
    expect(await getFolders()).not.toContain('Old');
  });

  it('clears folder field on all docs that had it', async () => {
    const docWithFolder: Document = { ...doc, id: 'f1', folder: 'Old' };
    await saveDocument(docWithFolder);
    await saveFolder('Old');
    await deleteFolder('Old');
    const docs = await getDocuments();
    expect(docs.find(d => d.id === 'f1')?.folder).toBeUndefined();
  });
});

// --- ScanSettings ---

describe('getScanSettings', () => {
  it('returns defaults when nothing stored', async () => {
    const s = await getScanSettings();
    expect(s).toEqual({ quality: 'high', autoCrop: true, defaultFilter: 'original' });
  });

  it('returns stored value', async () => {
    const custom = { quality: 'low' as const, autoCrop: false, defaultFilter: 'grayscale' as const };
    await saveScanSettings(custom);
    expect(await getScanSettings()).toEqual(custom);
  });
});

// --- DocSettings ---

describe('getDocSettings', () => {
  it('returns defaults when nothing stored', async () => {
    const s = await getDocSettings();
    expect(s).toEqual({ namePrefix: 'Scan', pdfPageSize: 'A4', pdfQuality: 'standard' });
  });

  it('returns stored value', async () => {
    const custom = { namePrefix: 'Doc', pdfPageSize: 'Letter' as const, pdfQuality: 'high' as const };
    await saveDocSettings(custom);
    expect(await getDocSettings()).toEqual(custom);
  });
});
