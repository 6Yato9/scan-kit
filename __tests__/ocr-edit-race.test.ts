// __tests__/ocr-edit-race.test.ts
// OCR indexing (and the auto-rename it does) finishes at an unpredictable
// moment, often while the user is already editing the new scan. A page edit
// reads the record, works for a while (rotate, crop, copy pages), then writes
// the record back. If the OCR write lands in between, the edit's write must not
// undo it. Runs the REAL storage, page lock and indexDocText; only native
// modules and files are faked.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-file-system', () => {
  class MockFile {
    uri: string;
    constructor(uri: any, name?: string) { this.uri = name ? `${uri?.uri ?? uri}/${name}` : String(uri?.uri ?? uri); }
    get exists() { return true; }
    delete() {}
  }
  class MockDirectory extends MockFile {}
  return { File: MockFile, Directory: MockDirectory, Paths: { document: { uri: 'file:///docs/' } } };
});
jest.mock('expo-file-system/legacy', () => ({ writeAsStringAsync: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'doc-1' }));
jest.mock('../lib/files', () => ({
  originalUri: (id: string, i: number) => `file:///docs/scan-kit/${id}/page-${i}.orig.jpg`,
  deleteDocumentFiles: jest.fn(),
  copyPageWithQuality: jest.fn(async (_u: string, id: string, i: number) => `file:///docs/scan-kit/${id}/page-${i}.jpg`),
  copyPdfToStorage: jest.fn(),
  deleteDisposableTemps: jest.fn(),
  ensureOriginal: jest.fn(),
  pageSideUri: jest.fn(),
  promotePageSide: jest.fn(),
  isScannerOutput: () => true,
}));
jest.mock('../lib/image', () => ({ capStoredPageSize: jest.fn(async () => false) }));
jest.mock('../lib/document-detect', () => ({ autoCropDocument: jest.fn(async (uri: string) => ({ uri })) }));

// OCR resolves when the test says so.
let mockFinishOcr: (text: string) => void = () => {};
jest.mock('../lib/ocr', () => ({
  ocrAvailable: () => true,
  extractDocText: () => new Promise<string>(resolve => { mockFinishOcr = resolve; }),
}));

import { getDocument, getDocuments, updateDocument } from '../lib/storage';
import { runPageEdit } from '../lib/bake';
import { indexDocText, saveScan } from '../lib/save-scan';
import { addPagesToDocument } from '../lib/add-pages';

const tick = () => new Promise(r => setTimeout(r, 0));

async function newScan() {
  const { id, pages } = await saveScan({
    pages: ['file:///tmp/DOCUMENT_SCAN_0.jpg', 'file:///tmp/DOCUMENT_SCAN_1.jpg'],
    name: 'Scan 18 Nov 2026 at 01:37',
    nameIsDefault: true,
    quality: 0.9,
  });
  return { id, pages };
}

/**
 * The viewer's editDocument (app/viewer.tsx): under the page lock, read the
 * current record, do slow work, then write the WHOLE record back.
 */
function viewerRotate(id: string, slowWork: Promise<void>) {
  return runPageEdit(id, { pages: [1] }, async () => {
    const fresh = (await getDocuments()).find(d => d.id === id)!;
    await slowWork;
    await updateDocument({ ...fresh, pages: [...fresh.pages], updatedAt: Date.now() });
  });
}

test('OCR that finishes during a viewer page edit keeps its title and text', async () => {
  const { id, pages } = await newScan();
  const ocr = indexDocText(id, pages);
  await tick();

  let finishRotate!: () => void;
  const rotate = viewerRotate(id, new Promise<void>(r => { finishRotate = r; }));
  await tick();
  // OCR lands while the rotate is between its read and its write.
  mockFinishOcr('INVOICE #2026-0417\nAcme Supplies');
  await tick();
  finishRotate();
  await Promise.all([rotate, ocr]);

  const doc = await getDocument(id);
  expect(doc!.name).toBe('Invoice #2026-0417');
  expect(doc!.ocrText).toContain('Acme Supplies');
  expect(doc!.defaultName).toBeUndefined();
});

test('OCR that finishes while pages are being added keeps its title and text', async () => {
  const { id, pages } = await newScan();
  const ocr = indexDocText(id, pages);
  await tick();
  const add = addPagesToDocument(id, ['file:///tmp/DOCUMENT_SCAN_2.jpg'], 0.9);
  mockFinishOcr('Residential Lease Agreement');
  await Promise.all([add, ocr]);

  const doc = await getDocument(id);
  expect(doc!.pages).toHaveLength(3);
  expect(doc!.name).toBe('Residential Lease Agreement');
  expect(doc!.ocrText).toBe('Residential Lease Agreement');
});

test('a rename the user makes before OCR lands still wins', async () => {
  const { id, pages } = await newScan();
  const ocr = indexDocText(id, pages);
  await tick();
  const doc = await getDocument(id);
  await updateDocument({ ...doc!, name: 'My taxes' });
  mockFinishOcr('INVOICE #2026-0417');
  await ocr;
  expect((await getDocument(id))!.name).toBe('My taxes');
});
