// __tests__/storage-layout.test.ts
//
// The move of the app's files out of Documents (lib/storage-layout.ts) and the
// healing of stored URIs that follows it (lib/storage.ts healDocPaths). The
// owner's rule: an update must never lose or break a user's photos. These
// tests run the real code against an in-memory file system whose move/rename
// semantics match expo-file-system on iOS (Directory.move nests into an
// existing destination; File.move refuses an existing one), with injectable
// failures.

type Node = { type: 'dir' } | { type: 'file'; content: string; mtime: number };

const mockFs = new Map<string, Node>();
/** Keys (no trailing slash) whose move throws, to simulate a failed rename. */
const mockFailMoves = new Set<string>();
/** Keys whose copy throws (a full disk). */
const mockFailCopies = new Set<string>();
const mockState: { container: string; moves: number; movedFrom: string[]; docs?: string; cache?: string } = {
  container: 'file:///var/mobile/Containers/Data/Application/C1',
  moves: 0,
  movedFrom: [],
};

jest.mock('expo-file-system', () => {
  // iOS: /private/var is a firmlink to /var — either spelling names the same file.
  const strip = (u: string) => u.replace(/\/+$/, '').replace(/^file:\/\/\/private\/var\//, 'file:///var/');
  const enc = (seg: string) => seg.split('/').map(s => s.replace(/ /g, '%20')).join('/');
  const join = (parts: any[]) => {
    const [first, ...rest] = parts;
    const base = strip(typeof first === 'string' ? first : first.uri);
    return [base, ...rest.map(p => enc(strip(String(p))))].join('/');
  };
  const parentOf = (key: string) => key.slice(0, key.lastIndexOf('/'));
  const nameOf = (key: string) => decodeURIComponent(key.slice(key.lastIndexOf('/') + 1));
  const isUnder = (k: string, root: string) => k === root || k.startsWith(`${root}/`);

  function moveTree(from: string, to: string) {
    if (mockFailMoves.has(from)) throw new Error(`EPERM rename ${from}`);
    if (mockFs.has(to)) throw new Error(`EEXIST ${to}`);
    if (mockFs.get(parentOf(to))?.type !== 'dir') throw new Error(`ENOENT parent of ${to}`);
    mockState.moves++;
    mockState.movedFrom.push(from);
    const entries = [...mockFs.entries()].filter(([k]) => isUnder(k, from));
    for (const [k] of entries) mockFs.delete(k);
    for (const [k, v] of entries) mockFs.set(to + k.slice(from.length), v);
  }

  class MockDirectory {
    key: string;
    constructor(...parts: any[]) { this.key = strip(join(parts)); }
    get uri() { return `${this.key}/`; }
    get name() { return nameOf(this.key); }
    get exists() { return mockFs.get(this.key)?.type === 'dir'; }
    create(opts: { intermediates?: boolean; idempotent?: boolean } = {}) {
      if (this.exists) { if (opts.idempotent) return; throw new Error('exists'); }
      if (mockFs.has(this.key)) throw new Error('a file is in the way');
      const missing: string[] = [];
      let k = this.key;
      while (k.includes('/') && !mockFs.has(k) && k !== 'file://') { missing.push(k); k = parentOf(k); }
      if (missing.length > 1 && !opts.intermediates) throw new Error('parent missing');
      for (const m of missing) mockFs.set(m, { type: 'dir' });
    }
    list() {
      if (!this.exists) throw new Error('ENOENT');
      const out: any[] = [];
      for (const [k, v] of mockFs) {
        if (parentOf(k) !== this.key) continue;
        out.push(v.type === 'dir' ? new MockDirectory(k) : new MockFile(k));
      }
      return out;
    }
    move(dest: any) {
      if (!this.exists) throw new Error('ENOENT');
      const target = dest instanceof MockDirectory && dest.exists ? `${dest.key}/${encodeURIComponent(this.name)}` : dest.key;
      moveTree(this.key, target);
      this.key = target;
    }
    delete() {
      if (!this.exists) throw new Error('ENOENT');
      for (const k of [...mockFs.keys()]) if (isUnder(k, this.key)) mockFs.delete(k);
    }
    info() { return { exists: this.exists, modificationTime: 1 }; }
  }

  class MockFile {
    key: string;
    constructor(...parts: any[]) { this.key = strip(join(parts)); }
    get uri() { return this.key; }
    get name() { return nameOf(this.key); }
    get exists() { return mockFs.get(this.key)?.type === 'file'; }
    get size() { const n = mockFs.get(this.key); return n?.type === 'file' ? n.content.length : 0; }
    get md5() { const n = mockFs.get(this.key); return n?.type === 'file' ? `md5:${n.content}` : null; }
    textSync() { const n = mockFs.get(this.key); if (n?.type !== 'file') throw new Error('ENOENT'); return n.content; }
    create() {
      if (mockFs.get(parentOf(this.key))?.type !== 'dir') throw new Error('parent missing');
      mockFs.set(this.key, { type: 'file', content: '', mtime: 1 });
    }
    write(content: string) {
      if (mockFs.get(parentOf(this.key))?.type !== 'dir') throw new Error('parent missing');
      mockFs.set(this.key, { type: 'file', content, mtime: 1 });
    }
    move(dest: any) {
      if (!this.exists) throw new Error('ENOENT');
      const target = dest instanceof MockDirectory ? `${dest.key}/${encodeURIComponent(this.name)}` : dest.key;
      moveTree(this.key, target);
      this.key = target;
    }
    copy(dest: any) {
      const n = mockFs.get(this.key);
      if (n?.type !== 'file') throw new Error('ENOENT');
      if (mockFailCopies.has(this.key)) throw new Error(`ENOSPC copy ${this.key}`);
      if (mockFs.has(dest.key)) throw new Error(`EEXIST ${dest.key}`);
      mockFs.set(dest.key, { ...n });
    }
    delete() { if (!this.exists) throw new Error('ENOENT'); mockFs.delete(this.key); }
    info() { return { exists: this.exists, modificationTime: 1 }; }
  }

  return {
    File: MockFile,
    Directory: MockDirectory,
    Paths: {
      get document() { return new MockDirectory(mockState.docs ?? `${mockState.container}/Documents`); },
      get cache() { return new MockDirectory(mockState.cache ?? `${mockState.container}/Library/Caches`); },
    },
  };
});

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
// storage.ts only needs these two from files.ts; the real one pulls in native modules.
jest.mock('../lib/files', () => ({
  originalUri: (docId: string, i: number) => `file:///x/scan-kit/${docId}/page-${i}.orig.jpg`,
  deleteDocumentFiles: jest.fn(),
}));

type Layout = typeof import('../lib/storage-layout');
let L: Layout;

const C1 = 'file:///var/mobile/Containers/Data/Application/C1';
const C0 = 'file:///var/mobile/Containers/Data/Application/C0-OLD';
const DOCS = `${C1}/Documents`;
const SUPPORT = `${C1}/Library/Application%20Support`;

function dir(key: string) { mockFs.set(key, { type: 'dir' }); }
function put(key: string, content: string) {
  // make parents
  const parts = key.split('/');
  for (let i = 4; i < parts.length; i++) {
    const k = parts.slice(0, i).join('/');
    if (!mockFs.has(k)) mockFs.set(k, { type: 'dir' });
  }
  mockFs.set(key, { type: 'file', content, mtime: 1 });
}
function files(prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of mockFs) if (v.type === 'file' && k.startsWith(`${prefix}/`)) out[k.slice(prefix.length + 1)] = v.content;
  return out;
}
function under(prefix: string): string[] {
  return [...mockFs.keys()].filter(k => k.startsWith(`${prefix}/`)).map(k => k.slice(prefix.length + 1)).sort();
}

/** Document ids as the app makes them (Crypto.randomUUID). */
const U1 = '0b2f6c1e-5a1d-4c3e-9f00-1a2b3c4d5e61';
const U2 = '7c9d8e7f-6a5b-4c3d-8e2f-0a1b2c3d4e52';
/** A document the April 2026 Merge tool made (Documents/documents/<id>/page_N.jpg). */
const M = '3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7';
const SCAN = 'DOCUMENT_SCAN_0_20261101_093000.jpg';

/** A library as builds up to round 9 left it, plus iOS's own Library folders. */
function seedOldLayout() {
  dir(C1);
  dir(DOCS);
  dir(`${C1}/Library`);
  dir(`${C1}/Library/Caches`);
  dir(SUPPORT); // AsyncStorage lives here already
  put(`${SUPPORT}/com.example/RCTAsyncLocalStorage_V1/manifest.json`, '{}');
  put(`${DOCS}/scan-kit/doc-a/page-0.jpg`, 'A0');
  put(`${DOCS}/scan-kit/doc-a/page-0.orig.jpg`, 'A0-orig');
  put(`${DOCS}/scan-kit/doc-a/page-1.jpg`, 'A1');
  put(`${DOCS}/scan-kit/doc-a/ocr/123-456.json`, '{"text":"hi"}');
  put(`${DOCS}/scan-kit/doc-pdf/document.pdf`, '%PDF');
  put(`${DOCS}/scan-kit/doc-trash/page-0.jpg`, 'T0');
  put(`${DOCS}/signatures/index.json`, '[{"id":"sig-00000001"}]');
  put(`${DOCS}/signatures/sig-00000001.png`, 'PNG');
  put(`${DOCS}/documents/${M}/page_0.jpg`, 'M0'); // April 2026 Merge tool
  put(`${DOCS}/Inbox/Lease.pdf`, 'inbox');
  put(`${DOCS}/${SCAN}`, 'scanner');
}

beforeEach(() => {
  jest.resetModules();
  mockFs.clear();
  mockFailMoves.clear();
  mockFailCopies.clear();
  mockState.container = C1;
  mockState.moves = 0;
  mockState.movedFrom = [];
  delete mockState.docs;
  delete mockState.cache;
  L = require('../lib/storage-layout');
});

/** Launches the app again (a fresh process): the move runs again from scratch. */
function relaunch(now: number) {
  jest.resetModules();
  L = require('../lib/storage-layout');
  return L.migrateStorageLayout(now);
}

const marker = () => JSON.parse(files(SUPPORT)['storage-layout.json']);
const movesOutOfDocuments = () => mockState.movedFrom.filter(k => k.startsWith(`${DOCS}/`)).length;

describe('moving the app data out of Documents', () => {
  test('an upgrade moves every page, shadow, OCR file and signature byte for byte', () => {
    seedOldLayout();
    const before = { scan: files(`${DOCS}/scan-kit`), sigs: files(`${DOCS}/signatures`) };

    const r = L.migrateStorageLayout(1000);

    expect(r.state).toBe('app-support');
    expect(r.errors).toEqual([]);
    expect(files(`${SUPPORT}/scan-kit`)).toEqual(before.scan);
    expect(files(`${SUPPORT}/signatures`)).toEqual(before.sigs);
    expect(L.scanRoot().uri).toBe(`${SUPPORT}/scan-kit/`);
    expect(L.signaturesDir().uri).toBe(`${SUPPORT}/signatures/`);
    // AsyncStorage's folder is untouched.
    expect(files(`${SUPPORT}/com.example`)).toEqual({ 'RCTAsyncLocalStorage_V1/manifest.json': '{}' });
  });

  test('nothing of the app stays visible in Documents, and nothing else is touched', () => {
    seedOldLayout();
    put(`${DOCS}/harness-log.txt`, 'log'); // not something any build wrote: left alone
    L.migrateStorageLayout(1000);

    // iOS's Inbox and the scanner's transient output (both swept by lib/files.ts).
    expect(under(DOCS)).toEqual([SCAN, 'Inbox', 'Inbox/Lease.pdf', 'harness-log.txt']);
    expect(files(`${SUPPORT}/legacy-documents`)).toEqual({ [`documents/${M}/page_0.jpg`]: 'M0' });
  });

  test('it is done with renames, never by copying and deleting', () => {
    seedOldLayout();
    L.migrateStorageLayout(1000);
    // scan-kit, signatures, documents/<id> — one rename each.
    expect(movesOutOfDocuments()).toBe(3);
  });

  test('completion is recorded, and a second launch does nothing', () => {
    seedOldLayout();
    L.migrateStorageLayout(1000);
    expect(marker()).toMatchObject({ version: 3, strays: 'done', migratedAt: 1000 });
    const snapshot = new Map(mockFs);

    const r = relaunch(2000);

    expect(r.state).toBe('app-support');
    expect(r.actions).toEqual([]);
    expect(new Map(mockFs)).toEqual(snapshot);
  });

  test('a fresh install uses Application Support straight away', () => {
    dir(C1); dir(DOCS); dir(`${C1}/Library`); dir(`${C1}/Library/Caches`);
    const r = L.migrateStorageLayout(1000);
    expect(r.state).toBe('app-support');
    expect(L.docDir('new-doc').uri).toBe(`${SUPPORT}/scan-kit/new-doc/`);
    expect(under(DOCS)).toEqual([]);
  });

  test('the folders are found lazily: the first path asked for runs the move', () => {
    seedOldLayout();
    const d = L.docDir('doc-a');
    expect(d.uri).toBe(`${SUPPORT}/scan-kit/doc-a/`);
    expect(d.exists).toBe(true);
  });

  test('a destination that already exists is never nested into (no scan-kit/scan-kit)', () => {
    seedOldLayout();
    dir(`${SUPPORT}/scan-kit`); // e.g. made by an earlier partial run
    L.migrateStorageLayout(1000);
    expect(mockFs.has(`${SUPPORT}/scan-kit/scan-kit`)).toBe(false);
    expect(files(`${SUPPORT}/scan-kit`)['doc-a/page-0.jpg']).toBe('A0');
  });

  test('Android / unknown containers keep the Documents layout and move nothing', () => {
    const A = 'file:///data/user/0/com.sixyato9.scankit';
    mockState.docs = `${A}/files`;
    mockState.cache = `${A}/cache`;
    put(`${A}/files/scan-kit/doc-a/page-0.jpg`, 'A0');
    dir(`${A}/cache`);

    const r = L.migrateStorageLayout(1000);

    expect(r.state).toBe('documents');
    expect(mockState.moves).toBe(0);
    expect(L.docDir('doc-a').uri).toBe(`${A}/files/scan-kit/doc-a/`);
    expect(L.rebaseStoredUri(`${A}/files/scan-kit/doc-a/page-0.jpg`)).toBe(`${A}/files/scan-kit/doc-a/page-0.jpg`);
  });

  test('Documents and Caches from different containers: nothing is moved', () => {
    seedOldLayout();
    mockState.cache = `${C0}/Library/Caches`;
    const r = L.migrateStorageLayout(1000);
    expect(r.state).toBe('documents');
    expect(mockState.moves).toBe(0);
  });
});

describe('when the move fails', () => {
  test('a failed rename of the whole folder still moves each document with its own rename', () => {
    seedOldLayout();
    const before = files(`${DOCS}/scan-kit`);
    mockFailMoves.add(`${DOCS}/scan-kit`);

    const r = L.migrateStorageLayout(1000);

    expect(r.state).toBe('app-support');
    expect(files(`${SUPPORT}/scan-kit`)).toEqual(before);
    expect(mockFs.has(`${DOCS}/scan-kit`)).toBe(false);
  });

  test('a page that can’t be renamed is copied, checked, and only then removed from Documents', () => {
    seedOldLayout();
    for (const k of ['scan-kit', 'scan-kit/doc-a', 'scan-kit/doc-a/page-1.jpg']) mockFailMoves.add(`${DOCS}/${k}`);

    const r = L.migrateStorageLayout(1000);

    expect(r.state).toBe('app-support');
    expect(files(`${SUPPORT}/scan-kit/doc-a`)['page-1.jpg']).toBe('A1');
    expect(mockFs.has(`${DOCS}/scan-kit`)).toBe(false);
  });

  test('a document that can be neither renamed nor copied stays where it was and is used from there', () => {
    seedOldLayout();
    const before = files(`${DOCS}/scan-kit/doc-pdf`);
    for (const k of ['scan-kit', 'scan-kit/doc-pdf', 'scan-kit/doc-pdf/document.pdf']) mockFailMoves.add(`${DOCS}/${k}`);
    mockFailCopies.add(`${DOCS}/scan-kit/doc-pdf/document.pdf`);

    const r = L.migrateStorageLayout(1000);

    expect(r.state).toBe('split');
    expect(files(`${DOCS}/scan-kit/doc-pdf`)).toEqual(before); // nothing lost, nothing half-copied
    expect(mockFs.has(`${SUPPORT}/scan-kit/doc-pdf/document.pdf`)).toBe(false);
    expect(L.docDir('doc-pdf').uri).toBe(`${DOCS}/scan-kit/doc-pdf/`);
    expect(L.docDir('doc-a').uri).toBe(`${SUPPORT}/scan-kit/doc-a/`);
    expect(marker().migratedAt).toBeUndefined(); // not recorded as complete

    mockFailMoves.clear();
    mockFailCopies.clear();
    expect(relaunch(2000).state).toBe('app-support');
    expect(files(`${SUPPORT}/scan-kit/doc-pdf`)).toEqual(before);
    expect(mockFs.has(`${DOCS}/scan-kit`)).toBe(false);
    expect(marker().migratedAt).toBe(2000);
  });

  test('a crash between the two folders is finished on the next launch', () => {
    seedOldLayout();
    // Launch 1 moved scan-kit and died before signatures.
    for (const k of ['signatures', 'signatures/index.json', 'signatures/sig-00000001.png']) mockFailMoves.add(`${DOCS}/${k}`);
    for (const k of ['signatures/index.json', 'signatures/sig-00000001.png']) mockFailCopies.add(`${DOCS}/${k}`);
    L.migrateStorageLayout(1000);
    // Still used from Documents (an empty new folder was made, so the new one is used).
    expect(files(`${DOCS}/signatures`)).toEqual({ 'index.json': '[{"id":"sig-00000001"}]', 'sig-00000001.png': 'PNG' });
    mockFailMoves.clear();
    mockFailCopies.clear();

    const r = relaunch(2000);

    expect(r.state).toBe('app-support');
    expect(files(`${SUPPORT}/signatures`)).toEqual({ 'index.json': '[{"id":"sig-00000001"}]', 'sig-00000001.png': 'PNG' });
    expect(mockFs.has(`${DOCS}/signatures`)).toBe(false);
  });

  test('both roots present: the contents are merged, and nothing is overwritten or lost', () => {
    seedOldLayout();
    // An older build ran after a newer one and re-created Documents/scan-kit;
    // the new root already holds doc-a with a newer page-0.
    put(`${SUPPORT}/scan-kit/doc-a/page-0.jpg`, 'A0-new');
    put(`${SUPPORT}/scan-kit/doc-new/page-0.jpg`, 'N0');

    const r = L.migrateStorageLayout(1000);

    expect(r.state).toBe('app-support');
    const now = files(`${SUPPORT}/scan-kit`);
    expect(now['doc-a/page-0.jpg']).toBe('A0-new'); // the new root's copy is kept in place
    expect(now['doc-a/page-0.orig.jpg']).toBe('A0-orig'); // missing ones are merged in
    expect(now['doc-a/page-1.jpg']).toBe('A1');
    expect(now['doc-pdf/document.pdf']).toBe('%PDF');
    expect(now['doc-new/page-0.jpg']).toBe('N0');
    // The other page-0 is kept aside, not deleted.
    expect(files(`${SUPPORT}/scan-kit-recovered/1000/scan-kit/doc-a`)).toEqual({ 'page-0.jpg': 'A0' });
    expect(mockFs.has(`${DOCS}/scan-kit`)).toBe(false);
  });
});

describe('after the move, Documents belongs to the user', () => {
  /** Upgraded on launch 1 (at t=1000); Documents is now visible in Files. */
  function upgraded() {
    seedOldLayout();
    L.migrateStorageLayout(1000);
  }

  test('a folder the user calls "scan-kit", with their own files, is never merged, moved or swept', async () => {
    upgraded();
    put(`${DOCS}/scan-kit/Taxes/receipt.pdf`, 'user-receipt');
    put(`${DOCS}/scan-kit/notes.txt`, 'user-notes');
    dir(`${DOCS}/scan-kit/Empty folder`);
    const before = new Map(mockFs);

    const r = relaunch(2000);

    expect(r.state).toBe('app-support');
    expect(r.actions).toEqual([]);
    expect(new Map(mockFs)).toEqual(before);
    expect(L.scanRoots().map(d => d.uri)).toEqual([`${SUPPORT}/scan-kit/`]);
    // Every later launch too.
    relaunch(3000);
    expect(new Map(mockFs)).toEqual(before);
  });

  test('a folder that looks like a document’s but isn’t named with a document id is left alone', () => {
    upgraded();
    put(`${DOCS}/scan-kit/Holiday/page-0.jpg`, 'user-photo');
    relaunch(2000);
    expect(files(`${DOCS}/scan-kit`)).toEqual({ 'Holiday/page-0.jpg': 'user-photo' });
  });

  test('a document-id folder with one of the user’s files in it is left alone', () => {
    upgraded();
    put(`${DOCS}/scan-kit/${U1}/page-0.jpg`, 'P');
    put(`${DOCS}/scan-kit/${U1}/my-letter.docx`, 'user');
    relaunch(2000);
    expect(files(`${DOCS}/scan-kit/${U1}`)).toEqual({ 'page-0.jpg': 'P', 'my-letter.docx': 'user' });
  });

  test('a folder the user calls "signatures" is left alone', () => {
    upgraded();
    put(`${DOCS}/signatures/John.png`, 'user-sig');
    const r = relaunch(2000);
    expect(files(`${DOCS}/signatures`)).toEqual({ 'John.png': 'user-sig' });
    expect(r.signaturesDir).toBe(`${SUPPORT}/signatures/`);
    expect(files(`${SUPPORT}/signatures`)).toEqual({ 'index.json': '[{"id":"sig-00000001"}]', 'sig-00000001.png': 'PNG' });
  });

  test('a user folder named "documents" is never taken by the one-time pass', () => {
    seedOldLayout();
    put(`${DOCS}/documents/Taxes/2025.pdf`, 'user');
    put(`${DOCS}/documents/${U2}/page_0.jpg`, 'X');
    put(`${DOCS}/documents/${U2}/cv.pdf`, 'user-cv'); // not just Merge pages: not ours
    L.migrateStorageLayout(1000);
    expect(files(`${DOCS}/documents`)).toEqual({ 'Taxes/2025.pdf': 'user', [`${U2}/page_0.jpg`]: 'X', [`${U2}/cv.pdf`]: 'user-cv' });
    expect(files(`${SUPPORT}/legacy-documents`)).toEqual({ [`documents/${M}/page_0.jpg`]: 'M0' });
  });

  test('downgrade, then upgrade again: the older build’s documents come back, its edits are kept aside, the user’s files stay', () => {
    upgraded();
    // The older build re-created Documents/scan-kit: an edit of an existing
    // document (same file names) and a new document, plus a signature.
    put(`${DOCS}/scan-kit/doc-a/page-0.jpg`, 'A0-edited-by-older-build');
    put(`${DOCS}/scan-kit/doc-a/page-2.jpg`, 'A2-added-by-older-build');
    put(`${DOCS}/scan-kit/${U2}/page-0.jpg`, 'older-build-new-doc');
    put(`${DOCS}/scan-kit/Taxes/receipt.pdf`, 'user-receipt');
    put(`${DOCS}/signatures/index.json`, '[{"id":"sig-00000002"}]');
    put(`${DOCS}/signatures/sig-00000002.png`, 'PNG2');

    const r = relaunch(5000);

    // A folder with pages stays in Documents (doc-a, below), so the old root
    // is still read — no document in it can go missing (r11 #1).
    expect(r.state).toBe('split');
    expect(r.scanRoot).toBe(`${SUPPORT}/scan-kit/`);
    expect(L.docDir('doc-a').uri).toBe(`${SUPPORT}/scan-kit/doc-a/`); // the moved one wins
    // 'doc-a' isn't a document id: after the first move only real ids come back.
    // (Real documents always have one; see the next test.)
    expect(files(`${DOCS}/scan-kit`)['doc-a/page-0.jpg']).toBe('A0-edited-by-older-build');
    expect(files(`${SUPPORT}/scan-kit/${U2}`)).toEqual({ 'page-0.jpg': 'older-build-new-doc' });
    expect(files(`${DOCS}/scan-kit`)['Taxes/receipt.pdf']).toBe('user-receipt');
    // Signatures from both builds are listed in one index.
    expect(JSON.parse(files(`${SUPPORT}/signatures`)['index.json'])).toEqual([{ id: 'sig-00000001' }, { id: 'sig-00000002' }]);
    expect(files(`${SUPPORT}/signatures`)['sig-00000002.png']).toBe('PNG2');
    expect(mockFs.has(`${DOCS}/signatures`)).toBe(false);
  });

  test('downgrade, then upgrade again: a document edited by both builds keeps both versions', () => {
    dir(C1); dir(DOCS); dir(`${C1}/Library`); dir(`${C1}/Library/Caches`);
    put(`${DOCS}/scan-kit/${U1}/page-0.jpg`, 'v1');
    L.migrateStorageLayout(1000);
    put(`${SUPPORT}/scan-kit/${U1}/page-0.jpg`, 'v2'); // edited after the upgrade (rename-replace)
    mockFs.delete(`${SUPPORT}/scan-kit/${U1}/page-0.jpg`);
    put(`${SUPPORT}/scan-kit/${U1}/page-0.jpg`, 'v2');
    put(`${DOCS}/scan-kit/${U1}/page-0.jpg`, 'v1-edited-by-older-build');
    put(`${DOCS}/scan-kit/${U1}/page-1.jpg`, 'v1-page-added');

    relaunch(5000);

    expect(files(`${SUPPORT}/scan-kit/${U1}`)).toEqual({ 'page-0.jpg': 'v2', 'page-1.jpg': 'v1-page-added' });
    expect(files(`${SUPPORT}/scan-kit-recovered/5000/scan-kit/${U1}`)).toEqual({ 'page-0.jpg': 'v1-edited-by-older-build' });
    expect(mockFs.has(`${DOCS}/scan-kit`)).toBe(false); // emptied of the app's folders, so it goes
    // …and Settings › Recovered files offers it.
    const groups = L.listRecoveredGroups(new Set());
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: 'pages', savedAt: 5000, files: [`${SUPPORT}/scan-kit-recovered/5000/scan-kit/${U1}/page-0.jpg`] });
  });

  test('an older build’s empty "scan-kit" folder is never deleted (it can’t be told from a user’s)', () => {
    upgraded();
    dir(`${DOCS}/scan-kit`);
    relaunch(2000);
    expect(mockFs.get(`${DOCS}/scan-kit`)?.type).toBe('dir');
  });
});

describe('the record of the move', () => {
  test('a marker that can’t be read counts as "already moved": the Documents pass never runs again', () => {
    seedOldLayout();
    L.migrateStorageLayout(1000);
    put(`${SUPPORT}/storage-layout.json`, '{"version":3,"strays":"do'); // torn write
    put(`${DOCS}/documents/${U2}/page_0.jpg`, 'looks-like-april'); // would be taken if the pass ran
    put(`${DOCS}/scan-kit/Holiday/page-0.jpg`, 'user');

    const r = relaunch(2000);

    // 'split' only because a folder holding a page (Holiday) is in Documents/scan-kit: still read, never moved.
    expect(r.state).toBe('split');
    expect(r.scanRoot).toBe(`${SUPPORT}/scan-kit/`);
    expect(files(`${DOCS}/documents`)).toEqual({ [`${U2}/page_0.jpg`]: 'looks-like-april' });
    expect(files(`${DOCS}/scan-kit`)).toEqual({ 'Holiday/page-0.jpg': 'user' });
    expect(marker()).toMatchObject({ strays: 'done', migratedAt: 2000 }); // repaired
  });

  test('a marker lost between removing the old file and the rename is read from its side file', () => {
    seedOldLayout();
    L.migrateStorageLayout(1000);
    const text = files(SUPPORT)['storage-layout.json'];
    mockFs.delete(`${SUPPORT}/storage-layout.json`);
    put(`${SUPPORT}/storage-layout.json.new`, text);
    put(`${DOCS}/documents/${U2}/page_0.jpg`, 'looks-like-april');

    relaunch(2000);

    expect(files(`${DOCS}/documents`)).toEqual({ [`${U2}/page_0.jpg`]: 'looks-like-april' });
    expect(L.readJsonSync(new (require('expo-file-system').Directory)(SUPPORT), 'storage-layout.json')).toMatchObject({ state: 'ok' });
  });

  test('no marker at all, but Files copies were made: the Documents pass never runs', () => {
    seedOldLayout();
    put(`${SUPPORT}/files-copy.json`, '{}');
    put(`${DOCS}/Receipt.pdf`, 'a copy');
    L.migrateStorageLayout(1000);
    expect(files(`${DOCS}/documents`)).toEqual({ [`${M}/page_0.jpg`]: 'M0' });
    expect(files(DOCS)['Receipt.pdf']).toBe('a copy');
    // The app's own document folders (UUIDs only, by now) still come out.
    expect(files(`${SUPPORT}/scan-kit`)).toEqual({});
  });

  test('writes are atomic: a verified side file, renamed into place', () => {
    dir(C1); dir(DOCS); dir(`${C1}/Library`); dir(SUPPORT);
    const { Directory } = require('expo-file-system');
    const d = new Directory(SUPPORT);
    expect(L.writeJsonSync(d, 'x.json', { a: 1 })).toBe(true);
    expect(L.readJsonSync(d, 'x.json')).toEqual({ state: 'ok', value: { a: 1 } });
    expect(mockFs.has(`${SUPPORT}/x.json.new`)).toBe(false);
    // Died after removing the old file, before the rename: the side file is read, then finished.
    mockFs.delete(`${SUPPORT}/x.json`);
    put(`${SUPPORT}/x.json.new`, '{"a":2}');
    expect(L.readJsonSync(d, 'x.json')).toEqual({ state: 'ok', value: { a: 2 } });
    expect(L.writeJsonSync(d, 'x.json', { a: 3 })).toBe(true);
    expect(files(SUPPORT)['x.json']).toBe('{"a":3}');
    // A torn side file next to a good main file: the main file wins.
    put(`${SUPPORT}/x.json.new`, '{"a":');
    expect(L.readJsonSync(d, 'x.json')).toEqual({ state: 'ok', value: { a: 3 } });
    // Both torn: corrupt, not absent.
    put(`${SUPPORT}/x.json`, '{"a');
    expect(L.readJsonSync(d, 'x.json')).toEqual({ state: 'corrupt' });
  });
});

describe('the one-time pass over the Documents root', () => {
  test('never runs again once done: files and folders the user later puts there stay', () => {
    seedOldLayout();
    L.migrateStorageLayout(1000);
    put(`${DOCS}/My notes.pdf`, 'user');
    put(`${DOCS}/documents/${U2}/page_0.jpg`, 'user-made-look-alike');

    relaunch(2000);

    expect(files(DOCS)['My notes.pdf']).toBe('user');
    expect(files(DOCS)[`documents/${U2}/page_0.jpg`]).toBe('user-made-look-alike');
  });

  test('one interrupted half way is finished on the next launch', () => {
    seedOldLayout();
    for (const k of [`documents/${M}`, `documents/${M}/page_0.jpg`]) mockFailMoves.add(`${DOCS}/${k}`);
    mockFailCopies.add(`${DOCS}/documents/${M}/page_0.jpg`);
    L.migrateStorageLayout(1000);
    expect(marker()).toMatchObject({ strays: 'pending', strayAttempts: 1, migratedAt: 1000 });
    mockFailMoves.clear();
    mockFailCopies.clear();

    relaunch(2000);

    expect(under(DOCS)).toEqual([SCAN, 'Inbox', 'Inbox/Lease.pdf']);
    expect(marker().strays).toBe('done');
  });

  test('given up after three launches', () => {
    seedOldLayout();
    for (const k of [`documents/${M}`, `documents/${M}/page_0.jpg`]) mockFailMoves.add(`${DOCS}/${k}`);
    mockFailCopies.add(`${DOCS}/documents/${M}/page_0.jpg`);
    L.migrateStorageLayout(1000);
    relaunch(2000);
    relaunch(3000);
    expect(marker()).toMatchObject({ strays: 'pending', strayAttempts: 3 });
    mockFailMoves.clear();
    mockFailCopies.clear();
    relaunch(4000);
    expect(marker().strays).toBe('done');
    expect(files(`${DOCS}/documents`)).toEqual({ [`${M}/page_0.jpg`]: 'M0' });
  });
});

describe('recovered files', () => {
  test('legacy pages a document still uses are never offered; unused ones are', () => {
    seedOldLayout();
    L.migrateStorageLayout(1000);
    const page = `${SUPPORT}/legacy-documents/documents/${M}/page_0.jpg`;
    expect(L.listRecoveredGroups(new Set([page]))).toEqual([]);
    expect(L.listRecoveredGroups(null)).toEqual([]); // records unreadable: never offered
    const groups = L.listRecoveredGroups(new Set());
    expect(groups).toEqual([expect.objectContaining({ kind: 'pages', files: [page], savedAt: null })]);

    expect(L.deleteRecoveredGroup(groups[0])).toBe(true);
    expect(mockFs.has(`${SUPPORT}/legacy-documents`)).toBe(false); // empty parents tidied
    expect(L.listRecoveredGroups(new Set())).toEqual([]);
  });

  test('deleting a group never reaches outside the recovered folders', () => {
    seedOldLayout();
    L.migrateStorageLayout(1000);
    const stray = { key: 'x', dir: `${SUPPORT}/scan-kit/doc-a/`, kind: 'pages' as const, savedAt: null, files: [`${SUPPORT}/scan-kit/doc-a/page-0.jpg`], bytes: 1 };
    expect(L.deleteRecoveredGroup({ ...stray, dir: '' })).toBe(false);
    expect(files(`${SUPPORT}/scan-kit/doc-a`)['page-0.jpg']).toBe('A0');
    L.deleteRecoveredGroup(stray);
    expect(files(`${SUPPORT}/scan-kit/doc-a`)['page-0.jpg']).toBe('A0');
  });
});

describe('stored URIs heal to wherever the file is now', () => {
  beforeEach(() => {
    seedOldLayout();
  });

  test('old container + old root', () => {
    L.migrateStorageLayout(1000);
    expect(L.rebaseStoredUri(`${C0}/Documents/scan-kit/doc-a/page-0.jpg`)).toBe(`${SUPPORT}/scan-kit/doc-a/page-0.jpg`);
  });

  test('current container + old root', () => {
    L.migrateStorageLayout(1000);
    expect(L.rebaseStoredUri(`${DOCS}/scan-kit/doc-a/page-0.orig.jpg`)).toBe(`${SUPPORT}/scan-kit/doc-a/page-0.orig.jpg`);
  });

  test('old container + new root, and new root unchanged', () => {
    L.migrateStorageLayout(1000);
    expect(L.rebaseStoredUri(`${C0}/Library/Application%20Support/scan-kit/doc-pdf/document.pdf`)).toBe(`${SUPPORT}/scan-kit/doc-pdf/document.pdf`);
    expect(L.rebaseStoredUri(`${SUPPORT}/scan-kit/doc-a/page-1.jpg`)).toBe(`${SUPPORT}/scan-kit/doc-a/page-1.jpg`);
  });

  test('a document left behind (split): each document maps to where its folder is', () => {
    for (const k of ['scan-kit', 'scan-kit/doc-pdf', 'scan-kit/doc-pdf/document.pdf']) mockFailMoves.add(`${DOCS}/${k}`);
    mockFailCopies.add(`${DOCS}/scan-kit/doc-pdf/document.pdf`);
    L.migrateStorageLayout(1000);
    expect(L.storageLayout().state).toBe('split');
    expect(L.rebaseStoredUri(`${C0}/Documents/scan-kit/doc-a/page-0.jpg`)).toBe(`${SUPPORT}/scan-kit/doc-a/page-0.jpg`);
    expect(L.rebaseStoredUri(`${SUPPORT}/scan-kit/doc-pdf/document.pdf`)).toBe(`${DOCS}/scan-kit/doc-pdf/document.pdf`);
    expect(L.rebaseStoredUri(`${C0}/Documents/scan-kit/doc-pdf/document.pdf`)).toBe(`${DOCS}/scan-kit/doc-pdf/document.pdf`);
  });

  test('pages of documents merged by the April 2026 build follow the leftovers pass', () => {
    L.migrateStorageLayout(1000);
    expect(L.rebaseStoredUri(`${C0}/Documents/documents/${M}/page_0.jpg`)).toBe(`${SUPPORT}/legacy-documents/documents/${M}/page_0.jpg`);
  });

  test('anything the app does not own is left alone', () => {
    L.migrateStorageLayout(1000);
    for (const u of ['file:///somewhere/else/photo.jpg', `${DOCS}/Inbox/Lease.pdf`, 'ph://ABC', `${DOCS}/Receipt.pdf`]) {
      expect(L.rebaseStoredUri(u)).toBe(u);
    }
  });

  test('a ?v= cache-bust suffix survives', () => {
    L.migrateStorageLayout(1000);
    expect(L.rebaseStoredUri(`${DOCS}/scan-kit/doc-a/page-0.jpg?v=3`)).toBe(`${SUPPORT}/scan-kit/doc-a/page-0.jpg?v=3`);
  });
});

describe('records in storage', () => {
  type Storage = typeof import('../lib/storage');
  let storage: Storage;
  let AsyncStorage: typeof import('@react-native-async-storage/async-storage').default;

  async function seedRecords() {
    await AsyncStorage.setItem('@scan_kit_schema_version', '3');
    await AsyncStorage.setItem('@scan_kit_doc_index', JSON.stringify(['doc-a', 'doc-pdf', 'doc-trash']));
    await AsyncStorage.setItem('@scan_kit_doc:doc-a', JSON.stringify({
      id: 'doc-a', name: 'Lease', createdAt: 1, updatedAt: 1,
      pages: [`${C0}/Documents/scan-kit/doc-a/page-0.jpg`, `${DOCS}/scan-kit/doc-a/page-1.jpg`],
      filters: ['bw', 'original'],
    }));
    await AsyncStorage.setItem('@scan_kit_doc:doc-pdf', JSON.stringify({
      id: 'doc-pdf', name: 'Invoice', createdAt: 2, updatedAt: 2, pages: [],
      pdfUri: `${C0}/Documents/scan-kit/doc-pdf/document.pdf`,
    }));
    await AsyncStorage.setItem('@scan_kit_doc:doc-trash', JSON.stringify({
      id: 'doc-trash', name: 'Receipt', createdAt: 3, updatedAt: 3, trashedAt: Date.now(),
      pages: [`${DOCS}/scan-kit/doc-trash/page-0.jpg`],
    }));
  }

  beforeEach(async () => {
    seedOldLayout();
    jest.resetModules();
    L = require('../lib/storage-layout');
    AsyncStorage = require('@react-native-async-storage/async-storage');
    storage = require('../lib/storage');
    await seedRecords();
  });

  const exists = (uri: string) => mockFs.get(uri.replace(/\/+$/, ''))?.type === 'file';

  test('every page and PDF of every record (trash included) opens after the move', async () => {
    const live = await storage.getDocuments();
    const trashed = await storage.getTrashedDocuments();
    const all = [...live, ...trashed];
    expect(all.map(d => d.id).sort()).toEqual(['doc-a', 'doc-pdf', 'doc-trash']);
    for (const d of all) {
      for (const p of d.pages) expect(exists(p)).toBe(true);
      if (d.pdfUri) expect(exists(d.pdfUri)).toBe(true);
    }
    expect(live.find(d => d.id === 'doc-a')!.pages[0]).toBe(`${SUPPORT}/scan-kit/doc-a/page-0.jpg`);
  });

  test('the healed paths are written back on the next save', async () => {
    await storage.patchDocument('doc-a', { name: 'Lease 2026' });
    const raw = JSON.parse((await AsyncStorage.getItem('@scan_kit_doc:doc-a'))!);
    expect(raw.pages).toEqual([`${SUPPORT}/scan-kit/doc-a/page-0.jpg`, `${SUPPORT}/scan-kit/doc-a/page-1.jpg`]);
    expect(raw.filters).toEqual(['bw', 'original']);
    expect(raw.name).toBe('Lease 2026');
  });

  test('a restored document comes back with working paths', async () => {
    expect(await storage.restoreDocuments(['doc-trash'])).toBe(1);
    const raw = JSON.parse((await AsyncStorage.getItem('@scan_kit_doc:doc-trash'))!);
    expect(raw.pages).toEqual([`${SUPPORT}/scan-kit/doc-trash/page-0.jpg`]);
    expect(exists(raw.pages[0])).toBe(true);
  });

  test('a document left in Documents by a failed move still opens from there', async () => {
    jest.resetModules();
    mockFs.clear();
    seedOldLayout();
    for (const k of ['scan-kit', 'scan-kit/doc-pdf', 'scan-kit/doc-pdf/document.pdf']) mockFailMoves.add(`${DOCS}/${k}`);
    mockFailCopies.add(`${DOCS}/scan-kit/doc-pdf/document.pdf`);
    L = require('../lib/storage-layout');
    AsyncStorage = require('@react-native-async-storage/async-storage');
    storage = require('../lib/storage');
    await seedRecords();

    const docs = await storage.getDocuments();
    for (const d of docs) {
      for (const p of d.pages) expect(exists(p)).toBe(true);
      if (d.pdfUri) expect(exists(d.pdfUri)).toBe(true);
    }
    expect(docs.find(d => d.id === 'doc-pdf')!.pdfUri).toBe(`${DOCS}/scan-kit/doc-pdf/document.pdf`);
  });
});

describe('the startup sweep after the move', () => {
  jest.mock('expo-image-manipulator', () => ({ manipulateAsync: jest.fn(), SaveFormat: { JPEG: 'jpeg' } }));
  const NOW = 10 ** 13; // every mock file is "settled" (mtime 1)

  function realFiles(): typeof import('../lib/files') {
    return jest.requireActual('../lib/files');
  }

  test('never deletes a root, the signatures, the recovered or legacy folders, or a valid document', async () => {
    seedOldLayout();
    put(`${SUPPORT}/scan-kit/doc-a/page-0.jpg`, 'A0-new'); // forces a kept-aside conflict
    L.migrateStorageLayout(1000);
    put(`${SUPPORT}/scan-kit/orphan/page-0.jpg`, 'O');
    dir(`${SUPPORT}/scan-kit/scan-kit`); // a faulty nesting must never be swept as a "document"
    const files = realFiles();

    await files.garbageCollectOrphans(['doc-a', 'doc-pdf', 'doc-trash'], NOW);

    expect(mockFs.has(`${SUPPORT}/scan-kit/orphan`)).toBe(false); // a real orphan still goes
    expect(mockFs.has(`${SUPPORT}/scan-kit/scan-kit`)).toBe(true);
    for (const k of ['doc-a/page-0.jpg', 'doc-a/page-0.orig.jpg', 'doc-pdf/document.pdf', 'doc-trash/page-0.jpg']) {
      expect(mockFs.has(`${SUPPORT}/scan-kit/${k}`)).toBe(true);
    }
    expect(mockFs.has(`${SUPPORT}/signatures/sig-00000001.png`)).toBe(true);
    expect(mockFs.has(`${SUPPORT}/scan-kit-recovered/1000/scan-kit/doc-a/page-0.jpg`)).toBe(true);
    expect(mockFs.has(`${SUPPORT}/legacy-documents/documents/${M}/page_0.jpg`)).toBe(true);
  });

  test('an orphan folder holding anything but the app’s own files is never deleted', async () => {
    seedOldLayout();
    L.migrateStorageLayout(1000);
    // As an earlier build's merge could have left a user's folder (old mtimes kept).
    put(`${SUPPORT}/scan-kit/Taxes/receipt.pdf`, 'user');
    put(`${SUPPORT}/scan-kit/${U1}/page-0.jpg`, 'P');
    put(`${SUPPORT}/scan-kit/${U1}/letter.docx`, 'user');

    await realFiles().garbageCollectOrphans(['doc-a', 'doc-pdf', 'doc-trash'], NOW);

    expect(files(`${SUPPORT}/scan-kit/Taxes`)).toEqual({ 'receipt.pdf': 'user' });
    expect(files(`${SUPPORT}/scan-kit/${U1}`)).toEqual({ 'page-0.jpg': 'P', 'letter.docx': 'user' });
  });

  test('while a document is left in Documents, nothing is deleted as an orphan in either root', async () => {
    seedOldLayout();
    put(`${SUPPORT}/scan-kit/orphan-new/page-0.jpg`, 'O1');
    put(`${DOCS}/scan-kit/orphan-old/page-0.jpg`, 'O2');
    for (const k of ['scan-kit', 'scan-kit/doc-pdf', 'scan-kit/doc-pdf/document.pdf', 'scan-kit/orphan-old', 'scan-kit/orphan-old/page-0.jpg']) {
      mockFailMoves.add(`${DOCS}/${k}`);
    }
    mockFailCopies.add(`${DOCS}/scan-kit/doc-pdf/document.pdf`);
    mockFailCopies.add(`${DOCS}/scan-kit/orphan-old/page-0.jpg`);
    L.migrateStorageLayout(1000);
    expect(L.storageLayout().state).toBe('split');
    // An interrupted rotate in the document still in Documents is finished there.
    put(`${DOCS}/scan-kit/doc-pdf/page-0.new.jpg`, 'side');

    await realFiles().garbageCollectOrphans(['doc-a', 'doc-pdf', 'doc-trash'], NOW);

    expect(files(`${SUPPORT}/scan-kit/orphan-new`)).toEqual({ 'page-0.jpg': 'O1' });
    expect(files(`${DOCS}/scan-kit/orphan-old`)).toEqual({ 'page-0.jpg': 'O2' });
    expect(files(`${DOCS}/scan-kit/doc-pdf`)).toEqual({ 'document.pdf': '%PDF', 'page-0.jpg': 'side' });
  });

  test('a stored page is never a disposable temp, in either root', () => {
    seedOldLayout();
    L.migrateStorageLayout(1000);
    const files = realFiles();
    expect(files.isDisposableTemp(`${SUPPORT}/scan-kit/doc-a/page-0.jpg`)).toBe(false);
    expect(files.isDisposableTemp(`${SUPPORT}/signatures/sig-00000001.png`)).toBe(false);
    expect(files.isDisposableTemp(`${DOCS}/scan-kit/doc-a/page-0.jpg`)).toBe(false);
    expect(files.isDisposableTemp(`${C1}/Library/Caches/ImagePicker/x.jpg`)).toBe(true);
    expect(files.isDisposableTemp(`${DOCS}/${SCAN}`)).toBe(true);
    expect(files.isDisposableTemp(`${DOCS}/Receipt.pdf`)).toBe(false);
  });

  test('an empty Inbox is removed; the user’s files in Documents never are', () => {
    seedOldLayout();
    L.migrateStorageLayout(1000);
    put(`${DOCS}/My scan.jpg`, 'user');
    put(`${DOCS}/DOCUMENT_SCAN_0_mine.jpg`, 'user-named'); // not the scanner's exact name
    mockFs.delete(`${DOCS}/Inbox/Lease.pdf`);
    realFiles().sweepTempLeftovers(NOW);
    expect(mockFs.has(`${DOCS}/Inbox`)).toBe(false);
    // The scanner's settled leftover went; the user's files stay.
    expect(under(DOCS)).toEqual(['DOCUMENT_SCAN_0_mine.jpg', 'My scan.jpg']);
  });

  test('scanner output is moved out of Documents the moment the scanner returns it', () => {
    seedOldLayout();
    L.migrateStorageLayout(1000);
    put(`${DOCS}/DOCUMENT_SCAN_1_20261118_103000.jpg`, 'page');
    const [moved, other] = realFiles().moveScannerOutputToCaches([
      `${DOCS}/DOCUMENT_SCAN_1_20261118_103000.jpg`,
      `${DOCS}/My scan.jpg`,
    ]);
    expect(moved).toBe(`${C1}/Library/Caches/scanner/DOCUMENT_SCAN_1_20261118_103000.jpg`);
    expect(other).toBe(`${DOCS}/My scan.jpg`); // never anything else
    expect(mockFs.has(`${DOCS}/DOCUMENT_SCAN_1_20261118_103000.jpg`)).toBe(false);
    expect(realFiles().isScannerOutput(moved)).toBe(true); // still known as already cropped
    expect(realFiles().isDisposableTemp(moved)).toBe(true);
  });
});

// ── Round 11 ────────────────────────────────────────────────────────────────

describe('r11 #1: a document folder holding an unrecognised file is never hidden', () => {
  const realFiles = (): typeof import('../lib/files') => jest.requireActual('../lib/files');

  test('first launch: it moves with the rest, every file of it, and opens from Application Support', () => {
    seedOldLayout();
    put(`${DOCS}/scan-kit/${U1}/page-0.jpg`, 'U0');
    put(`${DOCS}/scan-kit/${U1}/page-1.jpg`, 'U1');
    put(`${DOCS}/scan-kit/${U1}/page-1.orig.jpg`, 'U1-orig');
    put(`${DOCS}/scan-kit/${U1}/thumbnail.png`, 'an older build’s side file'); // not in DOC_FOLDER_FILE
    const before = files(`${DOCS}/scan-kit/${U1}`);

    const r = L.migrateStorageLayout(1000);

    expect(r.state).toBe('app-support');
    expect(files(`${SUPPORT}/scan-kit/${U1}`)).toEqual(before);
    expect(L.docDir(U1).uri).toBe(`${SUPPORT}/scan-kit/${U1}/`);
    expect(L.rebaseStoredUri(`${DOCS}/scan-kit/${U1}/page-1.jpg`)).toBe(`${SUPPORT}/scan-kit/${U1}/page-1.jpg`);
    expect(mockFs.has(`${DOCS}/scan-kit`)).toBe(false);
    expect(marker().migratedAt).toBe(1000);
  });

  test('first launch, not named with an id: a folder with pages and an odd file still goes', () => {
    seedOldLayout();
    put(`${DOCS}/scan-kit/doc-a/notes.tmp`, 'odd');
    L.migrateStorageLayout(1000);
    expect(files(`${SUPPORT}/scan-kit/doc-a`)['notes.tmp']).toBe('odd');
    expect(files(`${SUPPORT}/scan-kit/doc-a`)['page-1.jpg']).toBe('A1');
  });

  test('a document folder that stays in Documents keeps being read from there, on every launch', () => {
    // After the move has completed, an id folder with a foreign file in it is
    // not taken — but if a document uses it, its pages must still open.
    seedOldLayout();
    L.migrateStorageLayout(1000);
    put(`${DOCS}/scan-kit/${U2}/page-0.jpg`, 'P0');
    put(`${DOCS}/scan-kit/${U2}/page-1.jpg`, 'P1');
    put(`${DOCS}/scan-kit/${U2}/page-0.jpg.icloud`, 'odd');

    for (const t of [2000, 3000]) {
      const r = relaunch(t);
      expect(r.state).toBe('split');
      expect(L.scanRoots().map(d => d.uri)).toEqual([`${SUPPORT}/scan-kit/`, `${DOCS}/scan-kit/`]);
      expect(L.docDir(U2).uri).toBe(`${DOCS}/scan-kit/${U2}/`);
      expect(L.rebaseStoredUri(`${SUPPORT}/scan-kit/${U2}/page-1.jpg`)).toBe(`${DOCS}/scan-kit/${U2}/page-1.jpg`);
      expect(files(`${DOCS}/scan-kit/${U2}`)).toEqual({ 'page-0.jpg': 'P0', 'page-1.jpg': 'P1', 'page-0.jpg.icloud': 'odd' });
      // The other documents are unaffected.
      expect(L.docDir('doc-a').uri).toBe(`${SUPPORT}/scan-kit/doc-a/`);
    }
  });

  test('a record pointing at it opens every page (the hidden-document path)', async () => {
    seedOldLayout();
    L.migrateStorageLayout(1000);
    put(`${DOCS}/scan-kit/${U2}/page-0.jpg`, 'P0');
    put(`${DOCS}/scan-kit/${U2}/readme.txt`, 'odd');
    relaunch(2000);
    const mod = require('@react-native-async-storage/async-storage');
    const AS = mod.default ?? mod;
    await AS.setItem('@scan_kit_schema_version', '3');
    await AS.setItem('@scan_kit_doc_index', JSON.stringify([U2]));
    await AS.setItem(`@scan_kit_doc:${U2}`, JSON.stringify({
      id: U2, name: 'Kept', createdAt: 1, updatedAt: 1, pages: [`${C0}/Documents/scan-kit/${U2}/page-0.jpg`],
    }));
    const storage: typeof import('../lib/storage') = require('../lib/storage');
    const d = await storage.getDocument(U2);
    expect(d!.pages[0]).toBe(`${DOCS}/scan-kit/${U2}/page-0.jpg`);
    expect(mockFs.get(d!.pages[0])?.type).toBe('file');
    // Nothing in either root is swept while it is there.
    await realFiles().garbageCollectOrphans([U2, 'doc-a', 'doc-pdf', 'doc-trash'], 10 ** 13);
    expect(files(`${DOCS}/scan-kit/${U2}`)).toEqual({ 'page-0.jpg': 'P0', 'readme.txt': 'odd' });
  });
});

describe('r11 #5: a document split across both roots is made one folder before a page edit', () => {
  jest.mock('expo-image-manipulator', () => ({ manipulateAsync: jest.fn(), SaveFormat: { JPEG: 'jpeg' } }));
  const realFiles = (): typeof import('../lib/files') => jest.requireActual('../lib/files');

  /** A crash/failed move left U1's pages 0-1 in Application Support and 2-3 in Documents. */
  function splitDoc() {
    seedOldLayout();
    for (let i = 0; i < 4; i++) {
      put(`${DOCS}/scan-kit/${U1}/page-${i}.jpg`, `P${i}`);
      put(`${DOCS}/scan-kit/${U1}/page-${i}.orig.jpg`, `O${i}`);
    }
    for (const k of ['scan-kit', `scan-kit/${U1}`, `scan-kit/${U1}/page-2.jpg`, `scan-kit/${U1}/page-3.jpg`, `scan-kit/${U1}/page-3.orig.jpg`]) {
      mockFailMoves.add(`${DOCS}/${k}`);
    }
    for (const k of [`scan-kit/${U1}/page-2.jpg`, `scan-kit/${U1}/page-3.jpg`, `scan-kit/${U1}/page-3.orig.jpg`]) mockFailCopies.add(`${DOCS}/${k}`);
    L.migrateStorageLayout(1000);
    expect(L.storageLayout().state).toBe('split');
    expect(Object.keys(files(`${DOCS}/scan-kit/${U1}`)).sort()).toEqual(['page-2.jpg', 'page-3.jpg', 'page-3.orig.jpg']);
    mockFailMoves.clear();
    mockFailCopies.clear();
  }

  test('deleting a page shifts every page and shadow in step, across what was two folders', () => {
    splitDoc();
    realFiles().deleteSinglePage(U1, 1, 4);
    expect(files(`${SUPPORT}/scan-kit/${U1}`)).toEqual({
      'page-0.jpg': 'P0', 'page-0.orig.jpg': 'O0',
      'page-1.jpg': 'P2', 'page-1.orig.jpg': 'O2',
      'page-2.jpg': 'P3', 'page-2.orig.jpg': 'O3',
    });
    expect(mockFs.has(`${DOCS}/scan-kit/${U1}`)).toBe(false);
  });

  test('reordering pages keeps each shadow with its page', () => {
    splitDoc();
    const uris = realFiles().reorderPages(U1, [3, 2, 1, 0]);
    expect(uris[0]).toBe(`${SUPPORT}/scan-kit/${U1}/page-0.jpg`);
    expect(files(`${SUPPORT}/scan-kit/${U1}`)).toEqual({
      'page-0.jpg': 'P3', 'page-0.orig.jpg': 'O3',
      'page-1.jpg': 'P2', 'page-1.orig.jpg': 'O2',
      'page-2.jpg': 'P1', 'page-2.orig.jpg': 'O1',
      'page-3.jpg': 'P0', 'page-3.orig.jpg': 'O0',
    });
  });

  test('a file in both roots is never overwritten: the old one is kept aside', () => {
    splitDoc();
    put(`${DOCS}/scan-kit/${U1}/page-0.jpg`, 'P0-older'); // e.g. a copy whose removal failed
    const dir = L.resolveDocDir(U1);
    expect(dir.uri).toBe(`${SUPPORT}/scan-kit/${U1}/`);
    expect(files(`${SUPPORT}/scan-kit/${U1}`)['page-0.jpg']).toBe('P0');
    expect(Object.values(files(`${SUPPORT}/scan-kit-recovered`))).toEqual(['P0-older']);
  });

  test('when it can’t be made one folder, the edit is refused and nothing moves', () => {
    splitDoc();
    mockFailMoves.add(`${DOCS}/scan-kit/${U1}/page-3.jpg`);
    mockFailCopies.add(`${DOCS}/scan-kit/${U1}/page-3.jpg`);
    expect(() => realFiles().deleteSinglePage(U1, 1, 4)).toThrow(/two folders/);
    expect(files(`${SUPPORT}/scan-kit/${U1}`)['page-1.jpg']).toBe('P1');
    expect(files(`${DOCS}/scan-kit/${U1}`)).toEqual({ 'page-3.jpg': 'P3' });
  });

  test('a user’s file in the old folder stays there', () => {
    splitDoc();
    put(`${DOCS}/scan-kit/${U1}/letter.docx`, 'user');
    L.resolveDocDir(U1);
    expect(files(`${DOCS}/scan-kit/${U1}`)).toEqual({ 'letter.docx': 'user' });
  });

  test('outside the split state it is just the document’s folder', () => {
    seedOldLayout();
    L.migrateStorageLayout(1000);
    expect(L.resolveDocDir('doc-a').uri).toBe(`${SUPPORT}/scan-kit/doc-a/`);
  });
});

describe('r11 #6: what is in Documents is deleted file by file, only the app’s', () => {
  jest.mock('expo-image-manipulator', () => ({ manipulateAsync: jest.fn(), SaveFormat: { JPEG: 'jpeg' } }));
  const realFiles = (): typeof import('../lib/files') => jest.requireActual('../lib/files');

  test('deleting a document still in Documents leaves a file of the user’s, and its folder', () => {
    seedOldLayout();
    L.migrateStorageLayout(1000);
    put(`${DOCS}/scan-kit/${U2}/page-0.jpg`, 'P0');
    put(`${DOCS}/scan-kit/${U2}/page-0.orig.jpg`, 'O0');
    put(`${DOCS}/scan-kit/${U2}/ocr/1-2.json`, '{}');
    put(`${DOCS}/scan-kit/${U2}/my-notes.txt`, 'user');
    relaunch(2000);
    realFiles().deleteDocumentFiles(U2);
    expect(files(`${DOCS}/scan-kit/${U2}`)).toEqual({ 'my-notes.txt': 'user' });
  });

  test('deleting a document removes its folder in both roots', () => {
    seedOldLayout();
    L.migrateStorageLayout(1000);
    put(`${SUPPORT}/scan-kit/${U2}/page-0.jpg`, 'new');
    put(`${DOCS}/scan-kit/${U2}/page-1.jpg`, 'old');
    put(`${DOCS}/scan-kit/${U2}/x.bin`, 'odd');
    relaunch(2000);
    realFiles().deleteDocumentFiles(U2);
    expect(mockFs.has(`${SUPPORT}/scan-kit/${U2}`)).toBe(false);
    expect(files(`${DOCS}/scan-kit/${U2}`)).toEqual({ 'x.bin': 'odd' });
  });

  test('the move failed outright: the sweep deletes no user folder in Documents/scan-kit', async () => {
    seedOldLayout();
    put(`${SUPPORT}/scan-kit`, 'a file in the way'); // Application Support/scan-kit can't be made
    mockFailMoves.add(`${DOCS}/scan-kit`);
    dir(`${DOCS}/scan-kit/Empty folder`);
    put(`${DOCS}/scan-kit/Holiday/page-0.jpg`, 'user photo');
    put(`${DOCS}/scan-kit/${U2}/page-0.jpg`, 'orphan page');
    put(`${DOCS}/scan-kit/${U2}/cv.pdf`, 'user cv');
    put(`${DOCS}/scan-kit/${U1}/page-0.jpg`, 'orphan');
    put(`${DOCS}/scan-kit/${U1}/page-0.orig.jpg`, 'orphan-orig');
    L.migrateStorageLayout(1000);
    expect(L.storageLayout().state).toBe('documents');

    await realFiles().garbageCollectOrphans(['doc-a', 'doc-pdf', 'doc-trash'], 10 ** 13);

    expect(mockFs.get(`${DOCS}/scan-kit/Empty folder`)?.type).toBe('dir');
    expect(files(`${DOCS}/scan-kit/Holiday`)).toEqual({ 'page-0.jpg': 'user photo' });
    expect(files(`${DOCS}/scan-kit/${U2}`)).toEqual({ 'page-0.jpg': 'orphan page', 'cv.pdf': 'user cv' });
    expect(mockFs.has(`${DOCS}/scan-kit/${U1}`)).toBe(false); // only the app's files: a real orphan
    expect(files(`${DOCS}/scan-kit/doc-a`)['page-0.jpg']).toBe('A0');
  });
});

describe('r11 #7: /private/var and /var name the same file', () => {
  const PRIV = (u: string) => u.replace('file:///var/', 'file:///private/var/');

  test('a legacy page a record names through /private/var is in use, never offered', () => {
    seedOldLayout();
    L.migrateStorageLayout(1000);
    const page = `${SUPPORT}/legacy-documents/documents/${M}/page_0.jpg`;
    expect(L.listRecoveredGroups(new Set([PRIV(page)]))).toEqual([]);
    expect(L.listRecoveredGroups(new Set([decodeURIComponent(page)]))).toEqual([]);
  });

  test('a group listed through /private/var can be deleted, and nothing outside the folders can', () => {
    seedOldLayout();
    L.migrateStorageLayout(1000);
    const [g] = L.listRecoveredGroups(new Set());
    expect(L.deleteRecoveredGroup({ ...g, dir: '', files: g.files.map(PRIV) })).toBe(true);
    expect(mockFs.has(`${SUPPORT}/legacy-documents`)).toBe(false);
    const escape = `${SUPPORT}/legacy-documents/../scan-kit/doc-a/page-0.jpg`;
    expect(L.deleteRecoveredGroup({ key: 'x', dir: '', kind: 'pages', savedAt: null, files: [PRIV(escape)], bytes: 1 })).toBe(false);
    expect(files(`${SUPPORT}/scan-kit/doc-a`)['page-0.jpg']).toBe('A0');
  });

  test('sameFileKey', () => {
    expect(L.sameFileKey('file:///private/var/mobile/a%20b.jpg?v=2')).toBe('file:///var/mobile/a b.jpg');
    expect(L.sameFileKey('file:///var/mobile/a b.jpg')).toBe('file:///var/mobile/a b.jpg');
  });
});

describe('r11 #2: scanner pages named in a locale’s own digits', () => {
  const realFiles = (): typeof import('../lib/files') => jest.requireActual('../lib/files');
  const AR = 'DOCUMENT_SCAN_0_٢٠٢٦١١١٨_١٠٣٠٠٠.jpg'; // Arabic-Indic
  const FA = 'DOCUMENT_SCAN_1_۲۰۲۶۱۱۱۸_۱۰۳۰۰۰.jpg'; // Persian
  const enc = (n: string) => n.split('').map(c => (/[\w.]/.test(c) ? c : encodeURIComponent(c))).join('');

  test('are moved out of Documents, escaped or not', () => {
    seedOldLayout();
    L.migrateStorageLayout(1000);
    put(`${DOCS}/${AR}`, 'ar');
    put(`${DOCS}/${FA}`, 'fa');
    // As the scanner hands them over: escaped, and through /private/var.
    const [a, f] = realFiles().moveScannerOutputToCaches([`${DOCS}/${enc(AR)}`, `${DOCS.replace('file:///var/', 'file:///private/var/')}/${FA}`]);
    expect(mockFs.has(`${DOCS}/${AR}`)).toBe(false);
    expect(mockFs.has(`${DOCS}/${FA}`)).toBe(false);
    expect(decodeURIComponent(a)).toBe(`${C1}/Library/Caches/scanner/${AR}`);
    expect(decodeURIComponent(f)).toBe(`${C1}/Library/Caches/scanner/${FA}`);
    expect(realFiles().isScannerOutput(a)).toBe(true);
  });

  test('are swept from Documents when left behind; look-alike user files never are', () => {
    seedOldLayout();
    L.migrateStorageLayout(1000);
    mockFs.delete(`${DOCS}/Inbox/Lease.pdf`);
    put(`${DOCS}/${enc(AR)}`, 'ar');
    put(`${DOCS}/${enc('DOCUMENT_SCAN_0_٢٠٢٦_mine.jpg')}`, 'user');
    put(`${DOCS}/DOCUMENT_SCAN_0_mine.jpg`, 'user');
    realFiles().sweepTempLeftovers(10 ** 13);
    expect(under(DOCS).map(decodeURIComponent).sort()).toEqual(['DOCUMENT_SCAN_0_mine.jpg', 'DOCUMENT_SCAN_0_٢٠٢٦_mine.jpg'].sort());
  });

  test('isDisposableTemp knows them, with or without direction marks', () => {
    seedOldLayout();
    L.migrateStorageLayout(1000);
    const F = realFiles();
    expect(F.isDisposableTemp(`${DOCS}/${enc(AR)}`)).toBe(true);
    expect(F.isDisposableTemp(`${DOCS}/${FA}`)).toBe(true);
    expect(F.isDisposableTemp(`${DOCS}/DOCUMENT_SCAN_0_‏٢٠٢٦١١١٨_‏١٠٣٠٠٠.jpg`)).toBe(true);
    expect(F.isDisposableTemp(`${DOCS}/DOCUMENT_SCAN_0_20261118_103000.jpg`)).toBe(true);
    expect(F.isDisposableTemp(`${DOCS}/DOCUMENT_SCAN_0_٢٠٢٦١١١٨.jpg`)).toBe(false);
    expect(F.isDisposableTemp(`${DOCS}/Scan ٢٠٢٦١١١٨_١٠٣٠٠٠.jpg`)).toBe(false);
  });
});
