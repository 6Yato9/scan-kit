// __tests__/storage.test.ts
import { Document } from '../types/document';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// pendingBakeMigrations() checks "already baked" via a page-N.orig.jpg File's
// `.exists`. Lightweight File stand-in keyed by uri, mirroring the pattern in
// __tests__/bake.test.ts / __tests__/files.test.ts — `mockOrigExists` lives
// outside the factory so it survives jest.resetModules() in beforeEach below.
const mockOrigExists: Record<string, boolean> = {};
// Page/shadow bytes, for the "page is byte-for-byte its .orig" check. A uri with
// content here exists even if mockOrigExists doesn't say so.
const mockBytes: Record<string, string> = {};
jest.mock('expo-file-system', () => {
  class MockFile {
    uri: string;
    constructor(uri: string) { this.uri = uri; }
    get exists() { return mockOrigExists[this.uri] ?? (this.uri in mockBytes); }
    get size() { return (mockBytes[this.uri] ?? '').length; }
    get md5() { return this.uri in mockBytes ? `md5:${mockBytes[this.uri]}` : null; }
  }
  return { File: MockFile, Paths: { document: { uri: 'file:///CURRENT/Documents/' } } };
});

// Real lib/files.ts pulls in expo-image-manipulator, which isn't relevant to
// storage.ts's tests — stub just what storage.ts uses, with a deterministic,
// self-consistent uri format.
const mockDeletedDirs: string[] = [];
jest.mock('../lib/files', () => ({
  originalUri: (docId: string, pageIndex: number) =>
    `file:///documents/scan-kit/${docId}/page-${pageIndex}.orig.jpg`,
  deleteDocumentFiles: (docId: string) => { mockDeletedDirs.push(docId); },
}));

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

function origUri(docId: string, pageIndex: number): string {
  return `file:///documents/scan-kit/${docId}/page-${pageIndex}.orig.jpg`;
}

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
  for (const k of Object.keys(mockOrigExists)) delete mockOrigExists[k];
  for (const k of Object.keys(mockBytes)) delete mockBytes[k];
  mockDeletedDirs.length = 0;
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

describe('patchDocument', () => {
  it('merges a partial update onto the current stored record', async () => {
    await storage.saveDocument(doc);
    await storage.patchDocument(doc.id, { ocrText: 'recognized text' });
    const docs = await storage.getDocuments();
    expect(docs[0]).toEqual({ ...doc, ocrText: 'recognized text' });
  });

  it('is a no-op for a missing id (does not resurrect a deleted document)', async () => {
    await storage.patchDocument('does-not-exist', { ocrText: 'recognized text' });
    expect(await storage.getDocuments()).toEqual([]);
  });

  it('merges onto the CURRENT record, so a concurrent rename is not clobbered', async () => {
    await storage.saveDocument(doc);
    // Simulate a rename that lands before the patch (e.g. during a slow OCR pass).
    await storage.updateDocument({ ...doc, name: 'Renamed' });
    await storage.patchDocument(doc.id, { ocrText: 'recognized text' });
    const docs = await storage.getDocuments();
    expect(docs[0].name).toBe('Renamed');
    expect(docs[0].ocrText).toBe('recognized text');
  });

  it('with several documents stored, patches only the matching id', async () => {
    const docA: Document = { ...doc, id: 'A', name: 'A' };
    const docB: Document = { ...doc, id: 'B', name: 'B' };
    const docC: Document = { ...doc, id: 'C', name: 'C' };
    await storage.saveDocument(docA);
    await storage.saveDocument(docB);
    await storage.saveDocument(docC);

    await storage.patchDocument('B', { ocrText: 'recognized text' });

    const docs = await storage.getDocuments();
    expect(docs.find(d => d.id === 'A')?.ocrText).toBeUndefined();
    expect(docs.find(d => d.id === 'B')?.ocrText).toBe('recognized text');
    expect(docs.find(d => d.id === 'C')?.ocrText).toBeUndefined();
  });
});

describe('setPageBaked', () => {
  const doc3: Document = {
    ...doc,
    id: 'baked-doc',
    pages: ['file:///p0.jpg', 'file:///p1.jpg', 'file:///p2.jpg'],
  };

  it('sets one page filter without disturbing sibling filters', async () => {
    await storage.saveDocument({ ...doc3, filters: ['grayscale', 'grayscale', 'grayscale'] });
    await storage.setPageBaked('baked-doc', 1, 'bw', undefined);
    const d = (await storage.getDocuments()).find(x => x.id === 'baked-doc')!;
    expect(d.filters).toEqual(['grayscale', 'bw', 'grayscale']);
  });

  it('collapses filters to undefined once every page is back to original', async () => {
    await storage.saveDocument({ ...doc3, filters: ['grayscale', 'original', 'original'] });
    await storage.setPageBaked('baked-doc', 0, 'original', undefined);
    const d = (await storage.getDocuments()).find(x => x.id === 'baked-doc')!;
    expect(d.filters).toBeUndefined();
  });

  it('only touches adjustments when an adjustment is passed', async () => {
    const existingAdj = [
      { brightness: 5, contrast: 0, saturation: 0 },
      { brightness: 0, contrast: 0, saturation: 0 },
      { brightness: 0, contrast: 0, saturation: 0 },
    ];
    await storage.saveDocument({ ...doc3, adjustments: existingAdj });
    await storage.setPageBaked('baked-doc', 2, 'grayscale', undefined);
    const d = (await storage.getDocuments()).find(x => x.id === 'baked-doc')!;
    // adjustments untouched since no adjustment was passed
    expect(d.adjustments).toEqual(existingAdj);
    expect(d.filters?.[2]).toBe('grayscale');
  });

  it('sets the adjustment at pageIndex and fills siblings with defaults when passed', async () => {
    await storage.saveDocument(doc3);
    await storage.setPageBaked('baked-doc', 1, 'grayscale', { brightness: 10, contrast: 0, saturation: 0 });
    const d = (await storage.getDocuments()).find(x => x.id === 'baked-doc')!;
    expect(d.adjustments?.[1]).toEqual({ brightness: 10, contrast: 0, saturation: 0 });
    expect(d.adjustments?.[0]).toEqual({ brightness: 0, contrast: 0, saturation: 0 });
  });

  it('bumps updatedAt', async () => {
    await storage.saveDocument({ ...doc3, updatedAt: 1000 });
    await storage.setPageBaked('baked-doc', 0, 'grayscale', undefined);
    const d = (await storage.getDocuments()).find(x => x.id === 'baked-doc')!;
    expect(d.updatedAt).toBeGreaterThan(1000);
  });

  it('is a no-op for a missing id (does not resurrect a deleted document)', async () => {
    await storage.setPageBaked('does-not-exist', 0, 'grayscale', undefined);
    expect(await storage.getDocuments()).toEqual([]);
  });

  it('is a no-op for a corrupt stored record', async () => {
    await AsyncStorage.setItem('@scan_kit_doc:corrupt', '{not valid json');
    await AsyncStorage.setItem('@scan_kit_doc_index', JSON.stringify(['corrupt']));
    await storage.setPageBaked('corrupt', 0, 'grayscale', undefined);
    // Still corrupt / unchanged — no throw, no crash.
    expect(await AsyncStorage.getItem('@scan_kit_doc:corrupt')).toBe('{not valid json');
  });

  it('merges onto the CURRENT record, so a concurrent rename is not clobbered', async () => {
    await storage.saveDocument(doc3);
    // Simulate a rename landing mid-bake.
    await storage.updateDocument({ ...doc3, name: 'Renamed' });
    await storage.setPageBaked('baked-doc', 0, 'grayscale', undefined);
    const d = (await storage.getDocuments()).find(x => x.id === 'baked-doc')!;
    expect(d.name).toBe('Renamed');
    expect(d.filters?.[0]).toBe('grayscale');
  });

  it('two sibling pages baking concurrently both land (no lost update)', async () => {
    await storage.saveDocument(doc3);
    await Promise.all([
      storage.setPageBaked('baked-doc', 0, 'grayscale', undefined),
      storage.setPageBaked('baked-doc', 2, 'bw', undefined),
    ]);
    const d = (await storage.getDocuments()).find(x => x.id === 'baked-doc')!;
    expect(d.filters?.[0]).toBe('grayscale');
    expect(d.filters?.[2]).toBe('bw');
  });
});

describe('pendingBakeMigrations', () => {
  it('reports a page with a recorded filter that has not been baked yet', async () => {
    await storage.saveDocument({
      ...doc, id: 'pbm-1', pages: ['file:///p0.jpg'], filters: ['grayscale'],
    });
    expect(await storage.pendingBakeMigrations()).toEqual([
      { docId: 'pbm-1', pageIndex: 0, filter: 'grayscale', adjustment: undefined },
    ]);
  });

  it('reports a page with only a non-default adjustment (filter stays original)', async () => {
    await storage.saveDocument({
      ...doc,
      id: 'pbm-adj',
      pages: ['file:///p0.jpg'],
      adjustments: [{ brightness: 15, contrast: 0, saturation: 0 }],
    });
    expect(await storage.pendingBakeMigrations()).toEqual([
      { docId: 'pbm-adj', pageIndex: 0, filter: 'original', adjustment: { brightness: 15, contrast: 0, saturation: 0 } },
    ]);
  });

  it('ignores an all-original document with no adjustments', async () => {
    await storage.saveDocument({ ...doc, id: 'pbm-2', pages: ['file:///p0.jpg'] });
    expect(await storage.pendingBakeMigrations()).toEqual([]);
  });

  it('ignores a page whose adjustment is present but all-zero', async () => {
    await storage.saveDocument({
      ...doc,
      id: 'pbm-zero-adj',
      pages: ['file:///p0.jpg'],
      adjustments: [{ brightness: 0, contrast: 0, saturation: 0 }],
    });
    expect(await storage.pendingBakeMigrations()).toEqual([]);
  });

  it('skips a page whose pixels differ from its .orig (already baked)', async () => {
    await storage.saveDocument({
      ...doc, id: 'pbm-3', pages: ['file:///p0.jpg'], filters: ['bw'],
    });
    mockBytes[origUri('pbm-3', 0)] = 'raw-photo';
    mockBytes['file:///p0.jpg'] = 'baked-bw';
    expect(await storage.pendingBakeMigrations()).toEqual([]);
  });

  it('reports a page whose bake made the .orig but never wrote the filtered pixels', async () => {
    // The critique's case: metadata says Enhanced, the shadow exists, but the
    // page is still the raw photo because the bake failed or was killed.
    await storage.saveDocument({
      ...doc, id: 'pbm-half', pages: ['file:///half.jpg?v=3'], filters: ['enhanced'],
    });
    mockBytes[origUri('pbm-half', 0)] = 'raw-photo';
    mockBytes['file:///half.jpg'] = 'raw-photo';
    expect(await storage.pendingBakeMigrations()).toEqual([
      { docId: 'pbm-half', pageIndex: 0, filter: 'enhanced', adjustment: undefined },
    ]);
  });

  it('skips trashed documents', async () => {
    await storage.saveDocument({
      ...doc, id: 'pbm-trash', pages: ['file:///p0.jpg'], filters: ['grayscale'], trashedAt: 5,
    });
    expect(await storage.pendingBakeMigrations()).toEqual([]);
  });

  it('survives a corrupt document and still reports the rest', async () => {
    await storage.saveDocument({
      ...doc, id: 'ok-doc', pages: ['file:///p0.jpg'], filters: ['grayscale'],
    });
    // Not corrupt JSON (getDocumentsUnlocked already guards against that) — a
    // structurally malformed record that throws while pendingBakeMigrations
    // walks its pages, simulating an old/foreign record shape.
    await storage.saveDocument({
      ...doc, id: 'bad-doc', pages: undefined as any, filters: ['grayscale'],
    });
    expect(await storage.pendingBakeMigrations()).toEqual([
      { docId: 'ok-doc', pageIndex: 0, filter: 'grayscale', adjustment: undefined },
    ]);
  });
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

    // Schema version bumped to "3".
    expect(await AsyncStorage.getItem('@scan_kit_schema_version')).toBe('3');

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
    expect(await AsyncStorage.getItem('@scan_kit_schema_version')).toBe('3');
    expect(await AsyncStorage.getItem('@scan_kit_doc_index')).toBe('[]');
  });

  it('does not re-migrate once schema version is "3"', async () => {
    // Schema already current, but a stale legacy blob is present. It must be ignored.
    await AsyncStorage.setItem('@scan_kit_schema_version', '3');
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
    expect(s).toEqual({ quality: 'medium', autoCrop: true, defaultFilter: 'enhanced' });
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
    expect(s).toEqual({ namePrefix: 'Scan', pdfPageSize: 'Auto', pdfQuality: 'standard' });
  });

  it('returns stored value', async () => {
    const custom = { namePrefix: 'Doc', pdfPageSize: 'Letter' as const, pdfQuality: 'high' as const };
    await storage.saveDocSettings(custom);
    expect(await storage.getDocSettings()).toEqual(custom);
  });
});

describe('schema migration is version-aware', () => {
  test('upgrading v2 → v3 does not erase an existing document index', async () => {
    // A v2 install looks like this: per-doc keys plus a populated index, and no
    // legacy blob. Treating that as "needs the v1→v2 migration" wiped the index
    // and made every document unreachable.
    await AsyncStorage.setItem('@scan_kit_schema_version', '2');
    await AsyncStorage.setItem('@scan_kit_doc_index', JSON.stringify(['a', 'b']));
    await AsyncStorage.setItem('@scan_kit_doc:a', JSON.stringify({ id: 'a', name: 'A', pages: [], createdAt: 1, updatedAt: 1 }));
    await AsyncStorage.setItem('@scan_kit_doc:b', JSON.stringify({ id: 'b', name: 'B', pages: [], createdAt: 2, updatedAt: 2 }));

    const docs = await storage.getDocuments();

    expect(docs.map(d => d.id).sort()).toEqual(['a', 'b']);
    expect(await AsyncStorage.getItem('@scan_kit_schema_version')).toBe('3');
  });

  test('a fresh install still gets an empty index', async () => {
    await storage.getDocuments();

    expect(await AsyncStorage.getItem('@scan_kit_doc_index')).toBe('[]');
    expect(await AsyncStorage.getItem('@scan_kit_schema_version')).toBe('3');
  });

  test('a pre-v2 install still migrates its legacy blob', async () => {
    await AsyncStorage.setItem('@scan_kit_documents', JSON.stringify([
      { id: 'old', name: 'Old', pages: [], createdAt: 1, updatedAt: 1 },
    ]));

    const docs = await storage.getDocuments();

    expect(docs.map(d => d.id)).toEqual(['old']);
    expect(await AsyncStorage.getItem('@scan_kit_schema_version')).toBe('3');
  });
});

describe('stored page paths survive a container change', () => {
  // iOS does not guarantee the app container path is stable: it changes on
  // reinstall, on restore from backup, on device migration, and can change on
  // update. Absolute file:// URIs written under the old container then point at a
  // directory that no longer exists — documents list fine but every page renders
  // blank, which is precisely the "new TestFlight build broke my old photos" bug.

  const OLD = 'file:///var/mobile/Containers/Data/Application/OLD-UUID/Documents/scan-kit';
  const NEW = 'file:///CURRENT/Documents/scan-kit';

  test('pages saved under a previous container are re-rooted on read', async () => {
    await AsyncStorage.setItem('@scan_kit_schema_version', '3');
    await AsyncStorage.setItem('@scan_kit_doc_index', JSON.stringify(['d1']));
    await AsyncStorage.setItem('@scan_kit_doc:d1', JSON.stringify({
      id: 'd1', name: 'Old Scan',
      pages: [`${OLD}/d1/page-0.jpg`, `${OLD}/d1/page-1.jpg`],
      createdAt: 1, updatedAt: 1,
    }));

    const doc = (await storage.getDocuments())[0];

    expect(doc.pages).toEqual([`${NEW}/d1/page-0.jpg`, `${NEW}/d1/page-1.jpg`]);
  });

  test('an imported PDF is re-rooted too', async () => {
    await AsyncStorage.setItem('@scan_kit_schema_version', '3');
    await AsyncStorage.setItem('@scan_kit_doc_index', JSON.stringify(['d2']));
    await AsyncStorage.setItem('@scan_kit_doc:d2', JSON.stringify({
      id: 'd2', name: 'Old PDF', pages: [],
      pdfUri: `${OLD}/d2/document.pdf`,
      createdAt: 1, updatedAt: 1,
    }));

    const doc = (await storage.getDocuments())[0];

    expect(doc.pdfUri).toBe(`${NEW}/d2/document.pdf`);
  });

  test('paths already under the current container are left alone', async () => {
    await AsyncStorage.setItem('@scan_kit_schema_version', '3');
    await AsyncStorage.setItem('@scan_kit_doc_index', JSON.stringify(['d3']));
    await AsyncStorage.setItem('@scan_kit_doc:d3', JSON.stringify({
      id: 'd3', name: 'Current', pages: [`${NEW}/d3/page-0.jpg`], createdAt: 1, updatedAt: 1,
    }));

    const doc = (await storage.getDocuments())[0];

    expect(doc.pages).toEqual([`${NEW}/d3/page-0.jpg`]);
  });

  test('a uri with no scan-kit segment is not rewritten', async () => {
    await AsyncStorage.setItem('@scan_kit_schema_version', '3');
    await AsyncStorage.setItem('@scan_kit_doc_index', JSON.stringify(['d4']));
    await AsyncStorage.setItem('@scan_kit_doc:d4', JSON.stringify({
      id: 'd4', name: 'External', pages: ['file:///somewhere/else/photo.jpg'], createdAt: 1, updatedAt: 1,
    }));

    const doc = (await storage.getDocuments())[0];

    expect(doc.pages).toEqual(['file:///somewhere/else/photo.jpg']);
  });
});

describe('ghost documents and lost indexes (core #6, #14)', () => {
  test('updateDocument refuses an id that was deleted and does not resurrect it', async () => {
    await storage.saveDocument(doc);
    await storage.deleteDocument(doc.id);
    const ok = await storage.updateDocument({ ...doc, name: 'Ghost' });
    expect(ok).toBe(false);
    expect(await storage.getDocuments()).toEqual([]);
    expect(await AsyncStorage.getItem(`@scan_kit_doc:${doc.id}`)).toBeNull();
  });

  test('updateDocument reports success for an existing document', async () => {
    await storage.saveDocument(doc);
    expect(await storage.updateDocument({ ...doc, name: 'Renamed' })).toBe(true);
  });

  test('patchDocument reports whether it applied', async () => {
    await storage.saveDocument(doc);
    expect(await storage.patchDocument(doc.id, { name: 'X' })).toBe(true);
    expect(await storage.patchDocument('missing', { name: 'X' })).toBe(false);
  });

  test('a missing index is recovered from the per-document keys', async () => {
    await storage.saveDocument({ ...doc, id: 'A' });
    await storage.saveDocument({ ...doc, id: 'B' });
    await AsyncStorage.removeItem('@scan_kit_doc_index');

    const docs = await storage.getDocuments();
    expect(docs.map(d => d.id).sort()).toEqual(['A', 'B']);
    const index = JSON.parse((await AsyncStorage.getItem('@scan_kit_doc_index')) as string);
    expect(index.sort()).toEqual(['A', 'B']);
  });

  test('documentIdsForCleanup returns the stored ids', async () => {
    await storage.saveDocument({ ...doc, id: 'A' });
    expect(await storage.documentIdsForCleanup()).toEqual(['A']);
  });

  test('documentIdsForCleanup returns [] only for a genuinely empty library', async () => {
    expect(await storage.documentIdsForCleanup()).toEqual([]);
  });

  test('documentIdsForCleanup keeps a record that cannot be read, even when it is the only one', async () => {
    await AsyncStorage.setItem('@scan_kit_schema_version', '3');
    await AsyncStorage.setItem('@scan_kit_doc:A', '{corrupt');
    expect(await storage.documentIdsForCleanup()).toEqual(['A']);
  });

  test('documentIdsForCleanup keeps a corrupt document next to readable ones (critique #7)', async () => {
    await storage.saveDocument({ ...doc, id: 'good' });
    await storage.saveDocument({ ...doc, id: 'broken' });
    await AsyncStorage.setItem('@scan_kit_doc:broken', '{corrupt');
    // A normal read drops the broken record from the index …
    expect((await storage.getDocuments()).map(d => d.id)).toEqual(['good']);
    // … but its folder must still be protected from the orphan sweep.
    expect((await storage.documentIdsForCleanup())?.sort()).toEqual(['broken', 'good']);
  });

  test('documentFileRefsForCleanup lists what every record points at, trashed included, corrupt left out', async () => {
    await storage.saveDocument({ ...doc, id: 'pages', pages: ['file:///CURRENT/Documents/scan-kit/pages/page-0.jpg'] });
    await storage.saveDocument({ ...doc, id: 'pdf', pages: [], pdfUri: 'file:///CURRENT/Documents/scan-kit/pdf/document.pdf' });
    await storage.trashDocument('pdf');
    await storage.saveDocument({ ...doc, id: 'broken' });
    await AsyncStorage.setItem('@scan_kit_doc:broken', '{corrupt');
    const refs = (await storage.documentFileRefsForCleanup())!;
    expect(refs.map(r => r.id).sort()).toEqual(['pages', 'pdf']);
    const pdf = refs.find(r => r.id === 'pdf')!;
    expect(pdf.pages).toEqual([]);
    expect(pdf.pdfUri).toMatch(/\/pdf\/document\.pdf$/);
    expect(typeof pdf.updatedAt).toBe('number');
  });

  test('withDocumentFileRefs reads the record afresh inside the docs lock (r8 #5)', async () => {
    await storage.saveDocument({ ...doc, id: 'conv', pages: [], pdfUri: 'file:///CURRENT/Documents/scan-kit/conv/document.pdf' });
    // A write queued before the sweep's turn is seen by it.
    const write = storage.patchDocument('conv', { pages: ['file:///CURRENT/Documents/scan-kit/conv/page-0.jpg'], pdfUri: undefined, updatedAt: 5000 });
    const order: string[] = [];
    const seen = storage.withDocumentFileRefs('conv', fresh => {
      order.push('act');
      return fresh;
    });
    // A write queued after it waits until `act` has returned.
    const later = storage.patchDocument('conv', { name: 'Renamed' }).then(() => order.push('later write'));
    const fresh = await seen;
    await write;
    await later;
    expect(order).toEqual(['act', 'later write']);
    expect(fresh).toEqual({ id: 'conv', pages: ['file:///CURRENT/Documents/scan-kit/conv/page-0.jpg'], pdfUri: undefined, updatedAt: 5000 });
  });

  test('withDocumentFileRefs gives null for a missing or corrupt record, trashed ones included', async () => {
    expect(await storage.withDocumentFileRefs('nope', r => r)).toBeNull();
    await storage.saveDocument({ ...doc, id: 'bad' });
    await AsyncStorage.setItem('@scan_kit_doc:bad', '{corrupt');
    expect(await storage.withDocumentFileRefs('bad', r => r)).toBeNull();
    await storage.saveDocument({ ...doc, id: 'tr' });
    await storage.trashDocument('tr');
    expect((await storage.withDocumentFileRefs('tr', r => r))?.id).toBe('tr');
  });

  test('documentIdsForCleanup keeps trashed documents', async () => {
    await storage.saveDocument({ ...doc, id: 'A' });
    await storage.trashDocument('A');
    expect(await storage.documentIdsForCleanup()).toEqual(['A']);
  });
});

describe('Recently deleted (trash)', () => {
  const DAY = 24 * 60 * 60 * 1000;

  test('trashing hides a document from getDocuments and getDocument but keeps its files', async () => {
    await storage.saveDocument({ ...doc, id: 'A' });
    await storage.saveDocument({ ...doc, id: 'B' });
    expect(await storage.trashDocument('A')).toBe(true);
    expect((await storage.getDocuments()).map(d => d.id)).toEqual(['B']);
    expect(await storage.getDocument('A')).toBeNull();
    expect(await storage.getDocument('B')).not.toBeNull();
    expect(mockDeletedDirs).toEqual([]);
    const trashed = await storage.getTrashedDocuments();
    expect(trashed.map(d => d.id)).toEqual(['A']);
    expect(typeof trashed[0].trashedAt).toBe('number');
  });

  test('trashing a missing or already-trashed document reports false', async () => {
    await storage.saveDocument({ ...doc, id: 'A' });
    expect(await storage.trashDocument('missing')).toBe(false);
    expect(await storage.trashDocument('A')).toBe(true);
    expect(await storage.trashDocument('A')).toBe(false);
  });

  test('restoring brings the document back unchanged', async () => {
    await storage.saveDocument({ ...doc, id: 'A', folder: 'Work' });
    await storage.trashDocuments(['A']);
    expect(await storage.restoreDocument('A')).toBe(true);
    const [back] = await storage.getDocuments();
    expect(back).toEqual({ ...doc, id: 'A', folder: 'Work' });
    expect(await storage.getTrashedDocuments()).toEqual([]);
    expect(await storage.restoreDocument('A')).toBe(false);
  });

  test('bulk trash and restore report counts', async () => {
    for (const id of ['A', 'B', 'C']) await storage.saveDocument({ ...doc, id });
    expect(await storage.trashDocuments(['A', 'B', 'missing'])).toBe(2);
    expect(await storage.restoreDocuments(['A', 'C'])).toBe(1);
    expect((await storage.getDocuments()).map(d => d.id).sort()).toEqual(['A', 'C']);
  });

  test('trashed documents are listed most recently trashed first', async () => {
    await storage.saveDocument({ ...doc, id: 'old', trashedAt: Date.now() - 2 * DAY });
    await storage.saveDocument({ ...doc, id: 'new', trashedAt: Date.now() - DAY });
    expect((await storage.getTrashedDocuments()).map(d => d.id)).toEqual(['new', 'old']);
  });

  test('folder renames and deletions reach trashed documents', async () => {
    await storage.saveFolder('Old');
    await storage.saveDocument({ ...doc, id: 'A', folder: 'Old' });
    await storage.trashDocument('A');
    await storage.renameFolder('Old', 'New');
    await storage.restoreDocument('A');
    expect((await storage.getDocument('A'))?.folder).toBe('New');
  });

  test('deleteForever removes the record and the files', async () => {
    await storage.saveDocument({ ...doc, id: 'A' });
    await storage.trashDocument('A');
    await storage.deleteForever('A');
    expect(await storage.getTrashedDocuments()).toEqual([]);
    expect(await AsyncStorage.getItem('@scan_kit_doc:A')).toBeNull();
    expect(mockDeletedDirs).toEqual(['A']);
    expect(await storage.documentIdsForCleanup()).toEqual([]);
  });

  test('emptyTrash deletes only trashed documents', async () => {
    for (const id of ['A', 'B', 'C']) await storage.saveDocument({ ...doc, id });
    await storage.trashDocuments(['A', 'C']);
    expect(await storage.emptyTrash()).toBe(2);
    expect(mockDeletedDirs.sort()).toEqual(['A', 'C']);
    expect((await storage.getDocuments()).map(d => d.id)).toEqual(['B']);
  });

  test('purgeExpiredTrash deletes documents trashed 30+ days ago and keeps the rest', async () => {
    const now = Date.now();
    await storage.saveDocument({ ...doc, id: 'expired', trashedAt: now - 31 * DAY });
    await storage.saveDocument({ ...doc, id: 'recent', trashedAt: now - 29 * DAY });
    await storage.saveDocument({ ...doc, id: 'live' });
    expect(await storage.purgeExpiredTrash(30, now)).toBe(1);
    expect(mockDeletedDirs).toEqual(['expired']);
    expect((await storage.getTrashedDocuments(now)).map(d => d.id)).toEqual(['recent']);
    expect((await storage.getDocuments()).map(d => d.id)).toEqual(['live']);
  });

  test('the startup sweep purges expired trash before listing ids to keep', async () => {
    await storage.saveDocument({ ...doc, id: 'expired', trashedAt: Date.now() - 40 * DAY });
    await storage.saveDocument({ ...doc, id: 'live' });
    expect(await storage.documentIdsForCleanup()).toEqual(['live']);
    expect(mockDeletedDirs).toEqual(['expired']);
  });

  test('trashDaysLeft counts down from 30', () => {
    const now = 1_000_000_000_000;
    expect(storage.trashDaysLeft({ trashedAt: now }, now)).toBe(30);
    expect(storage.trashDaysLeft({ trashedAt: now - 10.5 * DAY }, now)).toBe(20);
    expect(storage.trashDaysLeft({ trashedAt: now - 45 * DAY }, now)).toBe(0);
  });
});

describe('updateDocumentWith', () => {
  test('computes the patch from the current record and can decline to write', async () => {
    await storage.saveDocument({ ...doc, id: 'A', name: 'Auto', defaultName: 'Auto' });
    const rename = (cur: Document) => (cur.name === cur.defaultName ? { name: 'Invoice', defaultName: undefined } : null);
    expect(await storage.updateDocumentWith('A', rename)).toBe(true);
    const after = await storage.getDocument('A');
    expect(after?.name).toBe('Invoice');
    expect(after && 'defaultName' in after).toBe(false);
    expect(await storage.updateDocumentWith('A', rename)).toBe(false);
  });
});

describe('renameFolder', () => {
  test('renames the folder and moves its documents', async () => {
    await storage.saveFolder('Old');
    await storage.saveDocument({ ...doc, id: 'in', folder: 'Old' });
    await storage.saveDocument({ ...doc, id: 'out', folder: 'Other' });
    expect(await storage.renameFolder('Old', '  New ')).toBe(true);
    expect(await storage.getFolders()).toEqual(['New']);
    const docs = await storage.getDocuments();
    expect(docs.find(d => d.id === 'in')?.folder).toBe('New');
    expect(docs.find(d => d.id === 'out')?.folder).toBe('Other');
  });

  test('merges into an existing folder without duplicating it', async () => {
    await storage.saveFolder('A');
    await storage.saveFolder('B');
    await storage.renameFolder('A', 'B');
    expect(await storage.getFolders()).toEqual(['B']);
  });

  test('refuses an empty or unchanged name', async () => {
    await storage.saveFolder('A');
    expect(await storage.renameFolder('A', '  ')).toBe(false);
    expect(await storage.renameFolder('A', 'A')).toBe(false);
    expect(await storage.getFolders()).toEqual(['A']);
  });
});

describe('subscribeDocumentChanges', () => {
  test('notifies after a background patch is written, not when nothing is written', async () => {
    await storage.saveDocument({ ...doc, id: 'watch-1' });
    const seen: string[] = [];
    const off = storage.subscribeDocumentChanges((id: string) => seen.push(id));
    await storage.patchDocument('watch-1', { name: 'Invoice #2026-0417' });
    await storage.updateDocumentWith('watch-1', () => null);
    await storage.patchDocument('missing-id', { name: 'x' });
    off();
    await storage.patchDocument('watch-1', { name: 'after unsubscribe' });
    expect(seen).toEqual(['watch-1']);
  });
});

test('startup removes the API key older builds stored for the removed Ask AI feature', async () => {
  await AsyncStorage.setItem('@scan_kit_ai_key', 'sk-test-not-real');
  await AsyncStorage.setItem('@scan_kit_schema_version', '3');
  await storage.getDocuments();
  expect(await AsyncStorage.getItem('@scan_kit_ai_key')).toBeNull();
  expect('getAiKey' in storage).toBe(false);
});

describe('pending documents (Save as a copy, r9 code #4)', () => {
  const copy: Document = { ...doc, id: 'copy-1', name: 'Lease (signed)' };

  test('a pending document is found by id but listed nowhere until committed', async () => {
    await storage.saveDocument(doc);
    await storage.savePendingDocument(copy);
    expect((await storage.getDocuments()).map(d => d.id)).toEqual(['test-id']);
    expect(await storage.getDocument('copy-1')).toMatchObject({ name: 'Lease (signed)' });
    expect(await storage.commitPendingDocument('copy-1', { updatedAt: 5 })).toBe(true);
    expect((await storage.getDocuments()).map(d => d.id)).toEqual(['copy-1', 'test-id']);
    expect((await storage.getDocument('copy-1'))?.updatedAt).toBe(5);
    expect(await AsyncStorage.getItem('@scan_kit_pending_docs')).toBeNull();
  });

  test('one left pending by a crash is deleted by the startup sweep, record and files', async () => {
    await storage.saveDocument(doc);
    await storage.savePendingDocument(copy);
    const keep = await storage.documentIdsForCleanup();
    expect(keep).toEqual(['test-id']);
    expect(mockDeletedDirs).toEqual(['copy-1']);
    expect(await storage.getDocument('copy-1')).toBeNull();
    expect(await AsyncStorage.getItem('@scan_kit_pending_docs')).toBeNull();
  });

  test('deleting a pending document clears its mark; committing a gone one is refused', async () => {
    await storage.savePendingDocument(copy);
    await storage.deleteDocument('copy-1');
    expect(await AsyncStorage.getItem('@scan_kit_pending_docs')).toBeNull();
    expect(await storage.commitPendingDocument('copy-1')).toBe(false);
  });
});
