// __tests__/files-copy.test.ts
//
// "Keep a copy in Files" (lib/files-copy.ts) against an in-memory file system
// with iOS semantics (File.move refuses an existing destination, a rename
// keeps the modification date, copyItem keeps it too). The rule under test:
// Documents is the user's folder — the feature replaces or removes only a
// file it wrote AND that is still exactly what it wrote; a deleted document's
// PDF never outlives a failed or cancelled pass.

type Node = { type: 'dir' } | { type: 'file'; content: string; mtime: number };
const mockFs = new Map<string, Node>();
const mockClock = { t: 1000 };
const mockFailMoveTo = new Set<string>();

jest.mock('expo-file-system', () => {
  const strip = (u: string) => u.replace(/\/+$/, '');
  const enc = (seg: string) => seg.split('/').map(s => s.replace(/ /g, '%20')).join('/');
  const join = (parts: any[]) => {
    const [first, ...rest] = parts;
    const base = strip(typeof first === 'string' ? first : first.uri);
    return [base, ...rest.map(p => enc(strip(String(p))))].join('/');
  };
  const parentOf = (key: string) => key.slice(0, key.lastIndexOf('/'));
  const nameOf = (key: string) => decodeURIComponent(key.slice(key.lastIndexOf('/') + 1));
  class MockDirectory {
    key: string;
    constructor(...parts: any[]) { this.key = strip(join(parts)); }
    get uri() { return `${this.key}/`; }
    get name() { return nameOf(this.key); }
    get exists() { return mockFs.get(this.key)?.type === 'dir'; }
    create() {
      let k = this.key;
      const missing: string[] = [];
      while (!mockFs.has(k) && k.includes('/') && k !== 'file://') { missing.push(k); k = parentOf(k); }
      for (const m of missing) mockFs.set(m, { type: 'dir' });
    }
    list() {
      const out: any[] = [];
      for (const [k, v] of mockFs) if (parentOf(k) === this.key) out.push(v.type === 'dir' ? new MockDirectory(k) : new MockFile(k));
      return out;
    }
    delete() { for (const k of [...mockFs.keys()]) if (k === this.key || k.startsWith(`${this.key}/`)) mockFs.delete(k); }
  }
  class MockFile {
    key: string;
    constructor(...parts: any[]) { this.key = strip(join(parts)); }
    get uri() { return this.key; }
    get name() { return nameOf(this.key); }
    get exists() { return mockFs.get(this.key)?.type === 'file'; }
    get size() { const n = mockFs.get(this.key); return n?.type === 'file' ? n.content.length : 0; }
    get md5() { const n = mockFs.get(this.key); return n?.type === 'file' ? `md5:${n.content}` : null; }
    info() { const n = mockFs.get(this.key); return n?.type === 'file' ? { exists: true, size: n.content.length, modificationTime: n.mtime } : { exists: false }; }
    textSync() { const n = mockFs.get(this.key); if (n?.type !== 'file') throw new Error('ENOENT'); return n.content; }
    create() { mockFs.set(this.key, { type: 'file', content: '', mtime: ++mockClock.t }); }
    write(content: string) { mockFs.set(this.key, { type: 'file', content, mtime: ++mockClock.t }); }
    delete() { if (!this.exists) throw new Error('ENOENT'); mockFs.delete(this.key); }
    copy(dest: any) {
      const n = mockFs.get(this.key);
      if (n?.type !== 'file') throw new Error('ENOENT');
      if (mockFs.has(dest.key)) throw new Error('EEXIST');
      mockFs.set(dest.key, { ...n });
    }
    move(dest: any) {
      const n = mockFs.get(this.key);
      if (n?.type !== 'file') throw new Error('ENOENT');
      if (mockFs.has(dest.key)) throw new Error('EEXIST');
      if (mockFailMoveTo.has(dest.key)) throw new Error('killed');
      mockFs.delete(this.key);
      mockFs.set(dest.key, n);
      this.key = dest.key;
    }
  }
  return {
    File: MockFile,
    Directory: MockDirectory,
    Paths: {
      get document() { return new MockDirectory('file:///C/Documents'); },
      get cache() { return new MockDirectory('file:///C/Library/Caches'); },
    },
  };
});
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

type Doc = { id: string; name: string; createdAt: number; updatedAt: number; pages: string[] };
let mockDocs: Doc[] = [];
jest.mock('../lib/storage', () => ({
  getDocuments: async () => mockDocs.map(d => ({ ...d })),
  getDocSettings: async () => ({ pdfPageSize: 'A4' }),
}));
const mockPdf: { gate: Promise<void> | null; fail: boolean } = { gate: null, fail: false };
jest.mock('../lib/pdf', () => ({
  generatePdf: async (pages: string[]) => {
    if (mockPdf.gate) await mockPdf.gate;
    if (mockPdf.fail) throw new Error('no space');
    const { File } = require('expo-file-system');
    const f = new File(`file:///C/Library/Caches/out-${Math.random()}.pdf`);
    f.write(`PDF(${pages.join(',')})`);
    return f.uri;
  },
}));
jest.mock('../lib/ocr', () => ({ ocrAvailable: () => false }));
jest.mock('../lib/share', () => ({ exportFileName: (n: string, ext: string) => `${n}.${ext}` }));

const DOCS = 'file:///C/Documents';
const SUPPORT = 'file:///C/Library/Application%20Support';
type FC = typeof import('../lib/files-copy');
let FC: FC;

function put(key: string, content: string) {
  const parts = key.split('/');
  for (let i = 3; i < parts.length; i++) {
    const k = parts.slice(0, i).join('/');
    if (!mockFs.has(k)) mockFs.set(k, { type: 'dir' });
  }
  mockFs.set(key, { type: 'file', content, mtime: ++mockClock.t });
}
const inDocs = () => {
  const out: Record<string, string> = {};
  for (const [k, v] of mockFs) if (v.type === 'file' && k.startsWith(`${DOCS}/`)) out[decodeURIComponent(k.slice(DOCS.length + 1))] = v.content;
  return out;
};
const manifest = () => JSON.parse((mockFs.get(`${SUPPORT}/files-copy.json`) as any).content);
const doc = (id: string, name: string, createdAt: number, updatedAt = createdAt): Doc => ({ id, name, createdAt, updatedAt, pages: [`p-${id}-${updatedAt}`] });

beforeEach(async () => {
  jest.resetModules();
  mockFs.clear();
  mockFailMoveTo.clear();
  mockPdf.gate = null;
  mockPdf.fail = false;
  mockDocs = [];
  for (const d of ['file:///C', DOCS, 'file:///C/Library', 'file:///C/Library/Caches', SUPPORT]) mockFs.set(d, { type: 'dir' });
  const AS = require('@react-native-async-storage/async-storage');
  await AS.clear();
  FC = require('../lib/files-copy');
  await FC.setFilesCopyEnabled(true);
});

// Each test's module instance is stopped and drained, so a pass it left
// scheduled can't run into the next test's (shared) file system.
afterEach(async () => {
  await FC.setFilesCopyEnabled(false);
  await new Promise(r => setTimeout(r, 5));
  await FC.runSync();
});

const pass = () => FC.runSync();

test('a copy per document, and nothing else; a second pass changes nothing', async () => {
  mockDocs = [doc('a', 'Lease', 1), doc('b', 'Receipt', 2)];
  await pass();
  expect(inDocs()).toEqual({ 'Lease.pdf': 'PDF(p-a-1)', 'Receipt.pdf': 'PDF(p-b-2)' });
  const snapshot = new Map(mockFs);
  await pass();
  expect(new Map(mockFs)).toEqual(snapshot);
  // Made in Caches and renamed in: nothing temporary ever sits in Documents.
  expect(Object.keys(inDocs()).some(n => n.startsWith('.'))).toBe(false);
});

test('a document’s edit rewrites its copy; deleting the document removes it', async () => {
  mockDocs = [doc('a', 'Lease', 1)];
  await pass();
  mockDocs = [doc('a', 'Lease', 1, 9)];
  await pass();
  expect(inDocs()).toEqual({ 'Lease.pdf': 'PDF(p-a-9)' });
  mockDocs = [];
  await pass();
  expect(inDocs()).toEqual({});
  expect(manifest()).toEqual({});
});

test('a copy the user edited in Files (Markup) is never overwritten or deleted', async () => {
  mockDocs = [doc('a', 'Lease', 1)];
  await pass();
  put(`${DOCS}/Lease.pdf`, 'PDF(p-a-1)+user-ink'); // saved in place by Markup
  mockDocs = [doc('a', 'Lease', 1, 9)];
  await pass();
  expect(inDocs()).toEqual({ 'Lease.pdf': 'PDF(p-a-1)+user-ink', 'Lease 2.pdf': 'PDF(p-a-9)' });
  // Deleting the document removes only the copy that is still ours.
  mockDocs = [];
  await pass();
  expect(inDocs()).toEqual({ 'Lease.pdf': 'PDF(p-a-1)+user-ink' });
});

test('an edit that keeps the size is still caught (modification date, then MD5)', async () => {
  mockDocs = [doc('a', 'Lease', 1)];
  await pass();
  put(`${DOCS}/Lease.pdf`, 'PDF(p-a-X)'); // same length, different bytes
  mockDocs = [];
  await pass();
  expect(inDocs()).toEqual({ 'Lease.pdf': 'PDF(p-a-X)' });
});

test('a copy whose date changed but whose bytes didn’t (a restore from backup) is still recognised', async () => {
  mockDocs = [doc('a', 'Lease', 1)];
  await pass();
  put(`${DOCS}/Lease.pdf`, 'PDF(p-a-1)'); // same bytes, new date
  mockDocs = [];
  await pass();
  expect(inDocs()).toEqual({});
});

test('the user’s own file with a copy’s name is never replaced: the copy takes a free name', async () => {
  put(`${DOCS}/Lease.pdf`, 'the user’s lease');
  mockDocs = [doc('a', 'Lease', 1)];
  await pass();
  expect(inDocs()).toEqual({ 'Lease.pdf': 'the user’s lease', 'Lease 2.pdf': 'PDF(p-a-1)' });
});

test('a renumbering whose write fails never leaves a deleted document’s PDF behind', async () => {
  mockDocs = [doc('a', 'Receipt', 1), doc('b', 'Receipt', 2)];
  await pass();
  expect(inDocs()).toEqual({ 'Receipt.pdf': 'PDF(p-a-1)', 'Receipt 2.pdf': 'PDF(p-b-2)' });
  mockDocs = [doc('b', 'Receipt', 2)]; // a deleted: b wants "Receipt.pdf" now
  mockPdf.fail = true;
  await pass();
  expect(Object.values(inDocs())).not.toContain('PDF(p-a-1)');
  mockPdf.fail = false;
  await pass();
  expect(inDocs()).toEqual({ 'Receipt.pdf': 'PDF(p-b-2)' });
});

test('turned off mid-pass: the deleted document’s copy is already gone, and nothing new appears', async () => {
  mockDocs = [doc('a', 'Old', 1), doc('b', 'Lease', 2)];
  await pass();
  let open!: () => void;
  mockPdf.gate = new Promise<void>(r => { open = r; });
  mockDocs = [doc('b', 'Lease', 2, 9)]; // a deleted, b edited
  const running = pass();
  await new Promise(r => setTimeout(r, 0));
  await FC.setFilesCopyEnabled(false);
  open();
  await running;
  expect(inDocs()).toEqual({ 'Lease.pdf': 'PDF(p-b-2)' });
  // The copy that is left is still known, so "Remove copies" can remove it.
  expect(await FC.removeFilesCopies()).toBe(1);
  expect(inDocs()).toEqual({});
});

test('killed between recording a copy and renaming it in: the next pass settles it', async () => {
  mockDocs = [doc('a', 'Lease', 1)];
  mockFailMoveTo.add(`${DOCS}/Lease.pdf`);
  await pass();
  expect(inDocs()).toEqual({});
  expect(manifest().a.next).toBeDefined(); // the write-ahead record
  mockFailMoveTo.clear();
  await pass();
  expect(inDocs()).toEqual({ 'Lease.pdf': 'PDF(p-a-1)' });
});

test('killed after the rename, before the record was finished: the file is still recognised as ours', async () => {
  mockDocs = [doc('a', 'Lease', 1)];
  await pass();
  const m = manifest();
  // What the manifest says if the app dies right after the rename.
  m.a = { name: 'Lease.pdf', stamp: -1, fp: null, next: { stamp: 1, fp: m.a.fp } };
  put(`${SUPPORT}/files-copy.json`, JSON.stringify(m));
  mockFs.set(`${DOCS}/Lease.pdf`, { ...(mockFs.get(`${DOCS}/Lease.pdf`) as any), mtime: m.a.next.fp.mtime });
  mockDocs = [doc('a', 'Lease', 1, 9)];
  await pass();
  expect(inDocs()).toEqual({ 'Lease.pdf': 'PDF(p-a-9)' }); // replaced in place, not "Lease 2.pdf"
});

test('Remove copies removes only what is still ours', async () => {
  mockDocs = [doc('a', 'Lease', 1), doc('b', 'Receipt', 2)];
  await pass();
  put(`${DOCS}/Receipt.pdf`, 'PDF(p-b-2)+notes');
  put(`${DOCS}/Taxes.pdf`, 'user');
  await FC.setFilesCopyEnabled(false);
  expect(await FC.removeFilesCopies()).toBe(1);
  expect(inDocs()).toEqual({ 'Receipt.pdf': 'PDF(p-b-2)+notes', 'Taxes.pdf': 'user' });
});

test('an older build’s manifest (AsyncStorage) is taken over once', async () => {
  mockFs.delete(`${SUPPORT}/files-copy.json`);
  put(`${DOCS}/Lease.pdf`, 'old copy');
  const AS = require('@react-native-async-storage/async-storage');
  await AS.setItem('@scan_kit_files_copy_manifest', JSON.stringify({ a: { name: 'Lease.pdf', stamp: 1 } }));
  mockDocs = [doc('a', 'Lease', 1, 5)];
  await pass();
  expect(inDocs()).toEqual({ 'Lease.pdf': 'PDF(p-a-5)' });
  expect(await AS.getItem('@scan_kit_files_copy_manifest')).toBeNull();
});

test('an unreadable manifest: nothing in the folder is touched', async () => {
  put(`${DOCS}/Lease.pdf`, 'whatever');
  put(`${SUPPORT}/files-copy.json`, '{"a":{"na');
  mockDocs = [];
  await pass();
  expect(inDocs()).toEqual({ 'Lease.pdf': 'whatever' });
});

test('offered on iOS whatever state the move out of Documents is in', () => {
  expect(FC.filesCopyAvailable()).toBe(true);
});
