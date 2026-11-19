// lib/compress-pdf.ts
// Compress › Smaller PDF, the choices (round 16). Pure, so the sizes shown on
// screen are tested against the same estimate the export sheet uses
// (lib/pdf estimatePdfBytes: from each page's stored bytes and pixel size,
// leaning high and rounded up, so the file is not bigger than promised).
//
// What actually changes a PDF's size is the pages' resolution: the print
// renderer re-encodes every image at its own JPEG quality (see lib/pdf
// RENDER_RATIO), so every choice here is a longest-edge size in pixels:
// - presets: Smallest (1000 px), Small (the 'small' preset, 1300 px — what
//   Compress always made before, so it stays the default), Medium (the
//   'standard' preset, 1800 px), Large (the 'high' preset, 2400 px);
// - "Fit under" a size (1, 2, 5, 10 MB — common upload and email limits, in
//   decimal megabytes as iOS shows sizes): the largest size whose estimate
//   fits (lib/pdf maxEdgeForTarget);
// - Custom: any size from 800 to 2400 px.
// The text layer (searchable) can be left out, which makes the file a little
// smaller and much faster to make.
import {
  BYTES_PER_MB,
  estimatePdfBytes,
  MAX_CUSTOM_EDGE,
  maxEdgeForTarget,
  MIN_CUSTOM_EDGE,
  roundUpEstimate,
  type PageStat,
  type PdfQuality,
} from './pdf';
import { numberIn, oneOf } from './tool-prefs';

export type CompressPreset = 'smallest' | 'small' | 'medium' | 'large';
export const COMPRESS_PRESETS: readonly CompressPreset[] = ['smallest', 'small', 'medium', 'large'];
export const TARGET_MB: readonly number[] = [1, 2, 5, 10];

export type PdfSizing =
  | { kind: 'preset'; preset: CompressPreset }
  | { kind: 'target'; mb: number }
  | { kind: 'custom'; edge: number };

/** Free up space's level (lib/compress.ts CompressLevel), remembered with the rest. */
export type SpaceLevel = 'small' | 'balanced' | 'sharp';
const SPACE_LEVELS: readonly SpaceLevel[] = ['small', 'balanced', 'sharp'];

export type CompressPdfPrefs = { sizing: PdfSizing; searchable: boolean; level: SpaceLevel };

export const DEFAULT_COMPRESS_PDF: CompressPdfPrefs = {
  sizing: { kind: 'preset', preset: 'small' },
  searchable: true,
  level: 'balanced',
};

/** Smallest's own size: below Small, still readable on a phone screen. */
export const SMALLEST_EDGE = 1000;

const PRESET_OPTIONS: Record<CompressPreset, { quality: PdfQuality; maxEdge?: number }> = {
  smallest: { quality: 'small', maxEdge: SMALLEST_EDGE },
  small: { quality: 'small' },
  medium: { quality: 'standard' },
  large: { quality: 'high' },
};

/** Decimal megabytes, as iOS Files and Mail count them and upload limits are written (1 MB = 1,000,000 bytes). */
const MB = BYTES_PER_MB;

/**
 * What generatePdf is asked for. `fits: false` when a "Fit under" target
 * can't be met even at the smallest custom size (the PDF is then made at that
 * size and the screen says the limit may be missed).
 */
export function pdfOptionsFor(
  sizing: PdfSizing,
  stats: PageStat[] | null,
  searchable: boolean,
): { quality: PdfQuality; maxEdge?: number; fits: boolean } {
  if (sizing.kind === 'preset') return { ...PRESET_OPTIONS[sizing.preset], fits: true };
  if (sizing.kind === 'custom') return { quality: 'standard', maxEdge: sizing.edge, fits: true };
  if (!stats) return { quality: 'standard', maxEdge: MIN_CUSTOM_EDGE, fits: false };
  const edge = maxEdgeForTarget(stats, sizing.mb * MB, searchable);
  return edge == null ? { quality: 'standard', maxEdge: MIN_CUSTOM_EDGE, fits: false } : { quality: 'standard', maxEdge: edge, fits: true };
}

/** The estimated PDF size for a choice (before rounding for display). */
export function estimateFor(sizing: PdfSizing, stats: PageStat[], searchable: boolean): number {
  const o = pdfOptionsFor(sizing, stats, searchable);
  return estimatePdfBytes(stats, o.quality, searchable, o.maxEdge);
}

/** "under 2 MB" / "2.3 MB, over the 2 MB limit" — how the made file compares with a target. */
export function targetVerdict(bytes: number, mb: number): { ok: boolean; text: string } {
  return bytes <= mb * MB ? { ok: true, text: `Under the ${mb} MB limit` } : { ok: false, text: `Over the ${mb} MB limit` };
}

/** Remembered choices, validated field by field onto the defaults. Pure. */
export function parseCompressPdfPrefs(o: Record<string, unknown>): CompressPdfPrefs {
  const s = (o.sizing && typeof o.sizing === 'object' ? o.sizing : {}) as Record<string, unknown>;
  let sizing: PdfSizing = DEFAULT_COMPRESS_PDF.sizing;
  if (s.kind === 'preset' && COMPRESS_PRESETS.includes(s.preset as CompressPreset)) {
    sizing = { kind: 'preset', preset: s.preset as CompressPreset };
  } else if (s.kind === 'target' && TARGET_MB.includes(s.mb as number)) {
    sizing = { kind: 'target', mb: s.mb as number };
  } else if (s.kind === 'custom') {
    sizing = { kind: 'custom', edge: numberIn(s.edge, MIN_CUSTOM_EDGE, MAX_CUSTOM_EDGE, 1600, 100) };
  }
  return {
    sizing,
    searchable: typeof o.searchable === 'boolean' ? o.searchable : DEFAULT_COMPRESS_PDF.searchable,
    level: oneOf(SPACE_LEVELS, o.level, DEFAULT_COMPRESS_PDF.level),
  };
}



// ── Export › Smaller PDF ─────────────────────────────────────────────────────

/**
 * What the export sheet's "Smaller PDF" makes: one step below the PDF row's
 * own image quality — the 'small' preset, or Smallest's size when the PDF
 * options already ask for 'small' (it would otherwise be the same file).
 */
export function smallerPdfChoice(quality: PdfQuality): { quality: PdfQuality; maxEdge?: number } {
  return quality === 'small' ? { quality: 'small', maxEdge: SMALLEST_EDGE } : { quality: 'small' };
}

/**
 * Whether "Smaller PDF" really is smaller than "PDF" for these pages (by the
 * size estimate, after the rounding the rows show). Unknown pages (null:
 * still being measured): true, so the row doesn't flicker away for nothing.
 * The sheet hides the row when it isn't: never two rows for one file.
 */
export function smallerPdfIsSmaller(stats: PageStat[] | null, quality: PdfQuality, searchable: boolean): boolean {
  if (!stats) return true;
  const s = smallerPdfChoice(quality);
  const smaller = roundUpEstimate(estimatePdfBytes(stats, s.quality, searchable, s.maxEdge));
  const plain = roundUpEstimate(estimatePdfBytes(stats, quality, searchable));
  return smaller < plain;
}
