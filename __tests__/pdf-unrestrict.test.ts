// __tests__/pdf-unrestrict.test.ts
// "Unlock PDF" (lib/pdf-unrestrict.ts): restrictions in plain words, the
// state the screen shows, and the two ways of saving (a new document, or the
// stored PDF replaced through lib/pdf-edit's rewrite with Undo). Native
// PDFKit is mocked; the file system is an in-memory map of URI -> content.
const mockFs = new Map<string, string>();
jest.mock('expo-file-system', () => {
  const part = (p: any) => (p && typeof p === 'object' ? p.uri : p);
  const strip = (u: string) => u.replace(/\/+$/, '');
  class MockFile {
    uri: string;
    constructor(...parts: any[]) { this.uri = parts.map(part).map(strip).join('/'); }
    get exists() { return mockFs.has(this.uri); }
    delete() { mockFs.delete(this.uri); }
  }
  class MockDirectory {
    uri: string;
    constructor(...parts: any[]) { this.uri = parts.map(part).map(strip).join('/'); }
    create() {}
  }
  return { File: MockFile, Directory: MockDirectory, Paths: { cache: { uri: 'file:///caches' } } };
});

let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `new-${++mockUuid}` }));

const ALL = { printLow: true, printHigh: true, changeContent: true, assemblePages: true, copy: true, accessibility: true, comment: true, fillForms: true };
const NONE = Object.fromEntries(Object.keys(ALL).map(k => [k, false])) as typeof ALL;
// Per stored PDF: its open password ('' = none) and permissions.
const mockPdfs = new Map<string, { password: string; encrypted: boolean; permissions: typeof ALL; pages: number }>();

const mockNative: any = {
  pdfPermissions: jest.fn(async (uri: string, password?: string | null) => {
    const pdf = mockPdfs.get(uri);
    if (!pdf) throw Object.assign(new Error('Could not open the PDF'), { code: 'ERR_PDF_INFO' });
    const needs = !!pdf.password;
    const accepted = needs && password === pdf.password;
    const locked = needs && !accepted;
    return { pageCount: pdf.pages, encrypted: pdf.encrypted, locked, passwordAccepted: accepted, permissions: locked ? NONE : pdf.permissions };
  }),
  unrestrictPdf: jest.fn(async (inp: string, out: string, password?: string | null) => {
    const pdf = mockPdfs.get(inp);
    if (!pdf) throw Object.assign(new Error('Could not open the PDF'), { code: 'ERR_PDF_UNRESTRICT' });
    if (pdf.password && !password) throw Object.assign(new Error('locked'), { code: 'ERR_PDF_LOCKED' });
    if (pdf.password && password !== pdf.password) throw Object.assign(new Error('wrong-password'), { code: 'ERR_PDF_PASSWORD' });
    mockFs.set(out, `clear(${mockFs.get(inp)})`);
    return { pageCount: pdf.pages, encrypted: false, method: 'rewrite' };
  }),
  pdfPageTexts: jest.fn(async (uri: string) => [`text of ${mockFs.get(uri)}`]),
};
jest.mock('../modules/vision-ocr/src', () => ({ get VisionOcr() { return mockNative; } }));

const mockDocs = new Map<string, any>();
jest.mock('../lib/storage', () => ({
  getDocument: jest.fn(async (id: string) => (mockDocs.has(id) ? { ...mockDocs.get(id) } : null)),
  saveDocument: jest.fn(async (doc: any) => { mockDocs.set(doc.id, { ...doc }); }),
  deleteDocument: jest.fn(async (id: string) => { mockDocs.delete(id); }),
}));
jest.mock('../lib/bake', () => ({ withDocLock: (_id: string, fn: () => unknown) => Promise.resolve().then(fn) }));
jest.mock('../lib/files', () => ({
  copyPdfToStorage: (tmp: string, id: string) => {
    const dest = `file:///support/scan-kit/${id}/document.pdf`;
    mockFs.set(dest, mockFs.get(tmp)!);
    return dest;
  },
  deleteDocumentFiles: jest.fn(),
}));
// The in-place swap is lib/pdf-edit's (tested in pdf-edit.test.ts): here it
// runs the write and reports what it was asked.
const mockRewrite = jest.fn(async (docId: string, write: (t: string, o: string) => Promise<number>, expected: number) => {
  const target = mockDocs.get(docId).pdfUri.split('?')[0];
  const n = await write(target, 'file:///support/pdf-edit/after.pdf');
  if (n !== expected) throw new (jest.requireActual('../lib/pdf-edit').PdfEditError)('failed', 'edit not verified');
  mockFs.set(target, mockFs.get('file:///support/pdf-edit/after.pdf')!);
  return { doc: mockDocs.get(docId), pageCount: n, undo: { docId } };
});
jest.mock('../lib/pdf-edit', () => {
  const actual = jest.requireActual('../lib/pdf-edit');
  return { PdfEditError: actual.PdfEditError, rewriteStoredPdf: (...a: any[]) => (mockRewrite as any)(...a) };
});

import {
  canUnrestrictPdf,
  checkPdfPassword,
  PdfUnrestrictError,
  readPdfRestrictions,
  restrictionsOf,
  restrictionStateOf,
  saveUnrestrictedCopy,
  unrestrictedName,
  unrestrictStoredPdf,
} from '../lib/pdf-unrestrict';

const PDF = 'file:///support/scan-kit/d1/document.pdf';

beforeEach(() => {
  jest.clearAllMocks();
  mockFs.clear();
  mockDocs.clear();
  mockPdfs.clear();
  mockUuid = 0;
  mockFs.set(PDF, 'v1');
  mockDocs.set('d1', { id: 'd1', name: 'Statement', pages: [], pdfUri: `${PDF}?v=2`, folder: 'Bank', createdAt: 1, updatedAt: 1 });
  mockPdfs.set(PDF, { password: '', encrypted: true, permissions: { ...ALL, copy: false, printLow: false, printHigh: false }, pages: 3 });
});

describe('restrictions in plain words', () => {
  test('nothing forbidden, nothing listed', () => {
    expect(restrictionsOf(ALL)).toEqual([]);
  });

  test('every bit off lists each restriction once, printing as one', () => {
    expect(restrictionsOf(NONE)).toEqual(['print', 'copy', 'pages', 'edit', 'comment', 'forms', 'accessibility']);
  });

  test('low-quality printing only says "full quality"', () => {
    expect(restrictionsOf({ ...ALL, printHigh: false })).toEqual(['printQuality']);
  });

  test('state: unencrypted, all-permission and empty-permission PDFs', () => {
    const base = { pageCount: 2, locked: false, passwordAccepted: false };
    expect(restrictionStateOf({ ...base, encrypted: false, permissions: ALL }).kind).toBe('unrestricted');
    // Encrypted but granting everything, no open password: nothing to remove.
    expect(restrictionStateOf({ ...base, encrypted: true, permissions: ALL }).kind).toBe('unrestricted');
    expect(restrictionStateOf({ ...base, encrypted: true, permissions: { ...ALL, comment: false } })).toEqual({
      kind: 'restricted', pageCount: 2, restrictions: ['comment'],
    });
    expect(restrictionStateOf({ ...base, encrypted: true, locked: true, permissions: NONE }).kind).toBe('password');
    // Opened with the typed password: removing it is the point, even with no other restriction.
    expect(restrictionStateOf({ ...base, encrypted: true, passwordAccepted: true, permissions: ALL })).toEqual({
      kind: 'restricted', pageCount: 2, restrictions: [],
    });
  });

  test('the copy is named once', () => {
    expect(unrestrictedName('Lease')).toBe('Lease (unrestricted)');
    expect(unrestrictedName('Lease (unrestricted)')).toBe('Lease (unrestricted)');
    expect(unrestrictedName('  ')).toBe('Document (unrestricted)');
  });
});

describe('reading', () => {
  test('feature-checks the build', () => {
    expect(canUnrestrictPdf()).toBe(true);
    const saved = mockNative.unrestrictPdf;
    mockNative.unrestrictPdf = undefined;
    expect(canUnrestrictPdf()).toBe(false);
    mockNative.unrestrictPdf = saved;
  });

  test('reads the stored file without its cache-bust', async () => {
    const { state } = await readPdfRestrictions(mockDocs.get('d1'));
    expect(mockNative.pdfPermissions).toHaveBeenCalledWith(PDF, null);
    expect(state).toEqual({ kind: 'restricted', pageCount: 3, restrictions: ['print', 'copy'] });
  });

  test('an unreadable file is "unreadable"', async () => {
    mockPdfs.clear();
    await expect(readPdfRestrictions(mockDocs.get('d1'))).rejects.toMatchObject({ kind: 'unreadable' });
  });

  test('checkPdfPassword tells a wrong password apart', async () => {
    mockPdfs.set(PDF, { password: 'open', encrypted: true, permissions: ALL, pages: 3 });
    await expect(checkPdfPassword(mockDocs.get('d1'), 'nope')).rejects.toMatchObject({ kind: 'wrong-password' });
    await expect(checkPdfPassword(mockDocs.get('d1'), '')).rejects.toMatchObject({ kind: 'wrong-password' });
    await expect(checkPdfPassword(mockDocs.get('d1'), 'open')).resolves.toMatchObject({ kind: 'restricted' });
  });
});

describe('saving as a new document', () => {
  test('a new "(unrestricted)" document in the same folder; the original untouched', async () => {
    const copy = await saveUnrestrictedCopy('d1');
    expect(copy).toMatchObject({ id: 'new-1', name: 'Statement (unrestricted)', pages: [], folder: 'Bank', ocrText: 'text of clear(v1)' });
    expect(mockFs.get('file:///support/scan-kit/new-1/document.pdf')).toBe('clear(v1)');
    expect(mockFs.get(PDF)).toBe('v1');
    expect(mockDocs.get('d1').pdfUri).toBe(`${PDF}?v=2`);
    // The work file is gone.
    expect([...mockFs.keys()].filter(k => k.startsWith('file:///caches/'))).toEqual([]);
  });

  test('a PDF that needs a password: passed through; without it nothing is created', async () => {
    mockPdfs.set(PDF, { password: 'open', encrypted: true, permissions: ALL, pages: 3 });
    await expect(saveUnrestrictedCopy('d1')).rejects.toMatchObject({ kind: 'locked' });
    await expect(saveUnrestrictedCopy('d1', 'bad')).rejects.toMatchObject({ kind: 'wrong-password' });
    expect(mockDocs.size).toBe(1);
    const copy = await saveUnrestrictedCopy('d1', 'open');
    expect(mockNative.unrestrictPdf).toHaveBeenLastCalledWith(PDF, expect.stringMatching(/^file:\/\/\/caches\/pdf-convert\/unrestrict-/), 'open');
    expect(mockDocs.get(copy.id).name).toBe('Statement (unrestricted)');
  });

  test('a failed write creates nothing and says "failed"', async () => {
    mockNative.unrestrictPdf.mockRejectedValueOnce(Object.assign(new Error('Could not write an unrestricted copy'), { code: 'ERR_PDF_UNRESTRICT' }));
    const err = await saveUnrestrictedCopy('d1').catch(e => e);
    expect(err).toBeInstanceOf(PdfUnrestrictError);
    expect(err.kind).toBe('failed');
    expect(mockDocs.size).toBe(1);
  });

  test('a scanned document (pages, no PDF) is refused', async () => {
    mockDocs.set('s1', { id: 's1', name: 'Scan', pages: ['file:///p1.jpg'], createdAt: 1, updatedAt: 1 });
    await expect(saveUnrestrictedCopy('s1')).rejects.toMatchObject({ kind: 'changed' });
  });
});

describe('replacing in place', () => {
  test('goes through rewriteStoredPdf with the page count it read', async () => {
    const result = await unrestrictStoredPdf('d1');
    expect(mockRewrite).toHaveBeenCalledWith('d1', expect.any(Function), 3);
    expect(mockFs.get(PDF)).toBe('clear(v1)');
    expect(result.undo).toEqual({ docId: 'd1' });
  });

  test('a wrong or missing password is caught before anything is written', async () => {
    mockPdfs.set(PDF, { password: 'open', encrypted: true, permissions: ALL, pages: 3 });
    await expect(unrestrictStoredPdf('d1', 'bad')).rejects.toMatchObject({ kind: 'wrong-password' });
    await expect(unrestrictStoredPdf('d1')).rejects.toMatchObject({ kind: 'locked' });
    expect(mockRewrite).not.toHaveBeenCalled();
    await unrestrictStoredPdf('d1', 'open');
    expect(mockFs.get(PDF)).toBe('clear(v1)');
  });

  test('a page-count mismatch leaves it as it was', async () => {
    mockNative.unrestrictPdf.mockResolvedValueOnce({ pageCount: 2, encrypted: false, method: 'rewrite' });
    await expect(unrestrictStoredPdf('d1')).rejects.toMatchObject({ kind: 'failed' });
    expect(mockFs.get(PDF)).toBe('v1');
  });

  test('a document in Recently deleted is "missing"', async () => {
    mockDocs.set('d1', { ...mockDocs.get('d1'), trashedAt: 5 });
    await expect(unrestrictStoredPdf('d1')).rejects.toMatchObject({ kind: 'missing' });
  });
});
