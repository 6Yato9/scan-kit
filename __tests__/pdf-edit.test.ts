// __tests__/pdf-edit.test.ts
// Page edits on imported PDFs (lib/pdf-edit.ts): the pure plans, the
// journaled atomic swap with Undo, crash recovery, split and merge. Native
// PDFKit is mocked; the file system is an in-memory map of URI -> content.
const mockFs = new Map<string, string>();
jest.mock('expo-file-system', () => {
  const part = (p: any) => (p && typeof p === 'object' ? p.uri : p);
  const strip = (u: string) => u.replace(/\/+$/, '');
  const DIR = '<dir>';
  class MockFile {
    uri: string;
    constructor(...parts: any[]) { this.uri = parts.map(part).map(strip).join('/'); }
    get exists() { return mockFs.has(this.uri) && mockFs.get(this.uri) !== DIR; }
    get size() { return mockFs.get(this.uri)?.length ?? 0; }
    get md5() { return `md5:${mockFs.get(this.uri)}`; }
    get name() { return this.uri.split('/').pop(); }
    delete() { mockFs.delete(this.uri); }
    create() { mockFs.set(this.uri, ''); }
    copy(dest: MockFile) {
      if (!this.exists) throw new Error('no src');
      if (mockFs.has(dest.uri)) throw new Error('dest exists');
      mockFs.set(dest.uri, mockFs.get(this.uri)!);
    }
    move(dest: MockFile) {
      if (!this.exists) throw new Error('no src');
      if (mockFs.has(dest.uri)) throw new Error('dest exists');
      mockFs.set(dest.uri, mockFs.get(this.uri)!);
      mockFs.delete(this.uri);
      this.uri = dest.uri;
    }
  }
  class MockDirectory {
    uri: string;
    constructor(...parts: any[]) { this.uri = parts.map(part).map(strip).join('/'); }
    get exists() { return [...mockFs.keys()].some(f => f === this.uri || f.startsWith(`${this.uri}/`)); }
    get name() { return this.uri.split('/').pop(); }
    create() { if (!mockFs.has(this.uri)) mockFs.set(this.uri, DIR); }
    delete() { for (const f of [...mockFs.keys()]) if (f === this.uri || f.startsWith(`${this.uri}/`)) mockFs.delete(f); }
    list() {
      const out = new Map<string, any>();
      for (const [f, v] of mockFs) {
        if (!f.startsWith(`${this.uri}/`)) continue;
        const rest = f.slice(this.uri.length + 1);
        const head = rest.split('/')[0];
        const child = `${this.uri}/${head}`;
        if (out.has(child)) continue;
        out.set(child, rest.includes('/') || v === DIR ? new MockDirectory(child) : new MockFile(child));
      }
      return [...out.values()];
    }
  }
  return { File: MockFile, Directory: MockDirectory, Paths: { document: { uri: 'file:///docs' }, cache: { uri: 'file:///caches' } } };
});

let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `new-${++mockUuid}` }));

// Native: an "edited" PDF's content is a readable description of the plan.
const mockNative: any = {
  pdfEditPages: jest.fn(async (inp: string, out: string, sources: number[], rotations: number[]) => {
    if (!mockFs.has(inp)) throw new Error('Could not open the PDF');
    mockFs.set(out, `edit(${mockFs.get(inp)}|${sources.join(',')}|${rotations.join(',')})`);
    return sources.length;
  }),
  replaceFile: jest.fn(async (src: string, dest: string) => {
    if (!mockFs.has(src)) throw new Error('Nothing to move');
    mockFs.set(dest, mockFs.get(src)!);
    mockFs.delete(src);
    return dest;
  }),
  pdfPageTexts: jest.fn(async (uri: string) => [`text of ${mockFs.get(uri)}`]),
  pdfInfo: jest.fn(),
  mergePdfs: jest.fn(async (inputs: string[], out: string) => {
    mockFs.set(out, `merge(${inputs.map(i => mockFs.get(i)).join('+')})`);
    return out;
  }),
};
const mockPageCounts = new Map<string, number>();
const mockLocked = new Set<string>();
jest.mock('../modules/vision-ocr/src', () => ({ get VisionOcr() { return mockNative; } }));

const mockDocs = new Map<string, any>();
const mockUpdate = jest.fn(async (id: string, fn: (cur: any) => any) => {
  const cur = mockDocs.get(id);
  if (!cur) return false;
  const patch = fn({ ...cur });
  if (!patch) return false;
  const next = { ...cur, ...patch };
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete next[k];
  mockDocs.set(id, next);
  return true;
});
const mockTrash = jest.fn(async (_id: string) => true);
jest.mock('../lib/storage', () => ({
  getDocument: jest.fn(async (id: string) => (mockDocs.has(id) ? { ...mockDocs.get(id) } : null)),
  updateDocumentWith: (id: string, fn: (cur: any) => any) => mockUpdate(id, fn),
  saveDocument: jest.fn(async (doc: any) => { mockDocs.set(doc.id, { ...doc }); }),
  deleteDocument: jest.fn(async (id: string) => { mockDocs.delete(id); }),
  trashDocument: (id: string) => mockTrash(id),
  getDocSettings: jest.fn(async () => ({ namePrefix: 'Scan', pdfPageSize: 'Letter', pdfQuality: 'standard' })),
}));
const mockJson = new Map<string, any>();
jest.mock('../lib/storage-layout', () => {
  const { Directory } = jest.requireActual('expo-file-system') as any;
  void Directory;
  return {
    privateStateDir: () => new (jest.requireMock('expo-file-system').Directory)('file:///support'),
    writeJsonSync: (dir: any, name: string, value: any) => { mockFs.set(`${dir.uri}/${name}`, JSON.stringify(value)); return true; },
    readJsonSync: (dir: any, name: string) => {
      const raw = mockFs.get(`${dir.uri}/${name}`);
      return raw === undefined ? { state: 'absent' } : { state: 'ok', value: JSON.parse(raw) };
    },
    deleteJsonSync: (dir: any, name: string) => { mockFs.delete(`${dir.uri}/${name}`); },
  };
});
void mockJson;
jest.mock('../lib/bake', () => ({ withDocLock: (_id: string, fn: () => unknown) => Promise.resolve().then(fn) }));
jest.mock('../lib/files', () => ({
  copyPdfToStorage: (tmp: string, id: string) => {
    const dest = `file:///support/scan-kit/${id}/document.pdf`;
    mockFs.set(dest, mockFs.get(tmp)!);
    return dest;
  },
  deleteDocumentFiles: jest.fn((id: string) => {
    for (const f of [...mockFs.keys()]) if (f.startsWith(`file:///support/scan-kit/${id}/`)) mockFs.delete(f);
  }),
}));
const mockGenerate = jest.fn(async (pages: string[], _opts: any) => {
  const uri = `file:///caches/Print/${pages.length}-pages.pdf`;
  mockFs.set(uri, `scan(${pages.length})`);
  return uri;
});
jest.mock('../lib/pdf', () => ({ generatePdf: (p: string[], o: any) => mockGenerate(p, o) }));
jest.mock('../lib/ocr', () => ({ ocrAvailable: () => true }));

import {
  blankLike,
  canEditPdfPages,
  deletePlan,
  discardPdfEditUndo,
  editStoredPdf,
  identityPlan,
  insertBlankPlan,
  isIdentityPlan,
  isPermutation,
  mergeDocumentsToPdf,
  needsPdfMerge,
  newIndexOf,
  PdfEditError,
  recoverInterruptedPdfEdits,
  reorderPlan,
  resetPdfEditForTests,
  rotatePlan,
  samePrint,
  splitNames,
  splitPlans,
  splitStoredPdf,
  undoPdfEdit,
} from '../lib/pdf-edit';
import { indexPdfText, resetPdfTextForTests } from '../lib/pdf-text';

const PDF = 'file:///support/scan-kit/d1/document.pdf';
const workDirs = () => [...mockFs.keys()].filter(f => /^file:\/\/\/support\/pdf-edit\/[^/]+$/.test(f));
const workFiles = () => [...mockFs.keys()].filter(f => f.startsWith('file:///support/pdf-edit/') && mockFs.get(f) !== '<dir>');

beforeEach(() => {
  jest.clearAllMocks();
  resetPdfEditForTests();
  resetPdfTextForTests();
  mockFs.clear();
  mockDocs.clear();
  mockPageCounts.clear();
  mockLocked.clear();
  mockUuid = 0;
  // A merged file has the pages of its parts; anything else is 4 pages unless set.
  mockNative.pdfInfo.mockImplementation(async (uri: string) => ({
    pageCount: mockPageCounts.get(uri) ?? (/^merge\(v1\+scan\(2\)\)$/.test(mockFs.get(uri) ?? '') ? 6 : 4),
    locked: mockLocked.has(uri),
    encrypted: false,
  }));
  mockFs.set(PDF, 'v1');
  mockDocs.set('d1', { id: 'd1', name: 'Lease', pages: [], pdfUri: `${PDF}?v=3`, folder: 'Home', ocrText: 'old text', createdAt: 1, updatedAt: 1 });
});

// ── Plans ────────────────────────────────────────────────────────────────────

describe('plans', () => {
  test('rotate turns one page only', () => {
    expect(rotatePlan(3, 1, 90)).toEqual([{ source: 0, rotate: 0 }, { source: 1, rotate: 90 }, { source: 2, rotate: 0 }]);
    expect(() => rotatePlan(3, 3, 90)).toThrow(RangeError);
  });

  test('delete leaves a page out, never the last one', () => {
    expect(deletePlan(3, 0).map(s => s.source)).toEqual([1, 2]);
    expect(() => deletePlan(1, 0)).toThrow(RangeError);
  });

  test('a blank page goes after the page, shaped like it', () => {
    expect(insertBlankPlan(3, 1).map(s => s.source)).toEqual([0, 1, blankLike(1), 2]);
    expect(blankLike(1)).toBe(-2);
    expect(insertBlankPlan(1, 0).map(s => s.source)).toEqual([0, -1]);
  });

  test('reorder needs a full permutation', () => {
    expect(reorderPlan([2, 0, 1]).map(s => s.source)).toEqual([2, 0, 1]);
    expect(isPermutation([0, 0, 1], 3)).toBe(false);
    expect(isPermutation([0, 1], 3)).toBe(false);
    expect(isPermutation([0, 3, 1], 3)).toBe(false);
    expect(() => reorderPlan([1, 1])).toThrow(RangeError);
    expect(newIndexOf([2, 0, 1], 0)).toBe(1);
  });

  test('split after page N gives the two halves', () => {
    const [a, b] = splitPlans(5, 1);
    expect(a.map(s => s.source)).toEqual([0, 1]);
    expect(b.map(s => s.source)).toEqual([2, 3, 4]);
    expect(() => splitPlans(3, 2)).toThrow(RangeError);
    expect(() => splitPlans(1, 0)).toThrow(RangeError);
    expect(splitNames('Lease')).toEqual(['Lease (1)', 'Lease (2)']);
  });

  test('identity and merge helpers', () => {
    expect(isIdentityPlan(identityPlan(3), 3)).toBe(true);
    expect(isIdentityPlan(rotatePlan(3, 0, 360), 3)).toBe(true);
    expect(isIdentityPlan(rotatePlan(3, 0, 90), 3)).toBe(false);
    expect(needsPdfMerge([{}, { pdfUri: 'x' }])).toBe(true);
    expect(needsPdfMerge([{}, {}])).toBe(false);
    expect(samePrint({ size: 3, md5: 'a' }, { size: 3, md5: 'a' })).toBe(true);
    expect(samePrint({ size: 3, md5: 'a' }, { size: 3, md5: 'b' })).toBe(false);
    expect(samePrint({ size: null, md5: null }, { size: null, md5: null })).toBe(false);
  });
});

// ── Editing in place ─────────────────────────────────────────────────────────

describe('editStoredPdf', () => {
  test('writes the plan into the stored PDF in one atomic replace and updates the record', async () => {
    expect(canEditPdfPages()).toBe(true);
    const { doc, pageCount, undo } = await editStoredPdf('d1', rotatePlan(4, 0, 90));
    // Native read the clean stored path; the result replaced it by rename.
    expect(mockNative.pdfEditPages).toHaveBeenCalledWith(PDF, expect.stringMatching(/\/pdf-edit\/.+\/after\.pdf$/), [0, 1, 2, 3], [90, 0, 0, 0], null);
    expect(mockNative.replaceFile).toHaveBeenCalledWith(expect.stringMatching(/after\.pdf$/), PDF);
    expect(mockFs.get(PDF)).toBe('edit(v1|0,1,2,3|90,0,0,0)');
    expect(pageCount).toBe(4);
    // Search text is read from the new file and saved with it.
    expect(doc.ocrText).toBe('text of edit(v1|0,1,2,3|90,0,0,0)');
    expect(doc.updatedAt).toBeGreaterThan(1);
    expect(doc.folder).toBe('Home');
    // The journal is gone; the old PDF is kept for Undo.
    expect(workFiles().some(f => f.endsWith('journal.json'))).toBe(false);
    expect(undo).not.toBeNull();
    expect(mockFs.get(`${undo!.dir}/before.pdf`)).toBe('v1');
  });

  test('a native failure changes nothing and leaves no work folder', async () => {
    mockNative.pdfEditPages.mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'ERR_PDF_LOCKED' }));
    await expect(editStoredPdf('d1', deletePlan(4, 0))).rejects.toMatchObject({ kind: 'locked' });
    expect(mockFs.get(PDF)).toBe('v1');
    expect(mockDocs.get('d1').ocrText).toBe('old text');
    expect(mockDocs.get('d1').updatedAt).toBe(1);
    expect(workDirs()).toEqual([]);
    expect(mockNative.replaceFile).not.toHaveBeenCalled();
  });

  test('an unverified result is never swapped in', async () => {
    mockNative.pdfEditPages.mockResolvedValueOnce(2); // claims 2 pages for a 3-page plan
    await expect(editStoredPdf('d1', deletePlan(4, 0))).rejects.toMatchObject({ kind: 'failed' });
    expect(mockFs.get(PDF)).toBe('v1');
    expect(mockNative.replaceFile).not.toHaveBeenCalled();
  });

  test('a failed replace removes the journal and leaves the stored PDF and record as they were', async () => {
    mockNative.replaceFile.mockRejectedValueOnce(new Error('Could not replace the file'));
    await expect(editStoredPdf('d1', rotatePlan(4, 0, 90))).rejects.toBeInstanceOf(PdfEditError);
    expect(mockFs.get(PDF)).toBe('v1');
    expect(mockDocs.get('d1').updatedAt).toBe(1);
    expect(workFiles()).toEqual([]);
  });

  test('refuses a document that is no longer a PDF, or is gone', async () => {
    mockDocs.set('d1', { ...mockDocs.get('d1'), pdfUri: undefined, pages: ['p'] });
    await expect(editStoredPdf('d1', rotatePlan(1, 0, 90))).rejects.toMatchObject({ kind: 'changed' });
    mockDocs.delete('d1');
    await expect(editStoredPdf('d1', rotatePlan(1, 0, 90))).rejects.toMatchObject({ kind: 'missing' });
    expect(mockNative.pdfEditPages).not.toHaveBeenCalled();
  });

  test('without pdfPageTexts the search text is cleared, to be read again later', async () => {
    const read = mockNative.pdfPageTexts;
    mockNative.pdfPageTexts = undefined;
    try {
      const { doc } = await editStoredPdf('d1', rotatePlan(4, 0, 90));
      expect(doc.ocrText).toBeUndefined();
    } finally {
      mockNative.pdfPageTexts = read;
    }
  });

  test('a newer edit drops the older Undo stash', async () => {
    const first = await editStoredPdf('d1', rotatePlan(4, 0, 90));
    const second = await editStoredPdf('d1', rotatePlan(4, 1, 90));
    expect(mockFs.has(`${first.undo!.dir}/before.pdf`)).toBe(false);
    expect(mockFs.get(`${second.undo!.dir}/before.pdf`)).toBe('edit(v1|0,1,2,3|90,0,0,0)');
  });
});

describe('undoPdfEdit', () => {
  test('puts the previous PDF and its search text back, once', async () => {
    const { undo } = await editStoredPdf('d1', deletePlan(4, 2));
    const restored = await undoPdfEdit(undo!);
    expect(mockFs.get(PDF)).toBe('v1');
    expect(restored.ocrText).toBe('old text');
    expect(workDirs()).toEqual([]);
    await expect(undoPdfEdit(undo!)).rejects.toMatchObject({ kind: 'changed' });
    expect(mockFs.get(PDF)).toBe('v1');
  });

  test('refuses when the PDF changed since the edit, leaving it alone', async () => {
    const { undo } = await editStoredPdf('d1', deletePlan(4, 2));
    mockFs.set(PDF, 'someone else wrote this');
    await expect(undoPdfEdit(undo!)).rejects.toMatchObject({ kind: 'changed' });
    expect(mockFs.get(PDF)).toBe('someone else wrote this');
  });

  test('a discarded stash can no longer undo', async () => {
    const { undo } = await editStoredPdf('d1', deletePlan(4, 2));
    discardPdfEditUndo(undo);
    await expect(undoPdfEdit(undo!)).rejects.toMatchObject({ kind: 'changed' });
  });
});

// ── Crash recovery ───────────────────────────────────────────────────────────

describe('recoverInterruptedPdfEdits', () => {
  const crashed = 'file:///support/pdf-edit/oldsession-d1-1-1';
  const journal = (target: string) => JSON.stringify({ v: 1, session: 'oldsession', docId: 'd1', target, written: { size: 2, md5: null } });

  test('killed after the swap: the record re-reads its text, the folder goes', async () => {
    mockFs.set(PDF, 'new bytes');
    mockFs.set(`${crashed}/before.pdf`, 'v1');
    mockFs.set(`${crashed}/journal.json`, journal(PDF));
    expect(await recoverInterruptedPdfEdits()).toBe(1);
    expect(mockFs.get(PDF)).toBe('new bytes');
    expect(mockDocs.get('d1').ocrText).toBeUndefined();
    expect(mockDocs.get('d1').updatedAt).toBeGreaterThan(1);
    expect(workFiles()).toEqual([]);
  });

  test('a missing stored PDF is put back from the newest complete file', async () => {
    mockFs.delete(PDF);
    mockFs.set(`${crashed}/after.pdf`, 'edited');
    mockFs.set(`${crashed}/before.pdf`, 'v1');
    mockFs.set(`${crashed}/journal.json`, journal(PDF));
    await recoverInterruptedPdfEdits();
    expect(mockFs.get(PDF)).toBe('edited');
  });

  test('stashes without a journal are just removed; this session’s are kept', async () => {
    mockFs.set(`${crashed}/before.pdf`, 'v1');
    const { undo } = await editStoredPdf('d1', rotatePlan(4, 0, 90));
    expect(await recoverInterruptedPdfEdits()).toBe(0);
    expect(mockFs.has(`${crashed}/before.pdf`)).toBe(false);
    expect(mockFs.get(`${undo!.dir}/before.pdf`)).toBe('v1');
    expect(mockDocs.get('d1').ocrText).toBe('text of edit(v1|0,1,2,3|90,0,0,0)');
  });
});

// ── Split ────────────────────────────────────────────────────────────────────

describe('splitStoredPdf', () => {
  test('makes "(1)" and "(2)" in the same folder and keeps the original', async () => {
    const { first, second, originalTrashed } = await splitStoredPdf('d1', 0);
    expect(mockNative.pdfEditPages.mock.calls.map((c: any[]) => c[2])).toEqual([[0], [1, 2, 3]]);
    expect(first).toMatchObject({ name: 'Lease (1)', folder: 'Home', pages: [] });
    expect(second).toMatchObject({ name: 'Lease (2)', folder: 'Home', pages: [] });
    expect(mockFs.get(first.pdfUri!)).toBe('edit(v1|0|0)');
    expect(mockFs.get(second.pdfUri!)).toBe('edit(v1|1,2,3|0,0,0)');
    expect(first.ocrText).toBe('text of edit(v1|0|0)');
    expect(originalTrashed).toBe(false);
    expect(mockTrash).not.toHaveBeenCalled();
    expect(mockFs.get(PDF)).toBe('v1');
    expect(workDirs()).toEqual([]);
  });

  test('can move the original to Recently deleted', async () => {
    const r = await splitStoredPdf('d1', 2, { trashOriginal: true });
    expect(mockTrash).toHaveBeenCalledWith('d1');
    expect(r.originalTrashed).toBe(true);
  });

  test('a failure on the second part removes the first: nothing half-made stays', async () => {
    mockNative.pdfEditPages
      .mockImplementationOnce(async (_i: string, out: string, s: number[]) => { mockFs.set(out, 'part'); return s.length; })
      .mockRejectedValueOnce(new Error('Could not write the PDF'));
    await expect(splitStoredPdf('d1', 1)).rejects.toMatchObject({ kind: 'failed' });
    expect([...mockDocs.keys()]).toEqual(['d1']);
    expect([...mockFs.keys()].filter(f => f.includes('/new-'))).toEqual([]);
  });

  test('nothing to split in a one-page PDF; a locked PDF asks for its password', async () => {
    mockPageCounts.set(PDF, 1);
    await expect(splitStoredPdf('d1', 0)).rejects.toMatchObject({ kind: 'changed' });
    mockPageCounts.set(PDF, 3);
    mockLocked.add(PDF);
    await expect(splitStoredPdf('d1', 0)).rejects.toMatchObject({ kind: 'locked' });
    expect(mockDocs.size).toBe(1);
  });
});

// ── Merge ────────────────────────────────────────────────────────────────────

describe('mergeDocumentsToPdf', () => {
  beforeEach(() => {
    mockDocs.set('s1', { id: 's1', name: 'Receipt', pages: ['a.jpg', 'b.jpg'], createdAt: 1, updatedAt: 1 });
    mockPageCounts.set(PDF, 4);
  });

  test('PDF + scan: scan rendered on the paper size from settings, merged in order, one new PDF', async () => {
    const doc = await mergeDocumentsToPdf([mockDocs.get('d1'), mockDocs.get('s1')], 'Lease (merged)');
    expect(mockGenerate).toHaveBeenCalledWith(['a.jpg', 'b.jpg'], expect.objectContaining({ pageSize: 'Letter', searchable: true }));
    expect(mockNative.mergePdfs).toHaveBeenCalledWith([PDF, 'file:///caches/Print/2-pages.pdf'], expect.stringMatching(/merged\.pdf$/));
    expect(doc).toMatchObject({ name: 'Lease (merged)', folder: 'Home', pages: [] });
    expect(mockFs.get(doc.pdfUri!)).toBe('merge(v1+scan(2))');
    expect(doc.ocrText).toBe('text of merge(v1+scan(2))');
    // Originals untouched; temporary renders gone.
    expect(mockFs.get(PDF)).toBe('v1');
    expect(mockFs.has('file:///caches/Print/2-pages.pdf')).toBe(false);
    expect(workDirs()).toEqual([]);
  });

  test('a locked PDF names the document that needs its password; nothing is saved', async () => {
    mockLocked.add(PDF);
    const err = await mergeDocumentsToPdf([mockDocs.get('s1'), mockDocs.get('d1')], 'x').catch(e => e);
    expect(err).toBeInstanceOf(PdfEditError);
    expect(err).toMatchObject({ kind: 'locked', docId: 'd1' });
    expect(mockDocs.size).toBe(2);
    expect(mockNative.mergePdfs).not.toHaveBeenCalled();
  });

  test('a merged file with the wrong page count is refused', async () => {
    mockNative.pdfInfo.mockImplementation(async (uri: string) => ({ pageCount: uri.endsWith('merged.pdf') ? 5 : uri === PDF ? 4 : 2, locked: false, encrypted: false }));
    await expect(mergeDocumentsToPdf([mockDocs.get('d1'), mockDocs.get('s1')], 'x')).rejects.toMatchObject({ kind: 'failed' });
    expect(mockDocs.size).toBe(2);
  });
});

// ── Text index vs. an edit ───────────────────────────────────────────────────

test('a text index read before an edit does not overwrite the edited PDF’s text', async () => {
  mockDocs.set('d1', { ...mockDocs.get('d1'), ocrText: undefined });
  let release!: (v: string[]) => void;
  mockNative.pdfPageTexts.mockImplementationOnce(() => new Promise<string[]>(r => { release = r; }));
  const indexing = indexPdfText('d1');
  await new Promise(r => setTimeout(r, 0));
  const { doc } = await editStoredPdf('d1', deletePlan(4, 0));
  release(['stale text of the old PDF']);
  expect(await indexing).toBe('skipped');
  expect(mockDocs.get('d1').ocrText).toBe(doc.ocrText);
});
