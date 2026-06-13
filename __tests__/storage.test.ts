// __tests__/storage.test.ts
import { Document } from '../types/document';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// storage.ts keeps module-level state (the docs lock + the memoized migration
// promise `_migrated`). Re-require the module fresh for each test so that state
// — especially the one-time migration guard — is reset. jest.resetModules()
// also produces a fresh AsyncStorage mock instance, so we MUST re-acquire the
// AsyncStorage reference from the same registry the storage module sees;
// otherwise the test would read/write a different mock store than storage.ts.
type Storage = typeof import('../lib/storage');
type AS = typeof import('@react-native-async-storage/async-storage').default;
let storage: Storage;
let AsyncStorage: AS;

const doc: Document = {
  id: 'test-id',
  name: 'Scan Apr 10, 2026',
  pages: ['file:///page1.jpg'],
  createdAt: 1000,
  updatedAt: 1000,
};

beforeEach(() => {
  // Fresh module registry → fresh storage module state AND a fresh AsyncStorage
  // mock. Acquire both from the same post-reset registry so they share a store.
  jest.resetModules();
  AsyncStorage = require('@react-native-async-storage/async-storage');
  storage = require('../lib/storage');
});

test('getDocuments returns empty array when nothing stored', async () => {
  expect(await storage.getDocuments()).toEqual([]);
});

test('saveDocument prepends document to list', async () => {
  await storage.saveDocument(doc);
  const docs = await storage.getDocuments();
  expect(docs).toHaveLength(1);
  expect(docs[0]).toEqual(doc);
});

test('saveDocument prepends newest first', async () => {
  const doc2: Document = { ...doc, id: 'test-id-2', name: 'Scan Apr 11, 2026' };
  await storage.saveDocument(doc);
  await storage.saveDocument(doc2);
  const docs = await storage.getDocuments();
  expect(docs[0].id).toBe('test-id-2');
});

test('saveDocument with an existing id moves it to the front (dedupe)', async () => {
  const doc2: Document = { ...doc, id: 'test-id-2' };
  await storage.saveDocument(doc);
  await storage.saveDocument(doc2);
  // Re-save the original — it should move to the front, not duplicate.
  await storage.saveDocument(doc);
  const docs = await storage.getDocuments();
  expect(docs.map(d => d.id)).toEqual(['test-id', 'test-id-2']);
});

test('updateDocument replaces matching document by id', async () => {
  await storage.saveDocument(doc);
  await storage.updateDocument({ ...doc, name: 'Renamed' });
  const docs = await storage.getDocuments();
  expect(docs[0].name).toBe('Renamed');
  expect(docs).toHaveLength(1);
});

test('deleteDocument removes document by id', async () => {
  await storage.saveDocument(doc);
  await storage.deleteDocument(doc.id);
  expect(await storage.getDocuments()).toHaveLength(0);
});

test('deleteDocuments removes multiple ids', async () => {
  const docB: Document = { ...doc, id: 'b' };
  const docC: Document = { ...doc, id: 'c' };
  await storage.saveDocument(doc);
  await storage.saveDocument(docB);
  await storage.saveDocument(docC);
  await storage.deleteDocuments(['test-id', 'c']);
  const docs = await storage.getDocuments();
  expect(docs.map(d => d.id)).toEqual(['b']);
});

// --- Migration (legacy single-blob → per-doc keys + index) ---

describe('migration from legacy blob', () => {
  it('migrates legacy docs, sets schema version, and preserves the legacy backup', async () => {
    const legacyDocs: Document[] = [
      { ...doc, id: 'leg-1', name: 'Legacy 1' },
      { ...doc, id: 'leg-2', name: 'Legacy 2' },
    ];
    // Pre-seed the legacy key directly, as if written by the old app version.
    await AsyncStorage.setItem('@scan_kit_documents', JSON.stringify(legacyDocs));

    const docs = await storage.getDocuments();
    expect(docs.map(d => d.id)).toEqual(['leg-1', 'leg-2']);
    expect(docs.find(d => d.id === 'leg-1')?.name).toBe('Legacy 1');

    // Schema version bumped to "2".
    expect(await AsyncStorage.getItem('@scan_kit_schema_version')).toBe('2');

    // Legacy blob preserved untouched as a backup.
    const legacyRaw = await AsyncStorage.getItem('@scan_kit_documents');
    expect(legacyRaw).not.toBeNull();
    expect(JSON.parse(legacyRaw as string)).toHaveLength(2);

    // Per-doc keys now exist.
    expect(await AsyncStorage.getItem('@scan_kit_doc:leg-1')).not.toBeNull();
    expect(await AsyncStorage.getItem('@scan_kit_doc:leg-2')).not.toBeNull();
  });

  it('initialises an empty index on a fresh install (no legacy blob)', async () => {
    expect(await storage.getDocuments()).toEqual([]);
    expect(await AsyncStorage.getItem('@scan_kit_schema_version')).toBe('2');
    expect(await AsyncStorage.getItem('@scan_kit_doc_index')).toBe('[]');
  });

  it('does not re-migrate once schema version is "2"', async () => {
    // Schema already current, but a stale legacy blob is present. It must be ignored.
    await AsyncStorage.setItem('@scan_kit_schema_version', '2');
    await AsyncStorage.setItem('@scan_kit_doc_index', JSON.stringify([]));
    await AsyncStorage.setItem(
      '@scan_kit_documents',
      JSON.stringify([{ ...doc, id: 'stale' }])
    );
    expect(await storage.getDocuments()).toEqual([]);
  });
});

// --- Per-key isolation ---

describe('per-key isolation', () => {
  it('updating one doc does not rewrite another', async () => {
    const docA: Document = { ...doc, id: 'A', name: 'A original' };
    const docB: Document = { ...doc, id: 'B', name: 'B original' };
    await storage.saveDocument(docA);
    await storage.saveDocument(docB);

    // Capture B's raw stored JSON before touching A.
    const bBefore = await AsyncStorage.getItem('@scan_kit_doc:B');

    await storage.updateDocument({ ...docA, name: 'A changed' });

    // B's underlying record is byte-for-byte unchanged.
    const bAfter = await AsyncStorage.getItem('@scan_kit_doc:B');
    expect(bAfter).toBe(bBefore);

    const docs = await storage.getDocuments();
    expect(docs.find(d => d.id === 'A')?.name).toBe('A changed');
    expect(docs.find(d => d.id === 'B')?.name).toBe('B original');
  });
});

// --- Index self-heal ---

describe('index self-heal', () => {
  it('skips a dangling index entry and rewrites the index', async () => {
    const docA: Document = { ...doc, id: 'A' };
    const docB: Document = { ...doc, id: 'B' };
    await storage.saveDocument(docA);
    await storage.saveDocument(docB);

    // Manually remove B's data key, leaving B in the index → dangling entry.
    await AsyncStorage.removeItem('@scan_kit_doc:B');

    const docs = await storage.getDocuments();
    expect(docs.map(d => d.id)).toEqual(['A']);

    // Index self-healed: B no longer present.
    const index = JSON.parse((await AsyncStorage.getItem('@scan_kit_doc_index')) as string);
    expect(index).toEqual(['A']);
  });

  it('recovers a corrupt index by scanning doc keys', async () => {
    const docA: Document = { ...doc, id: 'A' };
    await storage.saveDocument(docA);
    // Corrupt the index JSON while the doc key survives.
    await AsyncStorage.setItem('@scan_kit_doc_index', '{not valid json');

    const docs = await storage.getDocuments();
    expect(docs.map(d => d.id)).toEqual(['A']);
  });
});

// --- Sort preference ---

describe('getSortPreference', () => {
  it('returns dateAdded by default when nothing stored', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockResolvedValueOnce(null);
    const key = await storage.getSortPreference();
    expect(key).toBe('dateAdded');
  });

  it('returns stored value when valid', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockResolvedValueOnce('nameAZ');
    const key = await storage.getSortPreference();
    expect(key).toBe('nameAZ');
  });

  it('returns dateAdded for unknown stored value', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockResolvedValueOnce('invalid');
    const key = await storage.getSortPreference();
    expect(key).toBe('dateAdded');
  });
});

describe('saveSortPreference', () => {
  it('saves the sort key to AsyncStorage', async () => {
    const spy = jest.spyOn(AsyncStorage, 'setItem').mockResolvedValueOnce(undefined as any);
    await storage.saveSortPreference('dateModified');
    expect(spy).toHaveBeenCalledWith('@scan_kit_sort', 'dateModified');
  });
});

// --- Folders ---

describe('getFolders', () => {
  it('returns empty array when nothing stored', async () => {
    const folders = await storage.getFolders();
    expect(folders).toEqual([]);
  });

  it('returns sorted folder names', async () => {
    await AsyncStorage.setItem('@scan_kit_folders', JSON.stringify(['Zebra', 'Alpha']));
    const folders = await storage.getFolders();
    expect(folders).toEqual(['Alpha', 'Zebra']);
  });
});

describe('saveFolder', () => {
  it('adds a new folder name', async () => {
    await storage.saveFolder('Work');
    const folders = await storage.getFolders();
    expect(folders).toContain('Work');
  });

  it('does not add duplicate names', async () => {
    await storage.saveFolder('Work');
    await storage.saveFolder('Work');
    const folders = await storage.getFolders();
    expect(folders.filter(f => f === 'Work')).toHaveLength(1);
  });
});

describe('deleteFolder', () => {
  it('removes the folder from the list', async () => {
    await storage.saveFolder('Old');
    await storage.deleteFolder('Old');
    expect(await storage.getFolders()).not.toContain('Old');
  });

  it('clears folder field on all docs that had it', async () => {
    const docWithFolder: Document = { ...doc, id: 'f1', folder: 'Old' };
    await storage.saveDocument(docWithFolder);
    await storage.saveFolder('Old');
    await storage.deleteFolder('Old');
    const docs = await storage.getDocuments();
    expect(docs.find(d => d.id === 'f1')?.folder).toBeUndefined();
  });

  it('leaves docs in other folders untouched', async () => {
    await storage.saveDocument({ ...doc, id: 'keep', folder: 'Keep' });
    await storage.saveDocument({ ...doc, id: 'drop', folder: 'Old' });
    await storage.deleteFolder('Old');
    const docs = await storage.getDocuments();
    expect(docs.find(d => d.id === 'keep')?.folder).toBe('Keep');
    expect(docs.find(d => d.id === 'drop')?.folder).toBeUndefined();
  });
});

// --- ScanSettings ---

describe('getScanSettings', () => {
  it('returns defaults when nothing stored', async () => {
    const s = await storage.getScanSettings();
    expect(s).toEqual({ quality: 'high', autoCrop: true, defaultFilter: 'original' });
  });

  it('returns stored value', async () => {
    const custom = { quality: 'low' as const, autoCrop: false, defaultFilter: 'grayscale' as const };
    await storage.saveScanSettings(custom);
    expect(await storage.getScanSettings()).toEqual(custom);
  });
});

// --- App lock flag ---

describe('app lock flag', () => {
  it('getAppLockEnabled defaults to false when nothing stored', async () => {
    expect(await storage.getAppLockEnabled()).toBe(false);
  });

  it('returns true after setAppLockEnabled(true)', async () => {
    await storage.setAppLockEnabled(true);
    expect(await storage.getAppLockEnabled()).toBe(true);
  });

  it('returns false after setAppLockEnabled(false)', async () => {
    await storage.setAppLockEnabled(true);
    await storage.setAppLockEnabled(false);
    expect(await storage.getAppLockEnabled()).toBe(false);
  });

  it('removes the key when disabled', async () => {
    await storage.setAppLockEnabled(true);
    await storage.setAppLockEnabled(false);
    expect(await AsyncStorage.getItem('@scan_kit_app_lock')).toBeNull();
  });

  it('getAppLockEnabled returns false (not throws) when getItem rejects', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('boom'));
    expect(await storage.getAppLockEnabled()).toBe(false);
  });
});

// --- DocSettings ---

describe('getDocSettings', () => {
  it('returns defaults when nothing stored', async () => {
    const s = await storage.getDocSettings();
    expect(s).toEqual({ namePrefix: 'Scan', pdfPageSize: 'A4', pdfQuality: 'standard' });
  });

  it('returns stored value', async () => {
    const custom = { namePrefix: 'Doc', pdfPageSize: 'Letter' as const, pdfQuality: 'high' as const };
    await storage.saveDocSettings(custom);
    expect(await storage.getDocSettings()).toEqual(custom);
  });
});
