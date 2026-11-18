// Streaming ZIP writer (r7 #1): Export all must never hold the library in memory.
import JSZip from 'jszip';

// In-memory file system. Sources can be "synthetic": a size and a byte pattern,
// generated on read, so a library of hundreds of MB costs no test memory.
type Synthetic = { size: number; seed: number };
const mockFiles = new Map<string, Uint8Array>();
const mockSynthetic = new Map<string, Synthetic>();
const mockStats = { maxRead: 0, maxWrite: 0, wholeReads: 0, sinkBytes: 0 };
/** When set, writes to this URI are counted (and only small ones kept), not stored. */
let mockSinkUri: string | null = null;
const mockSinkSmall = new Map<number, Uint8Array>();

function mockByteAt(seed: number, pos: number): number {
  return (pos * 31 + seed * 7 + (pos >> 9)) & 0xff;
}

jest.mock('expo-file-system', () => {
  class Handle {
    offset = 0;
    mockFile: { uri: string };
    constructor(f: { uri: string }) { this.mockFile = f; }
    get size() { return mockFiles.get(this.mockFile.uri)?.length ?? mockSynthetic.get(this.mockFile.uri)?.size ?? 0; }
    readBytes(n: number): Uint8Array {
      mockStats.maxRead = Math.max(mockStats.maxRead, n);
      const syn = mockSynthetic.get(this.mockFile.uri);
      if (syn) {
        const len = Math.max(0, Math.min(n, syn.size - this.offset));
        const out = new Uint8Array(len);
        for (let i = 0; i < len; i++) out[i] = mockByteAt(syn.seed, this.offset + i);
        this.offset += len;
        return out;
      }
      const data = mockFiles.get(this.mockFile.uri)!;
      const out = data.slice(this.offset, this.offset + n);
      this.offset += out.length;
      return out;
    }
    writeBytes(bytes: Uint8Array) {
      mockStats.maxWrite = Math.max(mockStats.maxWrite, bytes.length);
      if (this.mockFile.uri === mockSinkUri) {
        if (bytes.length <= 256) mockSinkSmall.set(this.offset, bytes.slice());
        mockStats.sinkBytes = Math.max(mockStats.sinkBytes, this.offset + bytes.length);
        this.offset += bytes.length;
        return;
      }
      const cur = mockFiles.get(this.mockFile.uri) ?? new Uint8Array(0);
      const end = Math.max(cur.length, this.offset + bytes.length);
      const next = new Uint8Array(end);
      next.set(cur);
      next.set(bytes, this.offset);
      mockFiles.set(this.mockFile.uri, next);
      this.offset += bytes.length;
    }
    close() {}
  }
  class MockFile {
    uri: string;
    constructor(uri: string) { this.uri = uri; }
    get exists() { return mockFiles.has(this.uri) || mockSynthetic.has(this.uri) || this.uri === mockSinkUri; }
    get size() { return mockFiles.get(this.uri)?.length ?? mockSynthetic.get(this.uri)?.size ?? 0; }
    create() { if (this.uri !== mockSinkUri) mockFiles.set(this.uri, new Uint8Array(0)); }
    open() { return new Handle(this); }
    bytes() { mockStats.wholeReads++; throw new Error('whole-file read'); }
    delete() { mockFiles.delete(this.uri); mockSynthetic.delete(this.uri); }
  }
  return { File: MockFile };
});

import { crc32, dosDateTime, zipFiles, ZipCancelledError, ZipFileWriter } from '../lib/zip-stream';

beforeEach(() => {
  mockFiles.clear();
  mockSynthetic.clear();
  mockSinkSmall.clear();
  mockSinkUri = null;
  Object.assign(mockStats, { maxRead: 0, maxWrite: 0, wholeReads: 0, sinkBytes: 0 });
});

const bytesOf = (s: string) => new TextEncoder().encode(s);
function pattern(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = mockByteAt(seed, i);
  return out;
}

test('crc32 matches the standard check value', () => {
  expect(crc32(bytesOf('123456789'))).toBe(0xcbf43926);
  // Chunked = whole.
  const data = pattern(10_000, 3);
  expect(crc32(data.subarray(4000), crc32(data.subarray(0, 4000)))).toBe(crc32(data));
  expect(crc32(new Uint8Array(0))).toBe(0);
});

test('dosDateTime packs local date and time', () => {
  const { date, time } = dosDateTime(new Date(2026, 10, 18, 14, 30, 59));
  expect(date).toBe(((2026 - 1980) << 9) | (11 << 5) | 18);
  expect(time).toBe((14 << 11) | (30 << 5) | 29);
});

test('writes a valid archive JSZip reads back byte for byte (CRCs checked)', async () => {
  const docs = Array.from({ length: 12 }, (_, i) => pattern(50_000 + i * 3_333, i));
  docs.forEach((d, i) => mockFiles.set(`file:///docs/${i}/document.pdf`, d));
  const uri = await zipFiles(
    'file:///cache/out.zip',
    docs.map((_, i) => ({
      name: i === 3 ? 'Résumé “quotes”.pdf' : `Doc ${i}.pdf`,
      date: new Date(2026, 0, 2, 3, 4, 6),
      produce: async () => ({ uri: `file:///docs/${i}/document.pdf`, temporary: false }),
    })),
    { chunkBytes: 16_384 },
  );
  expect(uri).toBe('file:///cache/out.zip');
  const zip = await JSZip.loadAsync(mockFiles.get(uri)!, { checkCRC32: true });
  const names = Object.keys(zip.files);
  expect(names).toHaveLength(12);
  expect(names).toContain('Résumé “quotes”.pdf');
  for (let i = 0; i < 12; i++) {
    const name = i === 3 ? 'Résumé “quotes”.pdf' : `Doc ${i}.pdf`;
    const back = await zip.file(name)!.async('uint8array');
    expect(back.length).toBe(docs[i].length);
    expect(Buffer.from(back).equals(Buffer.from(docs[i]))).toBe(true);
    expect(zip.files[name].date.getFullYear()).toBe(2026);
  }
  // Streamed: never more than one chunk read or written at a time, never a whole-file read.
  expect(mockStats.maxRead).toBeLessThanOrEqual(16_384);
  expect(mockStats.maxWrite).toBeLessThanOrEqual(16_384);
  expect(mockStats.wholeReads).toBe(0);
  // Sources the caller keeps are kept.
  expect(mockFiles.has('file:///docs/0/document.pdf')).toBe(true);
});

test('temporary PDFs are deleted as soon as they are in the archive, one at a time', async () => {
  const alive: number[] = [];
  const items = Array.from({ length: 5 }, (_, i) => ({
    name: `T${i}.pdf`,
    produce: async () => {
      const u = `file:///cache/Print/t${i}.pdf`;
      mockFiles.set(u, pattern(20_000, i));
      alive.push([...mockFiles.keys()].filter(k => k.includes('/Print/')).length);
      return { uri: u, temporary: true };
    },
  }));
  await zipFiles('file:///cache/t.zip', items, { chunkBytes: 4096 });
  expect(alive).toEqual([1, 1, 1, 1, 1]);
  expect([...mockFiles.keys()].filter(k => k.includes('/Print/'))).toEqual([]);
  const zip = await JSZip.loadAsync(mockFiles.get('file:///cache/t.zip')!, { checkCRC32: true });
  expect(Object.keys(zip.files)).toEqual(['T0.pdf', 'T1.pdf', 'T2.pdf', 'T3.pdf', 'T4.pdf']);
});

test('a synthetic 640 MB library of 32 documents streams with one 1 MB chunk at a time', async () => {
  mockSinkUri = 'file:///cache/big.zip';
  const sizes = Array.from({ length: 32 }, (_, i) => 20 * 1024 * 1024 + i * 1234);
  sizes.forEach((size, i) => mockSynthetic.set(`file:///docs/${i}.pdf`, { size, seed: i }));
  const seen: number[] = [];
  await zipFiles(
    mockSinkUri,
    sizes.map((_, i) => ({ name: `D${i}.pdf`, produce: async () => ({ uri: `file:///docs/${i}.pdf`, temporary: false }) })),
    { onItem: i => seen.push(i) },
  );
  expect(seen).toEqual(sizes.map((_, i) => i));
  expect(mockStats.maxRead).toBeLessThanOrEqual(1024 * 1024);
  expect(mockStats.maxWrite).toBeLessThanOrEqual(1024 * 1024);
  expect(mockStats.wholeReads).toBe(0);
  // Total = data + 32 local headers + 32 central headers + end record.
  const names = sizes.map((_, i) => `D${i}.pdf`.length);
  const expected = sizes.reduce((a, b) => a + b, 0) + names.reduce((a, n) => a + 30 + n + 46 + n, 0) + 22;
  expect(mockStats.sinkBytes).toBe(expected);
  // The end-of-central-directory record names all 32 entries.
  const eocd = mockSinkSmall.get(expected - 22)!;
  const v = new DataView(eocd.buffer, eocd.byteOffset);
  expect(v.getUint32(0, true)).toBe(0x06054b50);
  expect(v.getUint16(10, true)).toBe(32);
  // The first entry's patched CRC equals the CRC of its bytes.
  const patch = mockSinkSmall.get(14)!;
  let want = 0;
  for (let pos = 0; pos < sizes[0]; pos += 1 << 20) {
    const len = Math.min(1 << 20, sizes[0] - pos);
    const chunk = new Uint8Array(len);
    for (let k = 0; k < len; k++) chunk[k] = mockByteAt(0, pos + k);
    want = crc32(chunk, want);
  }
  const pv = new DataView(patch.buffer, patch.byteOffset);
  expect(patch.length).toBe(12);
  expect(pv.getUint32(0, true)).toBe(want);
  expect(pv.getUint32(4, true)).toBe(sizes[0]);
}, 120_000);

test('cancelling deletes the partial archive and the PDF in flight', async () => {
  const c = new AbortController();
  const items = Array.from({ length: 4 }, (_, i) => ({
    name: `C${i}.pdf`,
    produce: async () => {
      const u = `file:///cache/Print/c${i}.pdf`;
      mockFiles.set(u, pattern(40_000, i));
      if (i === 1) c.abort();
      return { uri: u, temporary: true };
    },
  }));
  await expect(zipFiles('file:///cache/c.zip', items, { signal: c.signal, chunkBytes: 4096 })).rejects.toBeInstanceOf(
    ZipCancelledError,
  );
  expect(mockFiles.has('file:///cache/c.zip')).toBe(false);
  expect([...mockFiles.keys()].filter(k => k.includes('/Print/'))).toEqual([]);
});

test('a failure while producing an item deletes the partial archive', async () => {
  mockFiles.set('file:///a.pdf', pattern(1000, 1));
  const items = [
    { name: 'A.pdf', produce: async () => ({ uri: 'file:///a.pdf', temporary: false }) },
    { name: 'B.pdf', produce: async () => { throw new Error('render failed'); } },
  ];
  await expect(zipFiles('file:///cache/f.zip', items)).rejects.toThrow('render failed');
  expect(mockFiles.has('file:///cache/f.zip')).toBe(false);
  expect(mockFiles.has('file:///a.pdf')).toBe(true);
});

test('duplicate names are refused rather than silently shadowed', async () => {
  mockFiles.set('file:///a.pdf', pattern(10, 1));
  const w = new ZipFileWriter('file:///cache/d.zip');
  await w.addFile('Same.pdf', 'file:///a.pdf');
  await expect(w.addFile('same.PDF', 'file:///a.pdf')).rejects.toThrow(/Duplicate/);
  w.abort();
  expect(mockFiles.has('file:///cache/d.zip')).toBe(false);
});
