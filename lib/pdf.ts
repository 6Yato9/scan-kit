// lib/pdf.ts
// Page images -> PDF via expo-print (WKWebView print renderer).
//
// Layout: every page image becomes one "sheet" that is exactly one sheet of
// paper (A4, Letter, or with 'Auto' a size shaped like the scan — see
// autoPaperSize). The image is scaled to fit inside it (contain, centred), so a
// page can never spill onto a second sheet. expo-print renders every page of
// one print job at the same size, so mixed documents are printed in runs and
// stitched natively — see planPaperRuns.
//
// Units matter here. WebKit's print renderer lays the document out wider than
// the paper (its minimum shrink factor is 1.25: an A4 page is ~744 CSS px wide)
// and then scales it down, while `vw` stays tied to the 595 px web view — so
// `100vw` only covers 80% of the paper (verified on device). Everything is
// therefore sized in percentages of the body width (= the paper width at print
// time): the sheet uses the padding-top aspect-ratio trick and its children are
// absolutely positioned in %. Font sizes use `--pt` (one PDF point), which is
// `100cqw / paperWidth` where container units exist and 1.25 px otherwise.
//
// Memory: pages are downscaled / re-encoded one at a time before being inlined
// as base64 (expo-print loads HTML with the app bundle as base URL, so file://
// images in Documents can't be referenced). A print job holds at most
// MAX_RUN_PAGES pages, prepared just before it renders, so a long document
// never has all its images in memory. Unbounded full-resolution pages can get
// the WebKit content process killed, after which expo-print never settles —
// so rendering is also raced against a timeout.
import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { Image } from 'react-native';
import { recognizeLines, OcrLine } from './ocr';
import { VisionOcr } from '../modules/vision-ocr/src';

/** 'Auto' shapes the paper like the scanned pages (a receipt gets a tall, narrow page). */
export type PageSize = 'Auto' | 'A4' | 'Letter';
export type PdfQuality = 'high' | 'standard' | 'small';
type Paper = { width: number; height: number };

/** Standard paper sizes in PostScript points (1 in = 72 pt). */
export const PAPER_SIZES_PT: Record<'A4' | 'Letter', Paper> = {
  A4: { width: 595, height: 842 },
  Letter: { width: 612, height: 792 },
};

/** Auto pages get the long edge of A4, so they look and print at a familiar scale. */
const AUTO_LONG_EDGE_PT = 842;
/** A scan within 3% of a standard paper shape gets exactly that paper. */
const AUTO_SNAP = 0.03;
/** Narrowest / widest Auto shape; anything more extreme is letterboxed. */
const AUTO_MIN_RATIO = 0.2;

/**
 * Paper for 'Auto': the shape of the scanned pages (the median width/height
 * ratio, so one odd page doesn't decide for the rest), with the long edge of
 * A4. A scan that is already A4 or Letter shaped (either orientation) gets that
 * exact size, so a scanned letter still prints as a real letter. No usable
 * sizes: A4.
 */
export function autoPaperSize(sizes: ({ width: number; height: number } | null | undefined)[]): Paper {
  const ratios = sizes
    .filter((s): s is Paper => !!s && s.width > 0 && s.height > 0)
    .map(s => s.width / s.height)
    .sort((a, b) => a - b);
  if (ratios.length === 0) return PAPER_SIZES_PT.A4;
  const ratio = ratios[Math.floor((ratios.length - 1) / 2)];

  let best: Paper | null = null;
  let bestDiff = AUTO_SNAP;
  for (const p of [PAPER_SIZES_PT.A4, PAPER_SIZES_PT.Letter]) {
    for (const cand of [p, { width: p.height, height: p.width }]) {
      const diff = Math.abs(ratio / (cand.width / cand.height) - 1);
      if (diff <= bestDiff) {
        best = cand;
        bestDiff = diff;
      }
    }
  }
  if (best) return best;

  const r = Math.min(1 / AUTO_MIN_RATIO, Math.max(AUTO_MIN_RATIO, ratio));
  return r <= 1
    ? { width: Math.round(AUTO_LONG_EDGE_PT * r), height: AUTO_LONG_EDGE_PT }
    : { width: AUTO_LONG_EDGE_PT, height: Math.round(AUTO_LONG_EDGE_PT / r) };
}

/** Short user-facing name for a paper setting. */
export function paperLabel(pageSize: PageSize): string {
  if (pageSize === 'Auto') return 'Auto';
  return pageSize === 'Letter' ? 'US Letter' : 'A4';
}

/** Longest image edge (px) and JPEG quality per preset. `reencode: false` keeps smaller originals untouched. */
const QUALITY: Record<PdfQuality, { maxEdge: number; compress: number; reencode: boolean }> = {
  high: { maxEdge: 2400, compress: 0.85, reencode: false },
  standard: { maxEdge: 1800, compress: 0.72, reencode: true },
  small: { maxEdge: 1300, compress: 0.55, reencode: true },
};

export type PdfProgressPhase = 'preparing' | 'reading-text' | 'rendering';

export type GeneratePdfOptions = {
  /** Paper size. Default 'A4'. Callers normally pass the user's Document settings value ('Auto' by default). */
  pageSize?: PageSize;
  /** Image downscale / compression preset. Default 'high'. */
  quality?: PdfQuality;
  /** Add an invisible OCR text layer so the PDF is searchable/selectable. */
  searchable?: boolean;
  /**
   * Extra HTML drawn over each page image (signatures, watermarks, stamps).
   * The returned markup is placed in a container that exactly covers the page
   * image (`position:absolute`), so position children with percentages. For
   * absolute sizes use the `--pt` CSS variable (one PDF point), e.g.
   * `font-size: calc(14 * var(--pt))`. `pageSizePt` is that container's size
   * in points. Escape any user text with `escapeHtml`.
   */
  overlayHtml?: (pageIndex: number, pageSizePt: { width: number; height: number }) => string;
  onProgress?: (done: number, total: number, phase: PdfProgressPhase) => void;
  /** Abort between pages and stop waiting for the renderer. Rejects with PdfCancelledError. */
  signal?: AbortSignal;
  /** Give up waiting for the renderer after this long. Default 30 s + 3 s per page. */
  timeoutMs?: number;
  /**
   * Page numbers printed bottom-centre on every sheet: 'number' ("3") or
   * 'of-total' ("3 of 12"). Drawn into the PDF only; the stored pages are
   * untouched. Default 'off'.
   */
  pageNumbers?: PageNumberStyle;
};

// ── Page numbers ────────────────────────────────────────────────────────────

/** Page numbers on export: none, "3", or "3 of 12". */
export type PageNumberStyle = 'off' | 'number' | 'of-total';

export const PAGE_NUMBER_STYLES: readonly PageNumberStyle[] = ['off', 'number', 'of-total'];

/** The number printed on page `index` (zero-based) of `total`, or '' when off. */
export function pageNumberLabel(style: PageNumberStyle | undefined, index: number, total: number): string {
  if (style === 'number') return String(index + 1);
  if (style === 'of-total') return `${index + 1} of ${total}`;
  return '';
}

/** Type size of the number and its distance from the bottom edge of the paper, in points. */
export const PAGE_NUMBER_FONT_PT = 9;
export const PAGE_NUMBER_BOTTOM_PT = 14;

/**
 * The page number, centred at the bottom of the SHEET (the paper, not the
 * image on it), inside the usual 0.2-inch printer margin. It sits on a small
 * white label so it reads on a scan that runs to the edge of the paper too.
 */
export function pageNumberHtml(style: PageNumberStyle | undefined, index: number, total: number): string {
  const label = pageNumberLabel(style, index, total);
  if (!label) return '';
  return `<div class="pn"><span>${escapeHtml(label)}</span></div>`;
}

export class PdfError extends Error {
  constructor(message: string, readonly kind: 'read' | 'render' | 'timeout' | 'empty') {
    super(message);
    this.name = 'PdfError';
  }
}

export class PdfCancelledError extends Error {
  constructor() {
    super('PDF export cancelled');
    this.name = 'PdfCancelledError';
  }
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape text for use in HTML element content or a quoted attribute. */
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

/** Strip any `?v=` cache-bust suffix the viewer applies before reading a file. */
function cleanUri(uri: string): string {
  return uri.split('?')[0];
}

/** Promisified Image.getSize — natural pixel dimensions, or null. */
function getImageSize(uri: string): Promise<{ width: number; height: number } | null> {
  return new Promise(resolve => {
    try {
      Image.getSize(
        uri,
        (width, height) => resolve(width > 0 && height > 0 ? { width, height } : null),
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
}

/** Round to 4 decimals so the HTML stays compact and deterministic. */
function r4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Fit an image of `img` aspect inside a sheet of `paper` aspect (contain).
 * Returns the image box as fractions (0..1) of the sheet's width/height.
 */
export function fitContain(
  img: { width: number; height: number },
  paper: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  const imgRatio = img.width / img.height;
  const paperRatio = paper.width / paper.height;
  if (imgRatio >= paperRatio) {
    // Wider than the paper: full width, letterboxed top/bottom.
    const h = paperRatio / imgRatio;
    return { left: 0, top: (1 - h) / 2, width: 1, height: h };
  }
  const w = imgRatio / paperRatio;
  return { left: (1 - w) / 2, top: 0, width: w, height: 1 };
}

/**
 * Rounds a size estimate up to two significant figures in the unit it is shown
 * in (KB below 1 MB, tenths of a MB above), so "about 150 KB" is never less
 * than the estimate itself: 126 KB → 130 KB, 1.21 MB → 1.3 MB, 9 KB → 9 KB.
 */
export function roundUpEstimate(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  const KB = 1024;
  const MB = KB * 1024;
  if (bytes < MB) {
    const kb = Math.ceil(bytes / KB);
    const step = kb >= 100 ? 10 : 1;
    const rounded = Math.ceil(kb / step) * step;
    return rounded >= 1000 ? MB : rounded * KB;
  }
  const mb = bytes / MB;
  const step = mb >= 10 ? 1 : 0.1;
  // The epsilon keeps 1.2 MB (exactly) at 1.2 instead of float-rounding to 1.3.
  return Math.ceil(mb / step - 1e-9) * step * MB;
}

/** Cap the long edge for big documents so the inlined HTML stays a sane size. */
function maxEdgeFor(quality: PdfQuality, pageCount: number): number {
  const base = QUALITY[quality].maxEdge;
  if (pageCount > 40) return Math.min(base, 1500);
  if (pageCount > 20) return Math.min(base, 2000);
  return base;
}

/**
 * Output image bytes per stored byte, at the same pixel count. Measured on
 * device: the print renderer re-encodes every image at its own quality, so
 * the preset's JPEG quality barely changes the result — only the resolution
 * does (ratios came out 0.83-1.24 across real scans, mean ~1.0). The
 * estimate leans high (1.15, then rounded up by roundUpEstimate) so the
 * number shown never under-promises: a receipt estimated at 126 KB came out
 * at 139 KB with a ratio of 1.
 */
const RENDER_RATIO = 1.15;
/** Fixed PDF cost per page (page objects, image header) and per searchable page (text layer). */
const PAGE_OVERHEAD = 2_000;
const TEXT_OVERHEAD = 4_000;

export type PageStat = { bytes: number; width: number; height: number };

/**
 * Rough size of the PDF generatePdf will produce, from each page's stored file
 * size and pixel size. Mirrors prepareImage's downscale to the preset's long
 * edge. Good to within about 25% — enough for "about 1.2 MB" next to an
 * export option.
 */
export function estimatePdfBytes(pages: PageStat[], quality: PdfQuality, searchable = false): number {
  const maxEdge = maxEdgeFor(quality, pages.length);
  let total = 1_000;
  for (const p of pages) {
    const long = Math.max(p.width, p.height);
    const scale = long > 0 ? Math.min(1, maxEdge / long) : 1;
    total += p.bytes * scale * scale * RENDER_RATIO + PAGE_OVERHEAD + (searchable ? TEXT_OVERHEAD : 0);
  }
  return Math.round(total);
}

export type PreparedImage = { b64: string; mime: string; width: number; height: number };

/** Read one page, downscaling / re-encoding it first when the preset asks for it. */
async function prepareImage(
  uri: string,
  quality: PdfQuality,
  maxEdge: number,
  knownSize?: { width: number; height: number } | null,
): Promise<PreparedImage> {
  const preset = QUALITY[quality];
  const natural = knownSize !== undefined ? knownSize : await getImageSize(uri);
  const tooBig = !natural || Math.max(natural.width, natural.height) > maxEdge;

  if (preset.reencode || tooBig) {
    const actions: ImageManipulator.Action[] = [];
    if (natural && tooBig) {
      actions.push({
        resize: natural.width >= natural.height ? { width: maxEdge } : { height: maxEdge },
      });
    }
    const out = await ImageManipulator.manipulateAsync(uri, actions, {
      compress: preset.compress,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: true,
    });
    // manipulateAsync also writes a file to the cache; we only need the base64.
    FileSystem.deleteAsync(out.uri, { idempotent: true }).catch(() => {});
    if (!natural && Math.max(out.width, out.height) > maxEdge) {
      // Size was unknown up front — do the resize now that we know it.
      return prepareImageResized(uri, out.width, out.height, preset.compress, maxEdge);
    }
    return { b64: out.base64 ?? '', mime: 'image/jpeg', width: out.width, height: out.height };
  }

  const b64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
  const mime = uri.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  return { b64, mime, width: natural.width, height: natural.height };
}

async function prepareImageResized(
  uri: string,
  width: number,
  height: number,
  compress: number,
  maxEdge: number,
): Promise<PreparedImage> {
  const out = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: width >= height ? { width: maxEdge } : { height: maxEdge } }],
    { compress, format: ImageManipulator.SaveFormat.JPEG, base64: true },
  );
  FileSystem.deleteAsync(out.uri, { idempotent: true }).catch(() => {});
  return { b64: out.base64 ?? '', mime: 'image/jpeg', width: out.width, height: out.height };
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new PdfCancelledError();
}

/** Resolve/reject `work`, or reject on abort or timeout — whichever happens first. */
function guard<T>(work: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const finish = (fn: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        signal?.removeEventListener?.('abort', onAbort);
      } catch {
        // ignore
      }
      fn();
    };
    const onAbort = () => finish(() => reject(new PdfCancelledError()));
    const timer = setTimeout(
      () => finish(() => reject(new PdfError('Rendering the PDF took too long.', 'timeout'))),
      timeoutMs,
    );
    try {
      signal?.addEventListener?.('abort', onAbort);
    } catch {
      // ignore
    }
    work.then(
      v => finish(() => resolve(v)),
      e => finish(() => reject(e)),
    );
  });
}

function ocrSpans(lines: OcrLine[], img: { width: number; height: number }, boxHeightPt: number): string {
  return lines
    .filter(l => l.text.trim().length > 0)
    .map(l => {
      const left = (l.left / img.width) * 100;
      const top = (l.top / img.height) * 100;
      const width = (l.width / img.width) * 100;
      const height = (l.height / img.height) * 100;
      const linePt = (l.height / img.height) * boxHeightPt;
      return (
        `<span class="t" style="left:${r4(left)}%;top:${r4(top)}%;width:${r4(width)}%;` +
        `height:${r4(height)}%;font-size:calc(${r4(linePt * 0.85)} * var(--pt));` +
        `line-height:calc(${r4(linePt)} * var(--pt))">` +
        `${escapeHtml(l.text)}</span>`
      );
    })
    .join('');
}

/** Build the full HTML document for the given (already prepared) sheets. Exported for tests. */
export function buildPdfHtml(sheets: string[], pageSize: 'A4' | 'Letter' | Paper): string {
  const paper = typeof pageSize === 'string' ? PAPER_SIZES_PT[pageSize] : pageSize;
  // Sheet height as a % of its width (padding-top trick). Shave a hair off so
  // rounding in the print renderer can never push a sheet past the page
  // boundary and create a blank extra page.
  const sheetHeightPct = r4((paper.height / paper.width) * 100 - 0.15);
  const css =
    `@page{size:${paper.width}pt ${paper.height}pt;margin:0}` +
    `*{-webkit-print-color-adjust:exact;print-color-adjust:exact}` +
    `html,body{margin:0;padding:0;background:#fff}` +
    `.s{position:relative;width:100%;height:0;padding-top:${sheetHeightPct}%;overflow:hidden;` +
    `page-break-inside:avoid;break-inside:avoid;--pt:1.25px}` +
    `@supports (width:1cqw){.s{container-type:inline-size;--pt:calc(100cqw / ${paper.width})}}` +
    `.s+.s{page-break-before:always;break-before:page}` +
    `.b{position:absolute;overflow:hidden}` +
    `.b>img{position:absolute;left:0;top:0;width:100%;height:100%;display:block}` +
    `.o{position:absolute;left:0;top:0;right:0;bottom:0}` +
    `.t{position:absolute;color:transparent;white-space:pre;overflow:hidden;font-family:Helvetica,Arial,sans-serif;` +
    `transform-origin:0 0}` +
    `.pn{position:absolute;left:0;right:0;bottom:calc(${PAGE_NUMBER_BOTTOM_PT} * var(--pt));text-align:center;` +
    `font:500 calc(${PAGE_NUMBER_FONT_PT} * var(--pt))/1.2 Helvetica,Arial,sans-serif;color:#333}` +
    `.pn>span{display:inline-block;background:rgba(255,255,255,0.9);padding:calc(1.5 * var(--pt)) calc(5 * var(--pt));` +
    `border-radius:calc(3 * var(--pt))}`;
  // OCR boxes and the font's natural width never match exactly; stretch each
  // text run to its box so nothing is clipped and selections line up. Runs in
  // the renderer's web view before it prints.
  const fitScript = sheets.some(sh => sh.includes('class="t"'))
    ? `<script>(function(){var t=document.querySelectorAll('.t');for(var i=0;i<t.length;i++){` +
      `var e=t[i],box=e.clientWidth,nat=e.scrollWidth;if(box>0&&nat>box){e.style.overflow='visible';` +
      `e.style.transform='scaleX('+(box/nat)+')';}}})();</script>`
    : '';
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>${css}</style></head><body>${sheets.join('')}${fitScript}</body></html>`
  );
}

/** Deletes a PDF the native renderer finished after its caller had given up on it. */
export function deleteLateRender(uri: string): Promise<void> {
  return FileSystem.deleteAsync(cleanUri(uri), { idempotent: true }).catch(() => {});
}

// ── Paper per page ──────────────────────────────────────────────────────────
//
// expo-print renders one HTML document at one @page size, so a document that
// mixes shapes (a landscape page among portrait ones, a receipt among letters)
// is rendered as consecutive runs of same-size pages, one print job each, and
// the runs are concatenated natively (VisionOcr.mergePdfs, PDFKit: pages keep
// their own size and text layer). One run → today's single render, no merge.

/** A run of consecutive pages [start, end) printed on one paper size. */
export type PaperRun = { start: number; end: number; paper: Paper };

/**
 * Most pages printed in one job. A run's pages are inlined as base64 in one
 * HTML string and its images are prepared just before it renders, so this
 * bounds memory however long the document is (a 200-page document is 8 jobs
 * of 25, not one 200-image string). Needs the native merge; without it the
 * document stays one job, as before.
 */
export const MAX_RUN_PAGES = 25;

/** Cuts runs longer than `max` pages into consecutive runs on the same paper. */
export function splitLongRuns(runs: PaperRun[], max: number = MAX_RUN_PAGES): PaperRun[] {
  const out: PaperRun[] = [];
  for (const r of runs) {
    for (let s = r.start; s < r.end; s += max) out.push({ start: s, end: Math.min(r.end, s + max), paper: r.paper });
  }
  return out;
}

/** Pages whose papers differ by at most this much (each edge) share a run. */
const RUN_TOLERANCE = 0.03;

function closePaper(a: Paper, b: Paper): boolean {
  return (
    Math.abs(a.width / b.width - 1) <= RUN_TOLERANCE && Math.abs(a.height / b.height - 1) <= RUN_TOLERANCE
  );
}

/** A4 / Letter turned landscape for a landscape page. */
function orientPaper(paper: Paper, img: { width: number; height: number }): Paper {
  return img.width > img.height ? { width: paper.height, height: paper.width } : paper;
}

/**
 * Splits pages into runs that share one paper size.
 *
 * `perPage: false` (the renderer can't merge PDFs): one run for the whole
 * document — the median shape for 'Auto', portrait A4 / Letter otherwise.
 *
 * `perPage: true`: 'Auto' shapes each page's paper like the page (see
 * autoPaperSize) and A4 / Letter turn landscape for landscape pages.
 * Consecutive pages whose papers are within 3% join one run (an 'Auto' run's
 * paper is the median of its pages), so near-identical scans don't each cost a
 * render. Unreadable sizes count as portrait A4-shaped pages.
 */
export function planPaperRuns(
  sizes: ({ width: number; height: number } | null | undefined)[],
  pageSize: PageSize,
  perPage: boolean,
): PaperRun[] {
  const n = sizes.length;
  if (n === 0) return [];
  const fixed = pageSize === 'Auto' ? null : PAPER_SIZES_PT[pageSize];
  if (!perPage) return [{ start: 0, end: n, paper: fixed ?? autoPaperSize(sizes) }];

  const usable = (s: (typeof sizes)[number]) => !!s && s.width > 0 && s.height > 0;
  const pageAt = (i: number) => (usable(sizes[i]) ? sizes[i]! : PAPER_SIZES_PT.A4);
  const candidate = (i: number) => (fixed ? orientPaper(fixed, pageAt(i)) : autoPaperSize([pageAt(i)]));

  const runs: PaperRun[] = [];
  let start = 0;
  let first = candidate(0);
  const close = (end: number) =>
    runs.push({
      start,
      end,
      paper: fixed ? first : autoPaperSize(Array.from({ length: end - start }, (_, k) => pageAt(start + k))),
    });
  for (let i = 1; i < n; i++) {
    const c = candidate(i);
    if (closePaper(c, first)) continue;
    close(i);
    start = i;
    first = c;
  }
  close(n);
  return runs;
}

/** True when this build can stitch PDFs together, so every page can keep its own paper size. */
function canMergePdfs(): boolean {
  return typeof VisionOcr?.mergePdfs === 'function';
}

/** The native merge failed (not cancelled, not timed out): see generatePdf for the fallback. */
class MergeFailed extends Error {}

/** One page, read and (when searchable) recognised; its sheet is built per paper. */
export type PreparedPage = {
  img: PreparedImage;
  ocr: { lines: OcrLine[]; original: { width: number; height: number } } | null;
};

/** One sheet of paper: the page image, its text layer, overlay and page number. Exported for tests. */
export function buildSheet(
  page: PreparedPage,
  pageIndex: number,
  paper: Paper,
  overlayHtml: GeneratePdfOptions['overlayHtml'],
  numbering?: { style: PageNumberStyle | undefined; total: number },
): string {
  const { img } = page;
  const box = fitContain(img, paper);
  const boxPt = { width: r4(box.width * paper.width), height: r4(box.height * paper.height) };
  const text = page.ocr ? ocrSpans(page.ocr.lines, page.ocr.original, boxPt.height) : '';
  const overlay = overlayHtml ? `<div class="o">${overlayHtml(pageIndex, boxPt)}</div>` : '';
  return (
    `<div class="s"><div class="b" style="left:${r4(box.left * 100)}%;top:${r4(box.top * 100)}%;` +
    `width:${r4(box.width * 100)}%;height:${r4(box.height * 100)}%">` +
    `<img src="data:${img.mime};base64,${img.b64}">${text}${overlay}</div>` +
    `${numbering ? pageNumberHtml(numbering.style, pageIndex, numbering.total) : ''}</div>`
  );
}

/**
 * Print pages [start, end) on one paper; resolves to the rendered file's URI.
 * `pages` holds just this run's pages (pages[0] is page `run.start`).
 */
async function renderRun(
  pages: PreparedPage[],
  run: PaperRun,
  opts: GeneratePdfOptions,
  total: number,
): Promise<string> {
  const { signal } = opts;
  throwIfAborted(signal);
  const { paper } = run;
  const sheets: string[] = [];
  const numbering = { style: opts.pageNumbers, total };
  for (let i = run.start; i < run.end; i++) sheets.push(buildSheet(pages[i - run.start], i, paper, opts.overlayHtml, numbering));
  const html = buildPdfHtml(sheets, paper);
  sheets.length = 0; // let the per-page strings go before the native call

  const render = Print.printToFileAsync({
    html,
    width: paper.width,
    height: paper.height,
    margins: { left: 0, right: 0, top: 0, bottom: 0 },
  }).then(r => r.uri);
  render.catch(() => {}); // a late failure after timeout/cancel must not be unhandled

  try {
    return await guard(render, signal, opts.timeoutMs ?? 30_000 + 3_000 * (run.end - run.start));
  } catch (err) {
    // Cancelled or timed out: the native render can't be stopped and still
    // writes its PDF (unprotected, even when a password-protected export was
    // asked for) into Caches/Print. Nobody will ever receive that file, so
    // delete it the moment it lands instead of leaving a copy behind.
    render.then(deleteLateRender, () => {});
    if (err instanceof PdfCancelledError || err instanceof PdfError) throw err;
    throw new PdfError('Couldn’t create the PDF.', 'render');
  }
}

/**
 * Render every run, then stitch them into one PDF. Each run's images are
 * prepared just before it renders and dropped after, so only one run's pages
 * are ever in memory. Intermediate files never outlive the call.
 */
async function renderAndMerge(
  runs: PaperRun[],
  prepareRun: (run: PaperRun) => Promise<PreparedPage[]>,
  pageCount: number,
  opts: GeneratePdfOptions,
): Promise<string> {
  const { signal } = opts;
  const parts: string[] = [];
  try {
    for (const run of runs) parts.push(await renderRun(await prepareRun(run), run, opts, pageCount));
    throwIfAborted(signal);
    const name = `merged-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.pdf`;
    const out = cleanUri(parts[0]).replace(/[^/]*$/, name);
    const merge = VisionOcr!.mergePdfs!(parts.map(cleanUri), out);
    merge.catch(() => {});
    try {
      return await guard(merge, signal, opts.timeoutMs ?? 30_000 + 500 * pageCount);
    } catch (err) {
      merge.then(deleteLateRender, () => {});
      if (err instanceof PdfCancelledError || err instanceof PdfError) throw err;
      throw new MergeFailed();
    }
  } finally {
    await Promise.all(parts.map(deleteLateRender));
  }
}

/**
 * Render page images to a PDF file in the app cache and return its file:// URI.
 *
 * Filters are already baked into the stored pixels (see lib/bake.ts), so no
 * filter is applied here — that would double-filter the output.
 *
 * The second argument may also be a bare page size for older callers:
 * `generatePdf(pages, 'Letter')`.
 */
export async function generatePdf(
  pages: string[],
  options: GeneratePdfOptions | PageSize = {},
): Promise<string> {
  const opts: GeneratePdfOptions = typeof options === 'string' ? { pageSize: options } : options;
  const pageSize = opts.pageSize ?? 'A4';
  const quality = opts.quality ?? 'high';
  const { signal, onProgress } = opts;
  if (pages.length === 0) throw new PdfError('There are no pages to export.', 'empty');

  const n = pages.length;
  const uris = pages.map(cleanUri);
  const maxEdge = maxEdgeFor(quality, n);

  // Plan the print jobs from each page's pixel size alone (no pixels are read
  // yet), so a long document never has every page's image in memory at once:
  // each run is prepared right before it renders (see MAX_RUN_PAGES).
  const naturals: ({ width: number; height: number } | null)[] = [];
  for (let i = 0; i < n; i++) {
    throwIfAborted(signal);
    naturals.push(await getImageSize(uris[i]));
  }

  const preparePage = async (i: number, report: boolean): Promise<PreparedPage> => {
    throwIfAborted(signal);
    if (report) onProgress?.(i, n, 'preparing');
    const uri = uris[i];

    let img: PreparedImage;
    try {
      img = await prepareImage(uri, quality, maxEdge, naturals[i]);
    } catch {
      throw new PdfError(`Couldn’t read page ${i + 1}.`, 'read');
    }
    if (!img.b64) throw new PdfError(`Couldn’t read page ${i + 1}.`, 'read');
    throwIfAborted(signal);

    let ocr: PreparedPage['ocr'] = null;
    if (opts.searchable) {
      if (report) onProgress?.(i, n, 'reading-text');
      try {
        const { lines } = await recognizeLines(uri, signal);
        // OCR coordinates are in the original image's pixels; map via the
        // original size (same aspect ratio as the downscaled copy).
        ocr = { lines, original: naturals[i] ?? { width: img.width, height: img.height } };
      } catch {
        // A page without a text layer is still a valid page.
      }
    }
    return { img, ocr };
  };
  // Progress runs once through the pages, then reports 'rendering' once, as
  // the last run starts printing.
  const prepareRun = (report: boolean) => async (run: PaperRun): Promise<PreparedPage[]> => {
    const out: PreparedPage[] = [];
    for (let i = run.start; i < run.end; i++) out.push(await preparePage(i, report));
    throwIfAborted(signal);
    if (report && run.end === n) onProgress?.(n, n, 'rendering');
    return out;
  };

  const canMerge = canMergePdfs();
  const planned = planPaperRuns(naturals, pageSize, canMerge);
  const runs = canMerge ? splitLongRuns(planned) : planned;
  if (runs.length > 1) {
    try {
      return await renderAndMerge(runs, prepareRun(true), n, opts);
    } catch (err) {
      if (!(err instanceof MergeFailed)) throw err;
      // Stitching failed. A short document still gets a PDF: one print job on
      // one paper size, no bigger than a single run. A long one fails cleanly:
      // rendering every page in one job is exactly the memory blow-up the
      // bounded runs exist to avoid, and a merge usually fails when the device
      // is already short of space or memory (r8 code review #3).
      if (n > MAX_RUN_PAGES) throw new PdfError('Couldn’t create the PDF.', 'render');
    }
  }
  const single = runs.length === 1 ? runs[0] : planPaperRuns(naturals, pageSize, false)[0];
  return renderRun(await prepareRun(runs.length === 1)(single), single, opts, n);
}

/**
 * A one-page printer test sheet at the given paper size: a frame 10 mm inside
 * the paper edge, corner marks and a grey ramp, so the user can check
 * alignment, margins and tone. Returns a PDF file URI.
 */
export async function generateTestPagePdf(size: PageSize = 'A4'): Promise<string> {
  // A test page has no scan to match: Auto prints on A4.
  const pageSize = size === 'Letter' ? 'Letter' : 'A4';
  const paper = PAPER_SIZES_PT[pageSize];
  const label = pageSize === 'Letter' ? 'US Letter, 8.5 × 11 in' : 'A4, 210 × 297 mm';
  const mm = 72 / 25.4; // points per millimetre
  // Same sheet model as page exports: % of the paper, sizes in var(--pt).
  const insetX = r4(((10 * mm) / paper.width) * 100);
  const insetY = r4(((10 * mm) / paper.height) * 100);
  const pt = (n: number) => `calc(${r4(n)} * var(--pt))`;
  const ramp = [0, 20, 40, 60, 80, 100]
    .map(p => `<div style="flex:1;height:${pt(14 * mm)};background:hsl(0,0%,${100 - p}%);border:${pt(0.5)} solid #000"></div>`)
    .join('');
  const body =
    `<div class="s"><div class="b" style="left:${insetX}%;top:${insetY}%;right:${insetX}%;bottom:${insetY}%;` +
    `border:${pt(1)} solid #111;padding:${pt(12 * mm)};box-sizing:border-box;` +
    `font-family:-apple-system,Helvetica,Arial,sans-serif;color:#111">` +
    `<div style="font-size:${pt(26)};font-weight:700;margin-bottom:${pt(10)}">Scan Kit test page</div>` +
    `<div style="font-size:${pt(11)};line-height:1.5;color:#444">` +
    `<p style="margin:0 0 ${pt(8)}">Paper size: ${escapeHtml(label)}</p>` +
    `<p style="margin:0 0 ${pt(8)}">The black frame should sit 10 mm inside every edge of the paper. ` +
    `If part of it is missing, your printer can’t print that close to the edge.</p>` +
    `<p style="margin:0">The six squares below should step evenly from white to black.</p></div>` +
    `<div style="display:flex;gap:${pt(4)};margin-top:${pt(18)}">${ramp}</div></div></div>`;
  const { uri } = await Print.printToFileAsync({
    html: buildPdfHtml([body], pageSize),
    width: paper.width,
    height: paper.height,
    margins: { left: 0, right: 0, top: 0, bottom: 0 },
  });
  return uri;
}

// ── Password protection ─────────────────────────────────────────────────────

/** Thrown when a PDF couldn't be password-protected (or protection is missing). */
export class PdfProtectError extends Error {}

/** Shortest password the export sheet accepts. */
export const MIN_PDF_PASSWORD = 4;

/** True when this build can write password-protected PDFs (iOS, PDFKit). */
export function canProtectPdf(): boolean {
  return typeof VisionOcr?.protectPdf === 'function';
}

/**
 * Writes a copy of `inputUri` to `outputUri` that needs `password` to open
 * (PDFKit, AES; the native side reopens it to check the password works).
 * Resolves to the output file URI.
 */
export async function protectPdf(inputUri: string, outputUri: string, password: string): Promise<string> {
  const native = VisionOcr?.protectPdf;
  if (!native) throw new PdfProtectError('Password protection isn’t available on this device.');
  if (password.length < MIN_PDF_PASSWORD) throw new PdfProtectError('The password is too short.');
  try {
    return await native(inputUri.split('?')[0], outputUri.split('?')[0], password);
  } catch {
    throw new PdfProtectError('The PDF couldn’t be protected.');
  }
}
