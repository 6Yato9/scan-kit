// The export sheet's remembered page-number choice (lib/export-prefs.ts).
const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItem: jest.fn(async (k: string, v: string) => { mockStore.set(k, v); }),
}));
jest.mock('expo-file-system/legacy', () => ({ readAsStringAsync: jest.fn(), deleteAsync: jest.fn() }));
jest.mock('expo-print', () => ({ printToFileAsync: jest.fn() }));
jest.mock('expo-image-manipulator', () => ({ manipulateAsync: jest.fn(), SaveFormat: { JPEG: 'jpeg' } }));
jest.mock('../lib/ocr', () => ({ recognizeLines: jest.fn() }));
import {
  DEFAULT_EXPORT_LAYOUT,
  getExportLayout,
  getExportPageNumbers,
  isDefaultLayout,
  layoutSummary,
  parseExportLayout,
  setExportLayout,
  setExportPageNumbers,
} from '../lib/export-prefs';

test('off until chosen, then remembered; anything unknown reads as off', async () => {
  expect(await getExportPageNumbers()).toBe('off');
  await setExportPageNumbers('of-total');
  expect(await getExportPageNumbers()).toBe('of-total');
  mockStore.set('@scan_kit_export_page_numbers', 'roman');
  expect(await getExportPageNumbers()).toBe('off');
});

test('PDF layout: defaults until chosen, then remembered', async () => {
  expect(await getExportLayout()).toEqual(DEFAULT_EXPORT_LAYOUT);
  const chosen = { ...DEFAULT_EXPORT_LAYOUT, paper: 'Legal' as const, margin: 'wide' as const, searchable: false };
  await setExportLayout(chosen);
  expect(await getExportLayout()).toEqual(chosen);
});

test('PDF layout: a damaged or future value falls back field by field', () => {
  expect(parseExportLayout(null)).toEqual(DEFAULT_EXPORT_LAYOUT);
  expect(parseExportLayout('not json')).toEqual(DEFAULT_EXPORT_LAYOUT);
  expect(parseExportLayout('[1,2]')).toEqual(DEFAULT_EXPORT_LAYOUT);
  expect(parseExportLayout(JSON.stringify({ paper: 'A3', margin: 'small', quality: 'ultra', searchable: 'yes', extra: 1 }))).toEqual({
    ...DEFAULT_EXPORT_LAYOUT,
    margin: 'small',
  });
  expect(parseExportLayout(JSON.stringify({ paper: 'Letter', orientation: 'landscape', numberPosition: 'top-right' }))).toMatchObject({
    paper: 'Letter',
    orientation: 'landscape',
    numberPosition: 'top-right',
  });
});

test('PDF layout summary', () => {
  expect(isDefaultLayout(DEFAULT_EXPORT_LAYOUT)).toBe(true);
  expect(layoutSummary(DEFAULT_EXPORT_LAYOUT, 'A4')).toBe('A4 · Standard quality');
  expect(layoutSummary({ ...DEFAULT_EXPORT_LAYOUT, orientation: 'landscape' }, 'Auto')).toBe('Auto paper · Standard quality');
  const l = { ...DEFAULT_EXPORT_LAYOUT, paper: 'Letter' as const, orientation: 'landscape' as const, margin: 'normal' as const, quality: 'high' as const, searchable: false };
  expect(isDefaultLayout(l)).toBe(false);
  expect(layoutSummary(l, 'Letter')).toBe('US Letter · Landscape · Medium margins · High quality · Not searchable');
  expect(layoutSummary(l, 'Letter', false)).toBe('US Letter · Landscape · Medium margins · High quality');
});
