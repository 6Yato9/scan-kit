// lib/export-prefs.ts
// Remembered export choices (components/export-sheet.tsx). Only additive keys
// of their own: nothing here touches the document records or other settings.
import {
  PAGE_NUMBER_POSITIONS,
  PAGE_NUMBER_STYLES,
  PDF_MARGINS,
  PDF_ORIENTATIONS,
  type PageNumberPosition,
  type PageNumberStyle,
  type PageSize,
  type PdfMargin,
  type PdfOrientation,
  type PdfQuality,
} from './pdf';

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

// ── PDF layout (round 16) ────────────────────────────────────────────────────
//
// The export sheet's "PDF options": paper, orientation, margins, image
// quality, where the page number sits, and the text layer. Stored as one JSON
// value under a key of its own; every field is validated on read, so a value
// from a later version (or a damaged one) falls back field by field to the
// default, which is exactly how exports looked before these options existed.
// `paper: null` means "Same as Document settings" (the old behaviour, and the
// default): only a paper other than Document settings' is ever stored, so
// changing Document settings changes every export that hasn't chosen another.

export type ExportLayout = {
  paper: PageSize | null;
  orientation: PdfOrientation;
  margin: PdfMargin;
  quality: PdfQuality;
  numberPosition: PageNumberPosition;
  searchable: boolean;
};

export const DEFAULT_EXPORT_LAYOUT: ExportLayout = {
  paper: null,
  orientation: 'auto',
  margin: 'none',
  quality: 'standard',
  numberPosition: 'bottom-center',
  searchable: true,
};

const LAYOUT_KEY = '@scan_kit_export_layout';
const PAPERS: readonly PageSize[] = ['Auto', 'A4', 'Letter', 'Legal'];
const QUALITIES: readonly PdfQuality[] = ['high', 'standard', 'small'];

const oneOf = <T,>(list: readonly T[], v: unknown, fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);

/** A stored layout (any JSON, or garbage) read field by field onto the defaults. Pure. */
export function parseExportLayout(raw: string | null | undefined): ExportLayout {
  let v: Record<string, unknown> = {};
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) v = parsed as Record<string, unknown>;
  } catch {}
  const d = DEFAULT_EXPORT_LAYOUT;
  return {
    paper: v.paper === null || v.paper === undefined ? null : oneOf(PAPERS, v.paper, d.paper),
    orientation: oneOf(PDF_ORIENTATIONS, v.orientation, d.orientation),
    margin: oneOf(PDF_MARGINS, v.margin, d.margin),
    quality: oneOf(QUALITIES, v.quality, d.quality),
    numberPosition: oneOf(PAGE_NUMBER_POSITIONS, v.numberPosition, d.numberPosition),
    searchable: typeof v.searchable === 'boolean' ? v.searchable : d.searchable,
  };
}

/**
 * The paper to store for a choice: null — "Same as Document settings", which
 * then follows Document settings when it changes — for that choice itself or
 * for Document settings' own paper. Only a different paper is pinned. Pure.
 */
export function paperOverride(choice: PageSize | null, docPaper: PageSize): PageSize | null {
  return choice === null || choice === docPaper ? null : choice;
}

/**
 * `layout` with a stored paper equal to Document settings' read as "Same as
 * Document settings" (null). Values stored before that choice existed load
 * this way, so they follow Document settings from now on. Pure.
 */
export function followDocPaper(layout: ExportLayout, docPaper: PageSize): ExportLayout {
  return layout.paper !== null && layout.paper === docPaper ? { ...layout, paper: null } : layout;
}

/**
 * The remembered layout read against Document settings' paper (`docPaper`
 * resolves to it, or null when it can't be read): see followDocPaper. When
 * that changes the stored value, the new one is stored. Never throws.
 */
export async function loadExportLayout(docPaper: () => Promise<PageSize | null>): Promise<ExportLayout> {
  const stored = await getExportLayout();
  let paper: PageSize | null = null;
  try {
    paper = await docPaper();
  } catch {}
  if (!paper) return stored;
  const next = followDocPaper(stored, paper);
  if (next !== stored) await setExportLayout(next);
  return next;
}

/** True when `l` changes nothing from the defaults (the options row then says "Standard"). */
export function isDefaultLayout(l: ExportLayout): boolean {
  const d = DEFAULT_EXPORT_LAYOUT;
  return (Object.keys(d) as (keyof ExportLayout)[]).every(k => l[k] === d[k]);
}

/** The remembered PDF layout (the defaults until one is chosen). Never throws. */
export async function getExportLayout(): Promise<ExportLayout> {
  try {
    return parseExportLayout(await store()?.getItem(LAYOUT_KEY));
  } catch {
    return { ...DEFAULT_EXPORT_LAYOUT };
  }
}

/** Remembers the PDF layout. Best effort. */
export async function setExportLayout(layout: ExportLayout): Promise<void> {
  try {
    await store()?.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {}
}

/** What each margin choice is called on screen, and how wide it is. */
export const MARGIN_LABELS: Record<PdfMargin, { label: string; detail: string }> = {
  none: { label: 'None', detail: 'Edge to edge, like the scan' },
  small: { label: 'Small', detail: '¼ inch (6 mm) of white around each page' },
  normal: { label: 'Medium', detail: '½ inch (13 mm) of white around each page' },
  wide: { label: 'Large', detail: '1 inch (25 mm) of white around each page' },
};

const QUALITY_WORDS: Record<PdfQuality, string> = { high: 'High quality', standard: 'Standard quality', small: 'Small images' };

/**
 * The PDF options row's one-line summary, e.g. "A4 · Landscape · Medium
 * margins · High quality". `paper` is the paper actually used (the layout's,
 * or Document settings' when it has none). Pure.
 */
export function layoutSummary(layout: ExportLayout, paper: PageSize, searchableAvailable = true): string {
  const parts: string[] = [paper === 'Letter' ? 'US Letter' : paper === 'Legal' ? 'US Legal' : paper === 'Auto' ? 'Auto paper' : paper];
  if (paper !== 'Auto' && layout.orientation !== 'auto') parts.push(layout.orientation === 'portrait' ? 'Portrait' : 'Landscape');
  if (layout.margin !== 'none') parts.push(`${MARGIN_LABELS[layout.margin].label} margins`);
  parts.push(QUALITY_WORDS[layout.quality]);
  if (searchableAvailable && !layout.searchable) parts.push('Not searchable');
  return parts.join(' · ');
}
