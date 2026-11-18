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
import { getExportPageNumbers, setExportPageNumbers } from '../lib/export-prefs';

test('off until chosen, then remembered; anything unknown reads as off', async () => {
  expect(await getExportPageNumbers()).toBe('off');
  await setExportPageNumbers('of-total');
  expect(await getExportPageNumbers()).toBe('of-total');
  mockStore.set('@scan_kit_export_page_numbers', 'roman');
  expect(await getExportPageNumbers()).toBe('off');
});
