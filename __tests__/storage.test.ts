// __tests__/storage.test.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDocuments, saveDocument, updateDocument, deleteDocument } from '../lib/storage';
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
