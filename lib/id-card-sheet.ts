// lib/id-card-sheet.ts
// "ID card on one page": the front and back of a card composed on ONE sheet
// of the user's paper size (Document settings: A4 or Letter; Auto means A4),
// each side at the card's real size, ISO/IEC 7810 ID-1: 85.6 × 53.98 mm.
// Printed at 100 % (or exported: the page is exactly the paper's shape, so the
// PDF puts it edge to edge on that paper — lib/pdf.ts fitContain), the card
// measures 85.6 mm, like a photocopy of it.
//
// Layout: the sheet is cut in two halves; the front sits centred in the top
// half and the back centred in the bottom half, so the printout can be cut or
// folded between them. Front only: just the top half is used. Each card gets
// a light outline at its edge (a cutting guide; a white card on white paper
// would otherwise have none).
//
// Pixels: 300 dpi, the resolution a copier scans an ID at, so the small print
// stays sharp enough to read and to recognise (A4 at 300 dpi is 2480 × 3508,
// well under WebKit's canvas limit). Rendering happens in an off-screen
// WebView canvas (components/local-webview.tsx), like Long image.

/** ISO/IEC 7810 ID-1 card, in millimetres. */
export const ID1_MM = { width: 85.6, height: 53.98 } as const;

/** Paper sizes in millimetres. */
export const PAPER_MM = {
  A4: { width: 210, height: 297 },
  Letter: { width: 215.9, height: 279.4 },
} as const;

export type SheetPaper = keyof typeof PAPER_MM;

export const SHEET_DPI = 300;
const MM_PER_INCH = 25.4;

/** The paper for the one-page layout, from Document settings' PDF page size. */
export function sheetPaperFor(pdfPageSize: string | null | undefined): SheetPaper {
  return pdfPageSize === 'Letter' ? 'Letter' : 'A4';
}

export type CardBox = { x: number; y: number; width: number; height: number; rotate: boolean };
export type IdSheetPlan = {
  paper: SheetPaper;
  dpi: number;
  /** Sheet size in pixels. */
  width: number;
  height: number;
  /** Where each side is drawn, in pixels; `rotate` turns a portrait capture a quarter turn to lie landscape. */
  cards: CardBox[];
};

const px = (mm: number, dpi: number) => (mm / MM_PER_INCH) * dpi;

/**
 * Where to draw each side (`sides` gives each capture's pixel size) on one
 * sheet of `paper`. Every card is drawn at ID-1 size in landscape; a capture
 * that is taller than wide (a card photographed upright) is turned a quarter
 * turn so it lies landscape too, still at real size.
 */
export function planIdCardSheet(
  sides: { width: number; height: number }[],
  paper: SheetPaper = 'A4',
  dpi: number = SHEET_DPI,
): IdSheetPlan {
  const mm = PAPER_MM[paper];
  const width = Math.round(px(mm.width, dpi));
  const height = Math.round(px(mm.height, dpi));
  const cardW = px(ID1_MM.width, dpi);
  const cardH = px(ID1_MM.height, dpi);
  const half = height / 2;
  const cards = sides.slice(0, 2).map((s, i): CardBox => {
    const portrait = s.height > s.width;
    return {
      x: Math.round((width - cardW) / 2),
      y: Math.round(i * half + (half - cardH) / 2),
      width: Math.round(cardW),
      height: Math.round(cardH),
      rotate: portrait,
    };
  });
  return { paper, dpi, width, height, cards };
}

/** The card's width on the sheet in millimetres (for tests and the note). */
export function cardWidthMm(plan: IdSheetPlan, index = 0): number {
  const c = plan.cards[index];
  return c ? (c.width / plan.dpi) * MM_PER_INCH : 0;
}

/**
 * HTML that draws each `srcs[i]` (file:// URL) into `plan.cards[i]` on a white
 * sheet and posts back `data:image/jpeg;…`, or `ERROR:<reason>`. Each capture
 * is fitted to its card box (cover, centred), so a crop a touch off the card's
 * shape still fills the card outline rather than leaving white slivers. Load
 * it in a LocalWebView (file access) or the canvas is tainted.
 */
export function buildIdCardSheetHtml(srcs: string[], plan: IdSheetPlan): string {
  return `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#fff;">
<script>
var SRCS = ${JSON.stringify(srcs)};
var PLAN = ${JSON.stringify(plan)};
function post(msg) {
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(msg);
  else setTimeout(function () { post(msg); }, 30);
}
function load(src) {
  return new Promise(function (resolve) {
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function () { resolve(img); };
    img.onerror = function () { resolve(null); };
    img.src = src;
  });
}
(async function () {
  try {
    var canvas = document.createElement('canvas');
    canvas.width = PLAN.width;
    canvas.height = PLAN.height;
    var ctx = canvas.getContext('2d');
    if (!ctx) { post('ERROR:canvas'); return; }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, PLAN.width, PLAN.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    var drawn = 0;
    for (var i = 0; i < PLAN.cards.length && i < SRCS.length; i++) {
      var img = await load(SRCS[i]);
      if (!img) continue;
      var c = PLAN.cards[i];
      var iw = c.rotate ? img.naturalHeight : img.naturalWidth;
      var ih = c.rotate ? img.naturalWidth : img.naturalHeight;
      // Cover: the capture fills the card box; any excess is trimmed evenly.
      var k = Math.max(c.width / iw, c.height / ih);
      var dw = iw * k, dh = ih * k;
      ctx.save();
      ctx.beginPath();
      ctx.rect(c.x, c.y, c.width, c.height);
      ctx.clip();
      ctx.translate(c.x + c.width / 2, c.y + c.height / 2);
      if (c.rotate) ctx.rotate(-Math.PI / 2);
      var w = c.rotate ? dh : dw, h = c.rotate ? dw : dh;
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.restore();
      // A light outline at the card's edge: a guide for cutting, and the
      // edge of a white card on white paper stays visible.
      ctx.strokeStyle = '#c8c8c8';
      ctx.lineWidth = 2;
      ctx.strokeRect(c.x + 1, c.y + 1, c.width - 2, c.height - 2);
      drawn++;
    }
    if (!drawn) { post('ERROR:load'); return; }
    var url = canvas.toDataURL('image/jpeg', 0.9);
    if (!url || url.length < 64 || url.indexOf('data:image/jpeg') !== 0) { post('ERROR:encode'); return; }
    post(url);
  } catch (e) {
    post('ERROR:' + (e && e.message ? e.message : 'unknown'));
  }
})();
</script>
</body></html>`;
}
