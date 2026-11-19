// lib/create-pdf.ts
// Create PDF (Tools › Pages): one new document from pages of any origin —
// photos from the library, PDFs and images from the Files app, and pages of
// documents already in Scan Kit — in an order the user arranges, each page
// turned as they like. This file is the pure part: the page list, its edits
// and the plan the builder (lib/create-pdf-build.ts) carries out. No native
// module, no file system, so it is unit-tested (__tests__/create-pdf.test.ts).
//
// WHAT IT MAKES. The stored form follows the sources:
//  - Any PDF page among them → ONE new imported-PDF document. PDF pages are
//    moved, never redrawn (PDFKit: mergePdfs, then pdfEditPages to pick,
//    order and turn them), so their text stays selectable and searchable.
//    Photos, images and scanned pages are first rendered into a PDF on the
//    user's paper size and quality (Settings › Document — the same as Merge
//    and Export), with a text layer when recognition is available.
//  - Only photos, images and scanned pages → a new SCANNED document. That is
//    strictly more useful than a flat PDF: each page can still be filtered,
//    re-cropped and widened from its photo (sources are kept), its text is
//    recognised for search, and it exports or shares as a PDF in one tap
//    with the same settings a PDF would have been made with.
// The originals are never changed.
//
// THE PDF PLAN. pdfEditPages takes each input page at most once, but a page
// may be added twice (the same PDF page in two places). So every PDF source
// enters the combined file as many times as one of its pages is used:
// "instances". Page p of a source goes to the first instance that hasn't used
// p yet. The images part comes last. pdfEditPages then picks the pages from
// the combined file in the list's order with their turns.

/** A clockwise turn of a page, in degrees. */
export type PageTurn = 0 | 90 | 180 | 270;

/** Where an image page came from (copy and labels only). */
export type ImageOrigin = 'photo' | 'file';

/** A photo or an image file, already cropped/straightened into a page image (Caches). */
export type ImageItem = {
  key: string;
  kind: 'image';
  origin: ImageOrigin;
  /** The finished page pixels, unfiltered (a temp file). */
  page: string;
  /** The uncropped, upright photo kept as the page's source, or null (lib/page-source.ts). */
  source: string | null;
  /** Its crop geometry on `source` (lib/quad.ts PageGeometry), when `source` is set. */
  geometry: unknown;
  /** True when the page's edges weren't found and the whole photo was kept. */
  uncropped: boolean;
  /** Temp files to delete with the item (picker copies, prepared page and source). */
  temps: string[];
  label: string;
  turn: PageTurn;
};

/** A page of a scanned document in Scan Kit. */
export type ScanItem = {
  key: string;
  kind: 'scan';
  docId: string;
  docName: string;
  /** Page index in that document when it was added. */
  index: number;
  /** That page's file when it was added (also the thumbnail). */
  uri: string;
  /** lib/ocr-cache fileIdentity of `uri` when added: the page must still be exactly this. */
  identity: string | null;
  label: string;
  turn: PageTurn;
};

/** A page of a PDF (an imported Scan Kit document or a file from Files). */
export type PdfItem = {
  key: string;
  kind: 'pdf';
  /** PdfSource.id */
  pdf: string;
  index: number;
  /** A rendered thumbnail, or null when the build can't render PDF pages. */
  thumb: string | null;
  label: string;
  turn: PageTurn;
};

export type CreateItem = ImageItem | ScanItem | PdfItem;

/** A PDF pages were taken from. */
export type PdfSource = {
  id: string;
  /** The file to read (the stored document.pdf, or our staged/unlocked copy of a Files PDF). */
  uri: string;
  name: string;
  pageCount: number;
  /** Set for a Scan Kit document: the builder checks it is unchanged (lib/pdf-edit filePrint). */
  docId?: string;
  print?: { size: number | null; md5: string | null };
  /** Our own staged copy (Caches): deleted with the session. */
  staged?: boolean;
};

// ── The list ─────────────────────────────────────────────────────────────────

export function normTurn(deg: number): PageTurn {
  const d = (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
  return d as PageTurn;
}

/** Turns item `key` a quarter clockwise (or by `deg`). */
export function turnItem(items: CreateItem[], key: string, deg = 90): CreateItem[] {
  return items.map(it => (it.key === key ? { ...it, turn: normTurn(it.turn + deg) } : it));
}

/** Moves the item at `from` to `to` (clamped). Same array when nothing moves. */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length) return items;
  const dest = Math.max(0, Math.min(items.length - 1, to));
  if (dest === from) return items;
  const next = items.slice();
  const [it] = next.splice(from, 1);
  next.splice(dest, 0, it);
  return next;
}

/** The list without item `key`, and the removed item (whose temps the caller deletes). */
export function removeItem(items: CreateItem[], key: string): { items: CreateItem[]; removed: CreateItem | null } {
  const at = items.findIndex(it => it.key === key);
  if (at < 0) return { items, removed: null };
  return { items: [...items.slice(0, at), ...items.slice(at + 1)], removed: items[at] };
}

/** PDF sources no page refers to any more (their staged files and thumbnails can go). */
export function unusedSources(items: CreateItem[], sources: PdfSource[]): PdfSource[] {
  const used = new Set(items.flatMap(it => (it.kind === 'pdf' ? [it.pdf] : [])));
  return sources.filter(s => !used.has(s.id));
}

/** What the list will be saved as (see the header). */
export function resultKind(items: CreateItem[]): 'pdf' | 'scan' {
  return items.some(it => it.kind === 'pdf') ? 'pdf' : 'scan';
}

/** The secondary line of a row: where the page came from (the title is the source's name). */
export function originLabel(item: CreateItem): string {
  switch (item.kind) {
    case 'image':
      if (item.uncropped) return 'Page edges not found, whole photo kept';
      return item.origin === 'photo' ? 'From your library' : 'Image from Files';
    case 'scan':
      return `Page ${item.index + 1}, scanned`;
    case 'pdf':
      return `Page ${item.index + 1}, PDF`;
  }
}

/** "3 pages" / "1 page". */
export function pagesLabel(n: number): string {
  return `${n} page${n === 1 ? '' : 's'}`;
}

/** The new document's name: what the user typed (tidied, capped), else the automatic one. */
export function createdName(typed: string, fallback: string): { name: string; isDefault: boolean } {
  const t = typed.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return t ? { name: t, isDefault: false } : { name: fallback, isDefault: true };
}

/** Indices of pages chosen in a document's page picker, in page order (all when `all`). */
export function chosenIndices(selected: ReadonlySet<number>, count: number): number[] {
  return Array.from({ length: count }, (_, i) => i).filter(i => selected.has(i));
}

// ── The PDF plan ─────────────────────────────────────────────────────────────

/** One input of the combined PDF, in order: an instance of a source, or the rendered images. */
export type PlanPart = { kind: 'pdf'; source: string; instance: number } | { kind: 'images' };

export type PdfPlanResult = {
  parts: PlanPart[];
  /** Image-like items (image and scan) in list order: the pages of the images part. */
  imageKeys: string[];
  /** pdfEditPages arguments over the combined file. */
  sources: number[];
  rotations: number[];
  /** Page count of the combined file. */
  combinedCount: number;
  /** True when the combined file already is the result (every page once, in order, unturned). */
  identity: boolean;
};

export class CreatePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreatePlanError';
  }
}

/**
 * The plan for making ONE PDF of `items` (see the header). `sources` gives the
 * page count of every PDF source referenced. Throws CreatePlanError when an
 * item names a source or page that doesn't exist.
 */
export function planPdf(items: CreateItem[], sources: Pick<PdfSource, 'id' | 'pageCount'>[]): PdfPlanResult {
  if (items.length === 0) throw new CreatePlanError('no pages');
  const counts = new Map(sources.map(s => [s.id, s.pageCount]));
  // Instances per source, each the set of its pages already used.
  const instances = new Map<string, Set<number>[]>();
  const parts: PlanPart[] = [];
  const imageKeys: string[] = [];
  type Ref = { part: number; page: number };
  const refs: Ref[] = [];
  let imagesPart = -1;
  const imageRefs: number[] = []; // refs index → filled in after the images part's place is known
  for (const it of items) {
    if (it.kind === 'pdf') {
      const count = counts.get(it.pdf);
      if (count == null) throw new CreatePlanError(`unknown source ${it.pdf}`);
      if (!Number.isInteger(it.index) || it.index < 0 || it.index >= count) throw new CreatePlanError(`no page ${it.index}`);
      const list = instances.get(it.pdf) ?? [];
      instances.set(it.pdf, list);
      let k = list.findIndex(used => !used.has(it.index));
      if (k < 0) {
        list.push(new Set());
        k = list.length - 1;
        parts.push({ kind: 'pdf', source: it.pdf, instance: k });
      }
      list[k].add(it.index);
      const part = parts.findIndex(p => p.kind === 'pdf' && p.source === it.pdf && p.instance === k);
      refs.push({ part, page: it.index });
    } else {
      imageRefs.push(refs.length);
      refs.push({ part: -1, page: imageKeys.length });
      imageKeys.push(it.key);
    }
  }
  if (imageKeys.length) {
    parts.push({ kind: 'images' });
    imagesPart = parts.length - 1;
    for (const r of imageRefs) refs[r].part = imagesPart;
  }
  const sizes = parts.map(p => (p.kind === 'images' ? imageKeys.length : counts.get(p.source) ?? 0));
  const offsets: number[] = [];
  let total = 0;
  for (const s of sizes) {
    offsets.push(total);
    total += s;
  }
  const planSources = refs.map(r => offsets[r.part] + r.page);
  const rotations = items.map(it => it.turn);
  const identity =
    planSources.length === total && planSources.every((s, i) => s === i) && rotations.every(r => r === 0);
  return { parts, imageKeys, sources: planSources, rotations, combinedCount: total, identity };
}

// ── Progress ─────────────────────────────────────────────────────────────────

export type CreateProgress = { done: number; total: number };

/** Steps the builder reports: one per page saved (scan), or per image rendered plus merge, arrange and save (pdf). */
export function progressTotal(items: CreateItem[]): number {
  if (resultKind(items) === 'scan') return items.length + 1;
  return items.filter(it => it.kind !== 'pdf').length + 3;
}
