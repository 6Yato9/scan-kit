// lib/add-pages-undo.ts: Undo for the viewer's Add pages (r13b). The added
// pages come out again exactly as merge Undo takes merged pages out — only
// while they are still as added. The look baked into them straight after the
// add is part of adding them; a filter the user picks later is an edit.
const mockFiles = new Map<string, string>(); // uri -> identity
jest.mock('expo-file-system', () => {
  const part = (p: any) => (p && typeof p === 'object' ? p.uri : p);
  class MockFile {
    uri: string;
    constructor(dir: any, name?: string) { this.uri = name ? `${part(dir)}/${name}` : String(part(dir)); }
    get exists() { return mockFiles.has(this.uri); }
    delete() { mockFiles.delete(this.uri); }
  }
  return { File: MockFile, Directory: class {}, Paths: {} };
});
jest.mock('../lib/storage-layout', () => ({ docDir: (id: string) => ({ uri: `file:///as/scan-kit/${id}` }) }));
let mockLayout = 0;
jest.mock('../lib/files', () => ({ pageLayoutGeneration: () => mockLayout }));
jest.mock('../lib/ocr-cache', () => ({
  fileIdentity: (uri: string) => mockFiles.get(uri) ?? null,
  pruneDocumentOcr: () => {},
}));
jest.mock('../lib/storage', () => ({}));
jest.mock('../lib/bake', () => ({}));
jest.mock('../lib/save-scan', () => ({ indexDocText: async () => {} }));

import {
  addedPagesMessage,
  addPagesUndoneMessage,
  addPagesUndoRefusalMessage,
  addPagesUndoRemap,
  addPagesUndoToken,
  noteAddedPageBaked,
  removeAddedPages,
} from '../lib/add-pages-undo';
import { MergeUndoError } from '../lib/merge-undo';
import { undoLabelFor } from '../lib/last-undo';
import type { Document } from '../types/document';

const dir = 'file:///as/scan-kit/d';
const SUFFIXES = ['.jpg', '.orig.jpg', '.src.jpg', '.src.json'];

function seed(n: number): Document {
  for (let i = 0; i < n; i++) for (const s of SUFFIXES) mockFiles.set(`${dir}/page-${i}${s}`, `${i}${s}-v1`);
  return { id: 'd', name: 'D', pages: Array.from({ length: n }, (_, i) => `${dir}/page-${i}.jpg`), createdAt: 1, updatedAt: 1 };
}
/** A page's pixels were written again (a bake, rotate, crop…). */
const rewrite = (i: number, v: string) => mockFiles.set(`${dir}/page-${i}.jpg`, `${i}.jpg-${v}`);

beforeEach(() => {
  mockFiles.clear();
  mockLayout = 0;
});

test('two pages added to a two-page document come out with every shadow; the others stay', () => {
  const doc = seed(4);
  const undo = addPagesUndoToken('d', 2, 2)!;
  expect(undo).toMatchObject({ docId: 'd', start: 2, count: 2, layout: 0 });
  const patch = removeAddedPages({ ...doc, filters: ['bw', 'bw', 'bw', 'enhanced'] }, undo);
  expect(patch.pages).toEqual(doc.pages.slice(0, 2));
  expect(patch.filters).toEqual(['bw', 'bw']);
  for (const s of SUFFIXES) {
    expect(mockFiles.has(`${dir}/page-2${s}`)).toBe(false);
    expect(mockFiles.has(`${dir}/page-3${s}`)).toBe(false);
    expect(mockFiles.has(`${dir}/page-1${s}`)).toBe(true);
  }
  expect(addPagesUndoRemap(undo)(1)).toBe(1);
  expect(addPagesUndoRemap(undo)(2)).toBe(-1);
});

test('the look baked straight after the add is still "as added"', () => {
  const doc = seed(3);
  const undo = addPagesUndoToken('d', 1, 2)!;
  rewrite(1, 'bw');
  rewrite(2, 'bw');
  noteAddedPageBaked(undo, 1);
  noteAddedPageBaked(undo, 2);
  noteAddedPageBaked(undo, 0); // not an added page: ignored
  expect(() => removeAddedPages(doc, undo)).not.toThrow();
});

test('an added page edited afterwards (a later filter, a crop) refuses, changing nothing', () => {
  const doc = seed(3);
  const undo = addPagesUndoToken('d', 1, 2)!;
  rewrite(2, 'bw');
  noteAddedPageBaked(undo, 2);
  rewrite(2, 'cropped'); // the user's own edit: never noted
  const before = new Map(mockFiles);
  let err: unknown;
  try { removeAddedPages(doc, undo); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(MergeUndoError);
  expect(err).toMatchObject({ kind: 'pages-edited', editRefused: true });
  expect(mockFiles).toEqual(before);
});

test('pages moved since: refused, and a bake noted after the move is not trusted', () => {
  const doc = seed(3);
  const undo = addPagesUndoToken('d', 2, 1)!;
  mockLayout = 1;
  rewrite(2, 'other');
  noteAddedPageBaked(undo, 2);
  expect(undo.identities[0]).toBe('2.jpg-v1');
  expect(() => removeAddedPages(doc, undo)).toThrow(expect.objectContaining({ kind: 'pages-changed' }));
});

test('a page added after them: refused (they are no longer the trailing pages)', () => {
  seed(2);
  const undo = addPagesUndoToken('d', 1, 1)!;
  const doc = seed(3);
  expect(() => removeAddedPages(doc, undo)).toThrow(expect.objectContaining({ kind: 'pages-changed' }));
});

test('what the user reads, and the "…" menu row', () => {
  expect(addedPagesMessage(1)).toBe('Added 1 page');
  expect(addedPagesMessage(3)).toBe('Added 3 pages');
  expect(undoLabelFor(addedPagesMessage(3))).toBe('Undo add 3 pages');
  expect(undoLabelFor(addedPagesMessage(1))).toBe('Undo add 1 page');
  // A merge's toast still names the merge.
  expect(undoLabelFor('Added 3 pages from “Lease”')).toBe('Undo merge');
  expect(addPagesUndoneMessage(1)).toBe('Added page removed');
  expect(addPagesUndoneMessage(4)).toBe('4 added pages removed');
  for (const kind of ['missing', 'pages-changed', 'pages-edited'] as const) {
    for (const n of [1, 3]) {
      const m = addPagesUndoRefusalMessage(kind, n);
      expect(m).not.toMatch(/'/);
      expect(m).toMatch(n === 1 ? /added page\b/ : /added pages/);
    }
  }
});
