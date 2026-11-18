// lib/pdf.ts
// Page images -> PDF via expo-print (WKWebView print renderer).
//
// Layout: every page image becomes one "sheet" that is exactly one sheet of
// paper (A4, Letter, or with 'Auto' a size shaped like the scans — see
// autoPaperSize). The image is scaled to fit inside it (contain, centred), so a
// page can never spill onto a second sheet. expo-print renders every page of
// one PDF at the same size, so 'Auto' picks one size per export.
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
// images in Documents can't be referenced). Unbounded full-resolution pages
// can get the WebKit content process killed, after which expo-print never
// settles — so rendering is also raced against a timeout.
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
};

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

type PreparedImage = { b64: string; mime: string; width: number; height: number };

/** Read one page, downscaling / re-encoding it first when the preset asks for it. */
async function prepareImage(uri: string, quality: PdfQuality, maxEdge: number): Promise<PreparedImage> {
  const preset = QUALITY[quality];
  const natural = await getImageSize(uri);
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
    `transform-origin:0 0}`;
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

  let paper: Paper;
  if (pageSize === 'Auto') {
    const sizes = await Promise.all(pages.map(p => getImageSize(cleanUri(p))));
    throwIfAborted(signal);
    paper = autoPaperSize(sizes);
  } else {
    paper = PAPER_SIZES_PT[pageSize];
  }
  const maxEdge = maxEdgeFor(quality, pages.length);
  const sheets: string[] = [];

  for (let i = 0; i < pages.length; i++) {
    throwIfAborted(signal);
    onProgress?.(i, pages.length, 'preparing');
    const uri = cleanUri(pages[i]);

    let img: PreparedImage;
    try {
      img = await prepareImage(uri, quality, maxEdge);
    } catch {
      throw new PdfError(`Couldn’t read page ${i + 1}.`, 'read');
    }
    if (!img.b64) throw new PdfError(`Couldn’t read page ${i + 1}.`, 'read');
    throwIfAborted(signal);

    const box = fitContain(img, paper);
    const boxPt = { width: r4(box.width * paper.width), height: r4(box.height * paper.height) };

    let text = '';
    if (opts.searchable) {
      onProgress?.(i, pages.length, 'reading-text');
      try {
        const { lines } = await recognizeLines(uri, signal);
        // OCR coordinates are in the original image's pixels; map via the
        // original size (same aspect ratio as the downscaled copy).
        const original = (await getImageSize(uri)) ?? img;
        text = ocrSpans(lines, original, boxPt.height);
      } catch {
        // A page without a text layer is still a valid page.
      }
    }

    let overlay = '';
    if (opts.overlayHtml) {
      overlay = `<div class="o">${opts.overlayHtml(i, boxPt)}</div>`;
    }

    sheets.push(
      `<div class="s"><div class="b" style="left:${r4(box.left * 100)}%;top:${r4(box.top * 100)}%;` +
        `width:${r4(box.width * 100)}%;height:${r4(box.height * 100)}%">` +
        `<img src="data:${img.mime};base64,${img.b64}">${text}${overlay}</div></div>`,
    );
  }

  throwIfAborted(signal);
  onProgress?.(pages.length, pages.length, 'rendering');
  const html = buildPdfHtml(sheets, paper);
  sheets.length = 0; // let the per-page strings go before the native call

  const render = Print.printToFileAsync({
    html,
    width: paper.width,
    height: paper.height,
    margins: { left: 0, right: 0, top: 0, bottom: 0 },
  }).then(r => r.uri);
  render.catch(() => {}); // a late failure after timeout/cancel must not be unhandled

  let uri: string;
  try {
    uri = await guard(render, signal, opts.timeoutMs ?? 30_000 + 3_000 * pages.length);
  } catch (err) {
    // Cancelled or timed out: the native render can't be stopped and still
    // writes its PDF (unprotected, even when a password-protected export was
    // asked for) into Caches/Print. Nobody will ever receive that file, so
    // delete it the moment it lands instead of leaving a copy behind.
    render.then(deleteLateRender, () => {});
    if (err instanceof PdfCancelledError || err instanceof PdfError) throw err;
    throw new PdfError('Couldn’t create the PDF.', 'render');
  }
  return uri;
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
