// lib/export-prefs.ts
// Remembered export choices (components/export-sheet.tsx). Only additive keys
// of their own: nothing here touches the document records or other settings.
import { PAGE_NUMBER_STYLES, type PageNumberStyle } from './pdf';

const PAGE_NUMBERS_KEY = '@scan_kit_export_page_numbers';

type Store = { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void> };

/**
 * AsyncStorage, loaded on first use: a remembered preference must never stop
 * the export sheet from loading (a test or a build without the module just
 * forgets the choice).
 */
function store(): Store | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@react-native-async-storage/async-storage');
    return (mod.default ?? mod) as Store;
  } catch {
    return null;
  }
}

/** The page-number style last chosen in the export sheet ('off' until one is). Never throws. */
export async function getExportPageNumbers(): Promise<PageNumberStyle> {
  try {
    const raw = await store()?.getItem(PAGE_NUMBERS_KEY);
    return PAGE_NUMBER_STYLES.includes(raw as PageNumberStyle) ? (raw as PageNumberStyle) : 'off';
  } catch {
    return 'off';
  }
}

/** Remembers the page-number style. Best effort. */
export async function setExportPageNumbers(style: PageNumberStyle): Promise<void> {
  try {
    await store()?.setItem(PAGE_NUMBERS_KEY, style);
  } catch {}
}
