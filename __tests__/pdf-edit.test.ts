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
const mockInvalidateThumbs = jest.fn();
jest.mock('../lib/pdf-thumb', () => ({ invalidatePdfThumbs: (id: string) => mockInvalidateThumbs(id) }));

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
  reprotectPlan,
  rewriteStoredPdf,
  resetPdfEditForTests,
  holdPdfEditUndo,
  UNDO_TTL_MS,
  rotatePlan,
  samePrint,
  splitNames,
  splitPlans,
  splitStoredPdf,
  splitStoredPdfParts,
  partPlans,
  undoPdfEdit,
} from '../lib/pdf-edit';
import { indexPdfText, resetPdfTextForTests } from '../lib/pdf-text';
import { protectedEditRefusal, readablePdfUri, resetPdfSessionsForTests, unlockForSession } from '../lib/pdf-session';

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

describe('a record write that fails AFTER the PDF was swapped (r12 code review #1)', () => {
  /** What the next launch sees: this session's folder, renamed as an earlier session's. */
  const asEarlierSession = () => {
    for (const [k, v] of [...mockFs]) {
      const m = /^file:\/\/\/support\/pdf-edit\/[^-/]+-(.*)$/.exec(k);
      if (!m) continue;
      mockFs.delete(k);
      mockFs.set(`file:///support/pdf-edit/oldsession-${m[1]}`, v);
    }
  };

  test('edit: rejects as partial (never "unchanged"), keeps the journal and before.pdf; the next launch reconciles', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('disk full'));
    await expect(editStoredPdf('d1', rotatePlan(4, 0, 90))).rejects.toMatchObject({ kind: 'partial' });
    expect(mockFs.get(PDF)).toBe('edit(v1|0,1,2,3|90,0,0,0)'); // the PDF did change
    expect(mockDocs.get('d1').ocrText).toBe('old text'); // the record didn't
    expect(workFiles().some(f => f.endsWith('/journal.json'))).toBe(true);
    expect(workFiles().some(f => f.endsWith('/before.pdf'))).toBe(true);
    expect(mockInvalidateThumbs).toHaveBeenCalledWith('d1'); // its old renders are gone
    asEarlierSession();
    expect(await recoverInterruptedPdfEdits()).toBe(1);
    expect(mockDocs.get('d1').ocrText).toBeUndefined(); // read again from the PDF that is there
    expect(mockDocs.get('d1').updatedAt).toBeGreaterThan(1);
    expect(workFiles()).toEqual([]);
  });

  test('Undo: rejects as partial, the PDF is back, the journal stays for the next launch', async () => {
    const { undo } = await editStoredPdf('d1', deletePlan(4, 2));
    mockUpdate.mockRejectedValueOnce(new Error('disk full'));
    await expect(undoPdfEdit(undo!)).rejects.toMatchObject({ kind: 'partial' });
    expect(mockFs.get(PDF)).toBe('v1');
    expect(workFiles().some(f => f.endsWith('/journal.json'))).toBe(true);
    asEarlierSession();
    expect(await recoverInterruptedPdfEdits()).toBe(1);
    expect(mockDocs.get('d1').ocrText).toBeUndefined();
    expect(workFiles()).toEqual([]);
  });

  test('the cached page renders are dropped after an edit and after its Undo, not after a failed swap', async () => {
    const { undo } = await editStoredPdf('d1', rotatePlan(4, 0, 90));
    expect(mockInvalidateThumbs).toHaveBeenCalledTimes(1);
    await undoPdfEdit(undo!);
    expect(mockInvalidateThumbs).toHaveBeenCalledTimes(2);
    mockNative.replaceFile.mockRejectedValueOnce(new Error('Could not replace the file'));
    await expect(editStoredPdf('d1', rotatePlan(4, 0, 90))).rejects.toBeInstanceOf(PdfEditError);
    expect(mockInvalidateThumbs).toHaveBeenCalledTimes(2);
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

describe('splitStoredPdfParts (round 16)', () => {
  test('one PDF per part, pages as chosen, text kept; the original stays', async () => {
    const r = await splitStoredPdfParts('d1', n => partPlans([[0], [2, 3], [1]], n));
    expect(mockNative.pdfEditPages.mock.calls.map((c: any[]) => c[2])).toEqual([[0], [2, 3], [1]]);
    expect(r.parts.map(d => d.name)).toEqual(['Lease (1)', 'Lease (2)', 'Lease (3)']);
    expect(r.parts.every(d => d.folder === 'Home' && d.pages.length === 0)).toBe(true);
    expect(r.originalTrashed).toBe(false);
    expect(mockFs.get(PDF)).toBe('v1');
    expect(workDirs()).toEqual([]);
  });

  test('part (1) sorts first in "Date added" (newest), as a scanned split does, however slow each copy is', async () => {
    // Each PDFKit copy takes a while: the clock moves on between parts.
    let clock = 1_000_000;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const copy = mockNative.pdfEditPages.getMockImplementation();
    mockNative.pdfEditPages.mockImplementation(async (...a: any[]) => {
      clock += 250;
      return copy ? copy(...a) : a[2].length;
    });
    try {
      const r = await splitStoredPdfParts('d1', n => partPlans([[0], [1], [2, 3]], n));
      const byDateAdded = [...r.parts].sort((a, b) => b.createdAt - a.createdAt).map(d => d.name);
      expect(byDateAdded).toEqual(['Lease (1)', 'Lease (2)', 'Lease (3)']);
    } finally {
      spy.mockRestore();
      if (copy) mockNative.pdfEditPages.mockImplementation(copy);
    }
  });

  test('the original is never trashed while some of its pages are in no part (data safety)', async () => {
    const r = await splitStoredPdfParts('d1', n => partPlans([[0], [2]], n), { trashOriginal: true });
    expect(r.originalTrashed).toBe(false);
    expect(mockTrash).not.toHaveBeenCalled();
    const r2 = await splitStoredPdfParts('d1', n => partPlans([[0, 1], [2, 3]], n), { trashOriginal: true });
    expect(r2.originalTrashed).toBe(true);
    expect(mockTrash).toHaveBeenCalledWith('d1');
  });

  test('a part outside the PDF is refused before anything is written', async () => {
    expect(() => partPlans([[0], [9]], 4)).toThrow(RangeError);
    await expect(splitStoredPdfParts('d1', n => (n === 99 ? partPlans([[0]], n) : []))).rejects.toMatchObject({ kind: 'changed' });
    expect(mockNative.pdfEditPages).not.toHaveBeenCalled();
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

// Round 12b: the viewer offers the last Undo in its "…" menu until the next
// edit, so it holds the stash past UNDO_TTL_MS; Undo still checks the PDF.
describe('holdPdfEditUndo', () => {
  afterEach(() => jest.useRealTimers());

  test('an unheld stash is dropped after UNDO_TTL_MS; a held one stays until discarded', async () => {
    jest.useFakeTimers();
    const first = await editStoredPdf('d1', rotatePlan(4, 0, 90));
    jest.advanceTimersByTime(UNDO_TTL_MS);
    expect(mockFs.has(`${first.undo!.dir}/before.pdf`)).toBe(false);

    const second = await editStoredPdf('d1', rotatePlan(4, 1, 90));
    expect(holdPdfEditUndo('d1')).toBe(second.undo);
    jest.advanceTimersByTime(UNDO_TTL_MS * 20);
    expect(mockFs.has(`${second.undo!.dir}/before.pdf`)).toBe(true);
    jest.useRealTimers();
    await undoPdfEdit(second.undo!);
    expect(mockFs.get(PDF)).toBe('edit(v1|0,1,2,3|90,0,0,0)');
  });

  test('nothing to hold for a document without an Undo', () => {
    expect(holdPdfEditUndo('nope')).toBeNull();
  });

  test('a held stash is still refused once the PDF changed', async () => {
    const { undo } = await editStoredPdf('d1', deletePlan(4, 2));
    holdPdfEditUndo('d1');
    mockFs.set(PDF, 'changed elsewhere');
    await expect(undoPdfEdit(undo!)).rejects.toMatchObject({ kind: 'changed' });
  });
});

// ── A protected PDF unlocked for the session (lib/pdf-session.ts) ────────────

describe('a password-protected PDF unlocked for the session', () => {
  // "enc(<password>:<plain>)" is an encrypted PDF; unlockPdf / protectPdf
  // translate between the two forms.
  const ENC = /^enc\(([^:]+):(.*)\)$/;
  const ALL = { printLow: true, printHigh: true, changeContent: true, assemblePages: true, copy: true, accessibility: true, comment: true, fillForms: true };
  let perms: Record<string, boolean>;

  beforeEach(async () => {
    resetPdfSessionsForTests();
    perms = { ...ALL };
    mockFs.set(PDF, 'enc(pw1:v1)');
    mockDocs.set('d1', { id: 'd1', name: 'Lease', pages: [], pdfUri: PDF, createdAt: 1, updatedAt: 1 });
    mockNative.unlockPdf = jest.fn(async (inp: string, out: string, pw: string) => {
      const m = ENC.exec(mockFs.get(inp) ?? '');
      if (!m || m[1] !== pw) throw new Error('wrong-password');
      mockFs.set(out, m[2]);
      return out;
    });
    mockNative.protectPdf = jest.fn(async (inp: string, out: string, pw: string) => {
      mockFs.set(out, `enc(${pw}:${mockFs.get(inp)})`);
      return out;
    });
    mockNative.pdfPermissions = jest.fn(async () => ({ pageCount: 4, encrypted: true, locked: false, passwordAccepted: true, permissions: perms }));
    mockNative.pdfInfo.mockImplementation(async (uri: string, password?: string | null) => {
      const m = ENC.exec(mockFs.get(uri) ?? '');
      // A merge of this PDF (4 pages) and a one-page scan has 5.
      return { pageCount: /^merge\(/.test(mockFs.get(uri) ?? '') ? 5 : 4, locked: !!m && password !== m[1], encrypted: !!m };
    });
    await unlockForSession({ id: 'd1', pdfUri: PDF }, 'pw1');
  });

  afterAll(() => {
    delete mockNative.unlockPdf;
    delete mockNative.protectPdf;
    delete mockNative.pdfPermissions;
    resetPdfSessionsForTests();
  });

  test('an edit is written from the session copy and encrypted again with the session password', async () => {
    const { doc, undo } = await editStoredPdf('d1', rotatePlan(4, 0, 90));
    const [input, plain] = mockNative.pdfEditPages.mock.calls[0];
    expect(input).toMatch(/\/pdf-session\//);
    // The plaintext result is in Caches/pdf-session, never in Application Support (backups).
    expect(plain).toMatch(/^file:\/\/\/caches\/pdf-session\/.+\/work-d1-.+\.pdf$/);
    expect(mockNative.protectPdf).toHaveBeenCalledWith(plain, expect.stringMatching(/after\.pdf$/), 'pw1');
    // The stored PDF is still protected, with the same password.
    expect(mockFs.get(PDF)).toBe('enc(pw1:edit(v1|0,1,2,3|90,0,0,0))');
    // Its text is what the password protects: never stored.
    expect(doc.ocrText).toBeUndefined();
    expect(mockNative.pdfPageTexts).not.toHaveBeenCalled();
    // The plaintext became the new session copy: no second decryption.
    mockNative.unlockPdf.mockClear();
    const copy = await readablePdfUri(doc);
    expect(mockFs.get(copy)).toBe('edit(v1|0,1,2,3|90,0,0,0)');
    expect(mockNative.unlockPdf).not.toHaveBeenCalled();
    expect([...mockFs.keys()].some(f => /\/work-d1-/.test(f))).toBe(false);
    // Undo puts the encrypted original back, byte for byte; the copy follows it.
    await undoPdfEdit(undo!);
    expect(mockFs.get(PDF)).toBe('enc(pw1:v1)');
    expect(mockFs.get(await readablePdfUri({ id: 'd1', pdfUri: PDF }))).toBe('v1');
  });

  test('refused as restricted when the permissions read with its password forbid page changes', async () => {
    resetPdfSessionsForTests();
    perms = { ...ALL, assemblePages: false };
    await unlockForSession({ id: 'd1', pdfUri: PDF }, 'pw1');
    await expect(editStoredPdf('d1', rotatePlan(4, 0, 90))).rejects.toMatchObject({ kind: 'restricted' });
    expect(mockNative.pdfEditPages).not.toHaveBeenCalled();
    expect(mockFs.get(PDF)).toBe('enc(pw1:v1)');
    // Merging takes its pages too: refused the same way.
    await expect(mergeDocumentsToPdf([mockDocs.get('d1'), { id: 'x', name: 'X', pages: ['p.jpg'], createdAt: 1, updatedAt: 1 }], 'M'))
      .rejects.toMatchObject({ kind: 'restricted', docId: 'd1' });
  });

  test('never written from a stale copy: the stored bytes are checked before every write', async () => {
    // Replaced behind the session's back (same size, same mtime, no generation bump).
    mockFs.set(PDF, 'enc(pw1:v2)');
    await editStoredPdf('d1', rotatePlan(4, 1, 90));
    expect(mockFs.get(PDF)).toBe('enc(pw1:edit(v2|0,1,2,3|0,90,0,0))');
  });

  test('not unlocked: native reads the stored file and refuses it, as before', async () => {
    resetPdfSessionsForTests();
    mockNative.pdfEditPages.mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'ERR_PDF_LOCKED' }));
    await expect(editStoredPdf('d1', rotatePlan(4, 0, 90))).rejects.toMatchObject({ kind: 'locked' });
    expect(mockNative.pdfEditPages.mock.calls[0][0]).toBe(PDF);
    expect(mockNative.protectPdf).not.toHaveBeenCalled();
    expect(mockFs.get(PDF)).toBe('enc(pw1:v1)');
  });

  test('Unlock PDF in place reads the stored file itself and is not encrypted again', async () => {
    const write = jest.fn(async (source: string, out: string) => {
      mockFs.set(out, `clear(${mockFs.get(source)})`);
      return 4;
    });
    await rewriteStoredPdf('d1', write, 4, { removesPassword: true });
    expect(write).toHaveBeenCalledWith(PDF, expect.stringMatching(/after\.pdf$/));
    expect(mockNative.protectPdf).not.toHaveBeenCalled();
    expect(mockFs.get(PDF)).toBe('clear(enc(pw1:v1))');
  });

  test('split and merge read the session copy; their results need no password', async () => {
    const { first } = await splitStoredPdf('d1', 1);
    expect(mockFs.get(first.pdfUri!)).toBe('edit(v1|0,1|0,0)');
    const merged = await mergeDocumentsToPdf([mockDocs.get('d1'), { id: 'x', name: 'X', pages: ['p.jpg'], createdAt: 1, updatedAt: 1 }], 'M');
    expect(mockFs.get(merged.pdfUri!)).toBe('merge(v1+scan(1))');
    expect(mockFs.get(PDF)).toBe('enc(pw1:v1)');
  });
});

describe('keeping the protection exactly (round 14 critic fixes)', () => {
  const ENC = /^enc\(([^:]+):(.*)\)$/;
  const ALL = { printLow: true, printHigh: true, changeContent: true, assemblePages: true, copy: true, accessibility: true, comment: true, fillForms: true };
  let info: any;

  beforeEach(async () => {
    resetPdfSessionsForTests();
    mockFs.set(PDF, 'enc(pw1:v1)');
    mockDocs.set('d1', { id: 'd1', name: 'Lease', pages: [], pdfUri: PDF, createdAt: 1, updatedAt: 1 });
    mockNative.unlockPdf = jest.fn(async (inp: string, out: string, pw: string) => {
      const m = ENC.exec(mockFs.get(inp) ?? '');
      if (!m || m[1] !== pw) throw new Error('wrong-password');
      mockFs.set(out, m[2]);
      return out;
    });
    mockNative.protectPdf = jest.fn(async (inp: string, out: string, pw: string) => { mockFs.set(out, `enc(${pw}:${mockFs.get(inp)})`); return out; });
    mockNative.protectPdfKeeping = jest.fn(async (inp: string, out: string, pw: string, owner: string | null, bits: number) => {
      mockFs.set(out, `enc(${pw}:${mockFs.get(inp)})`);
      void owner; void bits;
      return out;
    });
    info = { pageCount: 4, encrypted: true, locked: false, passwordAccepted: true, ownerUnlocked: false, userPassword: true, permissionBits: 129, permissions: { ...ALL, printHigh: false, assemblePages: false, copy: false, comment: false } };
    mockNative.pdfPermissions = jest.fn(async () => info);
    mockNative.pdfInfo.mockImplementation(async (uri: string, password?: string | null) => {
      const m = ENC.exec(mockFs.get(uri) ?? '');
      return { pageCount: 4, locked: !!m && password !== m[1], encrypted: !!m };
    });
  });

  afterAll(() => {
    delete mockNative.unlockPdf;
    delete mockNative.protectPdf;
    delete mockNative.protectPdfKeeping;
    delete mockNative.pdfPermissions;
    resetPdfSessionsForTests();
  });

  const fill = () => rewriteStoredPdf('d1', async (src, out) => { mockFs.set(out, `filled(${mockFs.get(src)})`); return 4; }, 4, { needs: ['fillForms'] });

  test('reprotectPlan: keep exactly when it can; never weaken', () => {
    expect(reprotectPlan({ mode: 'user', bits: 129 }, true, true)).toEqual({ how: 'keep', owner: 'random', bits: 129 });
    expect(reprotectPlan({ mode: 'same', bits: 255 }, false, true)).toEqual({ how: 'keep', owner: 'same', bits: 255 });
    expect(reprotectPlan({ mode: 'owner-only' }, false, true)).toEqual({ how: 'refuse', why: 'owner-password' });
    // A build without protectPdfKeeping: user = owner = password only when that loses nothing.
    expect(reprotectPlan({ mode: 'same', bits: 0 }, true, false)).toEqual({ how: 'same' });
    expect(reprotectPlan({ mode: 'user', bits: 255 }, false, false)).toEqual({ how: 'same' });
    expect(reprotectPlan({ mode: 'user', bits: 129 }, true, false)).toEqual({ how: 'refuse', why: 'keep-unavailable' });
  });

  test('opened with the open password: written back with it, a random owner password and the author\'s bits', async () => {
    await unlockForSession({ id: 'd1', pdfUri: PDF }, 'pw1');
    await fill();
    expect(mockNative.protectPdfKeeping).toHaveBeenCalledWith(expect.stringMatching(/pdf-session/), expect.stringMatching(/after\.pdf$/), 'pw1', null, 129);
    expect(mockNative.protectPdf).not.toHaveBeenCalled();
    expect(mockFs.get(PDF)).toBe('enc(pw1:filled(v1))');
  });

  test('user = owner (Scan Kit\'s own Protect PDF): the same password stays the owner password', async () => {
    info = { ...info, ownerUnlocked: true, userPassword: true, permissionBits: 255, permissions: ALL };
    await unlockForSession({ id: 'd1', pdfUri: PDF }, 'pw1');
    await fill();
    expect(mockNative.protectPdfKeeping).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'pw1', 'pw1', 255);
  });

  test('opened with the OWNER password: in-place edits are refused, pointing to Unlock PDF', async () => {
    info = { ...info, ownerUnlocked: true, userPassword: false, permissions: ALL };
    await unlockForSession({ id: 'd1', pdfUri: PDF }, 'pw1');
    const err = await fill().catch(e => e);
    expect(err).toMatchObject({ kind: 'restricted', message: 'owner-password' });
    expect(protectedEditRefusal(err)?.body).toMatch(/Unlock PDF/);
    expect(mockFs.get(PDF)).toBe('enc(pw1:v1)');
    // Unknown (the check couldn't read the file) counts as the owner password.
    resetPdfSessionsForTests();
    info = { ...info, userPassword: null };
    await unlockForSession({ id: 'd1', pdfUri: PDF }, 'pw1');
    await expect(fill()).rejects.toMatchObject({ message: 'owner-password' });
  });

  test('a build without protectPdfKeeping refuses a restricted PDF rather than weaken it', async () => {
    const keep = mockNative.protectPdfKeeping;
    delete mockNative.protectPdfKeeping;
    try {
      await unlockForSession({ id: 'd1', pdfUri: PDF }, 'pw1');
      await expect(fill()).rejects.toMatchObject({ kind: 'restricted', message: 'keep-unavailable' });
      expect(mockNative.protectPdf).not.toHaveBeenCalled();
      expect(mockFs.get(PDF)).toBe('enc(pw1:v1)');
    } finally {
      mockNative.protectPdfKeeping = keep;
    }
  });

  test('a write that fails after the plaintext was made leaves no plaintext anywhere', async () => {
    await unlockForSession({ id: 'd1', pdfUri: PDF }, 'pw1');
    mockNative.protectPdfKeeping.mockRejectedValueOnce(new Error('Protection could not be verified'));
    await expect(fill()).rejects.toMatchObject({ kind: 'failed' });
    expect([...mockFs.entries()].filter(([f, v]) => /filled\(v1\)/.test(v) && !/^enc/.test(v)).map(([f]) => f)).toEqual([]);
    expect(mockFs.get(PDF)).toBe('enc(pw1:v1)');
  });
});
