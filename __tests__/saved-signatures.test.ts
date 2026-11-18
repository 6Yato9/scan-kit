const mockFs = new Map<string, string>();
jest.mock('expo-file-system', () => {
  const part = (p: any) => (p && typeof p === 'object' ? p.uri : p);
  class MockFile {
    uri: string;
    constructor(dir: any, name?: string) { this.uri = name ? `${part(dir)}/${name}` : String(part(dir)); }
    get exists() { return mockFs.has(this.uri); }
    create() { mockFs.set(this.uri, ''); }
    write(content: string, opts?: { encoding?: string }) { mockFs.set(this.uri, opts?.encoding === 'base64' ? `b64:${content}` : content); }
    textSync() { return mockFs.get(this.uri) ?? ''; }
    async base64() { return (mockFs.get(this.uri) ?? '').replace(/^b64:/, ''); }
    delete() { mockFs.delete(this.uri); }
    get size() { return (mockFs.get(this.uri) ?? '').length; }
    move(dest: MockFile) {
      if (mockFs.has(dest.uri)) throw new Error('destination exists');
      mockFs.set(dest.uri, mockFs.get(this.uri)!);
      mockFs.delete(this.uri);
      this.uri = dest.uri;
    }
  }
  class MockDirectory {
    uri: string;
    constructor(...parts: any[]) { this.uri = parts.map(part).join('/'); }
    create() {}
  }
  return { File: MockFile, Directory: MockDirectory, Paths: { document: { uri: 'file:///docs' } } };
});

import {
  addToIndex,
  forgetSignature,
  listSavedSignatures,
  loadSavedSignature,
  parseIndex,
  rememberSignature,
  signatureId,
} from '../lib/saved-signatures';

const sig = (body: string, w = 300, h = 100) => ({ dataUri: `data:image/png;base64,${body}`, width: w, height: h });
const entry = (id: string, savedAt = 1) => ({ id, width: 10, height: 5, savedAt });

beforeEach(() => mockFs.clear());

describe('addToIndex', () => {
  test('newest first, capped at two, returns what fell off', () => {
    const { index, dropped } = addToIndex([entry('sig-00000002'), entry('sig-00000001')], entry('sig-00000003'));
    expect(index.map(e => e.id)).toEqual(['sig-00000003', 'sig-00000002']);
    expect(dropped.map(e => e.id)).toEqual(['sig-00000001']);
  });

  test('re-saving a stored signature moves it up instead of duplicating it', () => {
    const { index, dropped } = addToIndex([entry('sig-00000002'), entry('sig-00000001')], entry('sig-00000001', 9));
    expect(index.map(e => e.id)).toEqual(['sig-00000001', 'sig-00000002']);
    expect(index[0].savedAt).toBe(9);
    expect(dropped).toEqual([]);
  });
});

test('signatureId is stable and differs for different signatures', () => {
  expect(signatureId('data:a')).toBe(signatureId('data:a'));
  expect(signatureId('data:a')).not.toBe(signatureId('data:b'));
  expect(signatureId('data:a')).toMatch(/^sig-[0-9a-f]{8}$/);
});

test('parseIndex ignores garbage', () => {
  expect(parseIndex('not json')).toEqual([]);
  expect(parseIndex('{"a":1}')).toEqual([]);
  expect(parseIndex(JSON.stringify([entry('sig-0000000a'), { id: '../evil', width: 1, height: 1, savedAt: 1 }]))).toEqual([
    entry('sig-0000000a'),
  ]);
});

test('remembers up to two signatures and deletes the oldest file', async () => {
  await rememberSignature(sig('AAA'), 1);
  await rememberSignature(sig('BBB'), 2);
  await rememberSignature(sig('CCC'), 3);
  const saved = await listSavedSignatures();
  expect(saved.map(s => s.savedAt)).toEqual([3, 2]);
  const pngs = [...mockFs.keys()].filter(k => k.endsWith('.png'));
  expect(pngs).toHaveLength(2);
  expect(pngs.some(k => k.includes(signatureId(sig('AAA').dataUri)))).toBe(false);
});

test('a saved signature loads back as the same PNG data URI', async () => {
  await rememberSignature(sig('QUJD', 320, 90));
  const [saved] = await listSavedSignatures();
  expect(await loadSavedSignature(saved)).toEqual(sig('QUJD', 320, 90));
});

test('ignores anything that is not a PNG signature', async () => {
  await rememberSignature({ dataUri: 'data:image/jpeg;base64,xx', width: 1, height: 1 });
  await rememberSignature(sig('AAA', 0, 10));
  expect(await listSavedSignatures()).toEqual([]);
});

test('forget removes the entry and its file', async () => {
  await rememberSignature(sig('AAA'));
  const [saved] = await listSavedSignatures();
  await forgetSignature(saved.id);
  expect(await listSavedSignatures()).toEqual([]);
  expect([...mockFs.keys()].some(k => k.endsWith('.png'))).toBe(false);
});

describe('a failed PNG write (L1)', () => {
  const realSet = Map.prototype.set;
  afterEach(() => { mockFs.set = realSet; });

  test('leaves no empty PNG behind, and the next save writes it', async () => {
    // The base64 write fails (disk full): every write of base64 content throws.
    mockFs.set = function (this: Map<string, string>, k: string, v: string) {
      if (v.startsWith('b64:')) throw new Error('disk full');
      return realSet.call(this, k, v);
    } as typeof mockFs.set;
    await rememberSignature(sig('AAA'));
    expect([...mockFs.keys()].some(k => k.includes('.png'))).toBe(false);
    expect(await listSavedSignatures()).toEqual([]);

    mockFs.set = realSet;
    await rememberSignature(sig('AAA'));
    const [saved] = await listSavedSignatures();
    expect(await loadSavedSignature(saved)).toEqual(sig('AAA'));
  });

  test('an empty PNG left by an older version is rewritten', async () => {
    const id = signatureId(sig('AAA').dataUri);
    mockFs.set(`file:///docs/signatures/${id}.png`, '');
    mockFs.set('file:///docs/signatures/index.json', JSON.stringify([{ id, width: 300, height: 100, savedAt: 1 }]));
    expect(await listSavedSignatures()).toEqual([]);
    await rememberSignature(sig('AAA'), 2);
    const [saved] = await listSavedSignatures();
    expect(await loadSavedSignature(saved)).toEqual(sig('AAA'));
  });
});
