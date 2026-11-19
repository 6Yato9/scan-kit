// Round 16 review fixes, export paper and text layer: Share, Print, Protect
// PDF and Create PDF follow Document settings' paper unless the PDF options
// chose another, and a stored paper equal to Document settings' behaves as
// "Same as Document settings" (lib/export-prefs.ts, lib/pdf-protect.ts
// buildScanPdf). Protect PDF honours "Searchable text: Off".
const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItem: jest.fn(async (k: string, v: string) => {
    mockStore.set(k, v);
  }),
}));
const mockSettings = { pdfPageSize: 'A4' as string };
jest.mock('../lib/storage', () => ({
  getDocSettings: jest.fn(async () => ({ pdfPageSize: mockSettings.pdfPageSize, pdfQuality: 'standard' })),
  getDocument: jest.fn(),
  saveDocument: jest.fn(),
  deleteDocument: jest.fn(),
}));
const mockGenerate = jest.fn(async (..._a: unknown[]) => 'file:///tmp/out.pdf');
jest.mock('../lib/pdf', () => ({ ...jest.requireActual('../lib/pdf'), generatePdf: (...a: unknown[]) => mockGenerate(...a) }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'id-1' }));
jest.mock('../modules/vision-ocr/src', () => ({ VisionOcr: null }));
jest.mock('../lib/ocr', () => ({ ocrAvailable: () => true, recognizeLines: jest.fn() }));
jest.mock('../lib/bake', () => ({ BakeWaitAborted: class extends Error {}, waitForPendingBakes: jest.fn(), withDocLock: jest.fn() }));
jest.mock('../lib/files', () => ({ copyPdfToStorage: jest.fn(), deleteDocumentFiles: jest.fn() }));
jest.mock('../lib/pdf-edit', () => ({ PdfEditError: class extends Error {}, rewriteStoredPdf: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ readAsStringAsync: jest.fn(), deleteAsync: jest.fn() }));
jest.mock('expo-print', () => ({ printToFileAsync: jest.fn() }));
jest.mock('expo-image-manipulator', () => ({ manipulateAsync: jest.fn(), SaveFormat: { JPEG: 'jpeg' } }));

import {
  DEFAULT_EXPORT_LAYOUT,
  followDocPaper,
  getExportLayout,
  loadExportLayout,
  paperOverride,
  setExportLayout,
} from '../lib/export-prefs';
import { buildScanPdf } from '../lib/pdf-protect';
import { smallerPdfChoice, smallerPdfIsSmaller, SMALLEST_EDGE } from '../lib/compress-pdf';
import type { PageSize } from '../lib/pdf';

const KEY = '@scan_kit_export_layout';
const docPaper = async () => mockSettings.pdfPageSize as PageSize;
const lastCall = () => mockGenerate.mock.calls[mockGenerate.mock.calls.length - 1][1] as Record<string, unknown>;

beforeEach(() => {
  mockStore.clear();
  mockGenerate.mockClear();
  mockSettings.pdfPageSize = 'A4';
});

describe('paper: only a different paper is pinned', () => {
  test('choosing Document settings’ own paper, or "Same as", stores none', () => {
    expect(paperOverride('A4', 'A4')).toBeNull();
    expect(paperOverride(null, 'A4')).toBeNull();
    expect(paperOverride('Letter', 'A4')).toBe('Letter');
    expect(paperOverride('Auto', 'A4')).toBe('Auto');
    expect(paperOverride('Auto', 'Auto')).toBeNull();
  });

  test('a stored paper equal to Document settings’ reads as "Same as Document settings"', () => {
    const pinned = { ...DEFAULT_EXPORT_LAYOUT, paper: 'A4' as const, margin: 'wide' as const };
    expect(followDocPaper(pinned, 'A4')).toEqual({ ...pinned, paper: null });
    expect(followDocPaper(pinned, 'Letter')).toBe(pinned);
    expect(followDocPaper(DEFAULT_EXPORT_LAYOUT, 'A4')).toBe(DEFAULT_EXPORT_LAYOUT);
  });

  test('existing stored values still load; an equal one is stored as "Same as" from then on', async () => {
    mockStore.set(KEY, JSON.stringify({ paper: 'A4', margin: 'small', quality: 'high' }));
    const l = await loadExportLayout(docPaper);
    expect(l).toMatchObject({ paper: null, margin: 'small', quality: 'high' });
    expect(await getExportLayout()).toMatchObject({ paper: null, margin: 'small', quality: 'high' });
    // A different paper stays chosen.
    mockStore.set(KEY, JSON.stringify({ paper: 'Legal' }));
    expect((await loadExportLayout(docPaper)).paper).toBe('Legal');
    // Settings unreadable: the stored value as it is.
    mockStore.set(KEY, JSON.stringify({ paper: 'A4' }));
    expect((await loadExportLayout(async () => null)).paper).toBe('A4');
    expect((await loadExportLayout(async () => { throw new Error('x'); })).paper).toBe('A4');
  });
});

describe('Share, Print and Protect PDF follow Document settings unless the PDF options chose another', () => {
  test('no paper chosen: Document settings’ paper, read fresh', async () => {
    await buildScanPdf(['p1'], { searchable: true });
    expect(lastCall().pageSize).toBe('A4');
    // Document settings changed: the next PDF follows it.
    mockSettings.pdfPageSize = 'Letter';
    await buildScanPdf(['p1'], { searchable: true });
    expect(lastCall().pageSize).toBe('Letter');
  });

  test('touching the paper choice with the same paper doesn’t pin it (the reported bug)', async () => {
    // The user taps "A4" while Document settings says A4…
    await setExportLayout({ ...DEFAULT_EXPORT_LAYOUT, paper: paperOverride('A4', 'A4') });
    // …then changes Document settings to US Letter.
    mockSettings.pdfPageSize = 'Letter';
    await buildScanPdf(['p1'], { searchable: true });
    expect(lastCall().pageSize).toBe('Letter');
  });

  test('a different paper chosen in the PDF options wins', async () => {
    await setExportLayout({ ...DEFAULT_EXPORT_LAYOUT, paper: 'Legal' });
    await buildScanPdf(['p1'], { searchable: true });
    expect(lastCall().pageSize).toBe('Legal');
  });

  test('Protect PDF honours "Searchable text: Off" from the PDF options', async () => {
    await buildScanPdf(['p1'], { searchable: true });
    expect(lastCall().searchable).toBe(true);
    await setExportLayout({ ...DEFAULT_EXPORT_LAYOUT, searchable: false });
    await buildScanPdf(['p1'], { searchable: true });
    expect(lastCall().searchable).toBe(false);
    // And the sheet's own layout is honoured the same way.
    await buildScanPdf(['p1'], { searchable: true, layout: { ...DEFAULT_EXPORT_LAYOUT, searchable: false } });
    expect(lastCall().searchable).toBe(false);
    // No text recognition: never searchable.
    await setExportLayout(DEFAULT_EXPORT_LAYOUT);
    await buildScanPdf(['p1'], { searchable: false });
    expect(lastCall().searchable).toBe(false);
  });
});

describe('Export › Smaller PDF is always smaller than PDF', () => {
  const pages = Array.from({ length: 4 }, () => ({ bytes: 1_400_000, width: 3024, height: 4032 }));

  test('a step below the PDF row’s quality — Smallest when the PDF is already small', () => {
    expect(smallerPdfChoice('standard')).toEqual({ quality: 'small' });
    expect(smallerPdfChoice('high')).toEqual({ quality: 'small' });
    expect(smallerPdfChoice('small')).toEqual({ quality: 'small', maxEdge: SMALLEST_EDGE });
    for (const q of ['high', 'standard', 'small'] as const) expect(smallerPdfIsSmaller(pages, q, true)).toBe(true);
  });

  test('pages already tiny: not offered (it would be the same file); unknown sizes: offered', () => {
    const tiny = [{ bytes: 20_000, width: 600, height: 800 }];
    expect(smallerPdfIsSmaller(tiny, 'small', false)).toBe(false);
    expect(smallerPdfIsSmaller(null, 'small', false)).toBe(true);
  });

  test('the Smaller PDF build passes its size on', async () => {
    const s = smallerPdfChoice('small');
    await buildScanPdf(['p1'], { searchable: true, quality: s.quality, maxEdge: s.maxEdge });
    expect(lastCall()).toMatchObject({ quality: 'small', maxEdge: SMALLEST_EDGE });
  });
});
