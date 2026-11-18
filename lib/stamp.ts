// lib/stamp.ts
// Overlay markup for the Watermark, Timestamp and Sign tools. Each builder
// returns HTML for lib/pdf.ts generatePdf's `overlayHtml`: it is drawn in a box
// that exactly covers one page image, positioned with percentages, sized with
// the `--pt` CSS variable (one PDF point). The same numbers drive the on-screen
// previews, so what the user sees is what lands in the PDF.
import { escapeHtml } from './pdf';

const FONT = 'Helvetica,Arial,sans-serif';

// ── Watermark ────────────────────────────────────────────────────────────────

export type WatermarkStyle = 'diagonal' | 'center' | 'footer';
export type StampColor = 'gray' | 'red' | 'blue';

export const STAMP_RGB: Record<StampColor, [number, number, number]> = {
  gray: [60, 60, 60],
  red: [200, 30, 30],
  blue: [20, 80, 190],
};

/**
 * Watermark font size as a fraction of the page width, so long text still
 * fits across the page and short text doesn't become enormous.
 */
export function watermarkFontFraction(text: string, style: WatermarkStyle): number {
  if (style === 'footer') return 0.022;
  const len = Math.max(1, [...text.trim()].length);
  const span = style === 'diagonal' ? 1.05 : 0.85; // usable line length, in page widths
  return Math.min(0.16, Math.max(0.03, span / (len * 0.62)));
}

export function watermarkOpacity(style: WatermarkStyle): number {
  return style === 'footer' ? 0.7 : 0.22;
}

export const WATERMARK_ANGLE = -35;

export function watermarkOverlay(
  text: string,
  style: WatermarkStyle,
  color: StampColor,
  pageWidthPt: number,
): string {
  const [r, g, b] = STAMP_RGB[color];
  const fontPt = watermarkFontFraction(text, style) * pageWidthPt;
  const ink = `rgba(${r},${g},${b},${watermarkOpacity(style)})`;
  const label = escapeHtml(text.trim());
  const common = `font:700 calc(${fontPt.toFixed(2)} * var(--pt)) ${FONT};color:${ink};white-space:nowrap;letter-spacing:0.04em`;
  if (style === 'footer') {
    return `<div style="position:absolute;left:0;right:0;bottom:3%;text-align:center;${common}">${label}</div>`;
  }
  const rotate = style === 'diagonal' ? `transform:rotate(${WATERMARK_ANGLE}deg);` : '';
  return (
    `<div style="position:absolute;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;overflow:hidden">` +
    `<div style="${rotate}${common}">${label}</div></div>`
  );
}

// ── Timestamp ────────────────────────────────────────────────────────────────

export type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

/** Inset from the page edges, as a fraction of the page width. */
export const CORNER_INSET = 0.03;
export const TIMESTAMP_FONT_FRACTION = 0.024;

export function timestampOverlay(text: string, corner: Corner, pageWidthPt: number): string {
  const fontPt = TIMESTAMP_FONT_FRACTION * pageWidthPt;
  const inset = `${(CORNER_INSET * 100).toFixed(2)}%`;
  const [v, h] = corner.split('-') as ['top' | 'bottom', 'left' | 'right'];
  // Percent insets on top/bottom refer to the box HEIGHT; use points instead so
  // the gap matches the horizontal one.
  const insetPt = (CORNER_INSET * pageWidthPt).toFixed(2);
  return (
    `<div style="position:absolute;${v}:calc(${insetPt} * var(--pt));${h}:${inset};` +
    `padding:calc(${(fontPt * 0.35).toFixed(2)} * var(--pt)) calc(${(fontPt * 0.6).toFixed(2)} * var(--pt));` +
    `background:rgba(255,255,255,0.85);border-radius:calc(${(fontPt * 0.3).toFixed(2)} * var(--pt));` +
    `font:500 calc(${fontPt.toFixed(2)} * var(--pt)) ${FONT};color:#222;white-space:nowrap">` +
    `${escapeHtml(text)}</div>`
  );
}

export type TimestampFormat = 'date' | 'datetime';

export function formatStamp(ts: number, format: TimestampFormat): string {
  const d = new Date(ts);
  const date = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  if (format === 'date') return date;
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date}, ${time}`;
}

// ── Signature ────────────────────────────────────────────────────────────────

/** Signature image placement as fractions (0..1) of the page image box. */
export type Placement = { x: number; y: number; w: number };

export type Signature = { dataUri: string; width: number; height: number };

/** Signature height as a fraction of the page height, for a page of the given aspect (h / w). */
export function signatureHeightFraction(sig: Signature, placement: Placement, pageAspect: number): number {
  return (placement.w * (sig.height / sig.width)) / pageAspect;
}

/** Keeps the signature fully on the page. */
export function clampPlacement(sig: Signature, p: Placement, pageAspect: number): Placement {
  const hFrac = signatureHeightFraction(sig, p, pageAspect);
  return {
    w: p.w,
    x: Math.min(Math.max(0, p.x), Math.max(0, 1 - p.w)),
    y: Math.min(Math.max(0, p.y), Math.max(0, 1 - hFrac)),
  };
}

/** Default spot: bottom right, clear of the edge. */
export function defaultPlacement(sig: Signature, pageAspect: number, w = 0.32): Placement {
  const hFrac = signatureHeightFraction(sig, { x: 0, y: 0, w }, pageAspect);
  return { w, x: 1 - w - 0.06, y: Math.max(0, 1 - hFrac - 0.05) };
}

export function signatureOverlay(sig: Signature, p: Placement): string {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig.dataUri)) return '';
  const pct = (n: number) => `${(n * 100).toFixed(3)}%`;
  return `<img src="${sig.dataUri}" style="position:absolute;left:${pct(p.x)};top:${pct(p.y)};width:${pct(p.w)};height:auto" />`;
}
