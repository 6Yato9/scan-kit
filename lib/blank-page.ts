// lib/blank-page.ts
// "Add a blank page" for scanned documents: a plain white page, the size of
// the page it follows, inserted after it.
//
// The page is a real JPEG written by this module: a baseline, one-channel
// (grayscale) JPEG whose every 8 × 8 block is the same flat white. Nothing
// native is needed and nothing has to be on screen (a canvas bake would need
// a WebView host), and the file is tiny: two bits per block after the first.
//
// Inserting goes through the same steps as putting a deleted page back
// (lib/page-undo.ts): the new page is written at the end, then the one
// reorder path (lib/files.ts reorderPages) moves it into place, carrying
// every page's shadows (.orig, source photo, geometry) with it. A blank page
// has no shadows of its own: no .orig (its filter is Original) and no source
// photo, so Crop treats it as a plain image.
import { File } from 'expo-file-system';
import type { Document, PageAdjustment, PageFilter } from '../types/document';
import { docDir } from './storage-layout';
import { deleteSinglePage, pageLayoutGeneration, reorderPages } from './files';
import { PAGE_FAMILY_SUFFIXES } from './page-family';
import { insertAt, reinsertOrder } from './page-undo';

// ── The JPEG ─────────────────────────────────────────────────────────────────

/** Canonical Huffman codes for a table given as (code-length counts, symbols). */
function huffmanCodes(counts: number[], symbols: number[]): Map<number, { code: number; len: number }> {
  const out = new Map<number, { code: number; len: number }>();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < (counts[len - 1] ?? 0); i++) {
      out.set(symbols[k++], { code, len });
      code++;
    }
    code <<= 1;
  }
  return out;
}

/** Bits of a DC difference, JPEG style: its size category and the extra bits. */
function dcBits(value: number): { category: number; bits: number } {
  if (value === 0) return { category: 0, bits: 0 };
  const abs = Math.abs(value);
  const category = Math.floor(Math.log2(abs)) + 1;
  // Negative values are sent as their one's complement in `category` bits.
  const bits = value > 0 ? value : (value - 1) & ((1 << category) - 1);
  return { category, bits };
}

class BitWriter {
  private bytes: number[] = [];
  private acc = 0;
  private n = 0;
  write(code: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((code >> i) & 1);
      this.n++;
      if (this.n === 8) this.flushByte();
    }
  }
  private flushByte(): void {
    this.bytes.push(this.acc);
    // A 0xFF in the entropy-coded data is followed by a stuffed 0x00.
    if (this.acc === 0xff) this.bytes.push(0x00);
    this.acc = 0;
    this.n = 0;
  }
  /** Pads the last byte with 1 bits, as the format asks. */
  finish(): number[] {
    if (this.n > 0) this.write((1 << (8 - this.n)) - 1, 8 - this.n);
    return this.bytes;
  }
}

/**
 * A `width` × `height` JPEG of one flat gray level (255 = white), as bytes.
 * Exported for tests (they decode it).
 */
export function solidGrayJpeg(width: number, height: number, level = 255): Uint8Array {
  const w = Math.max(1, Math.min(65535, Math.round(width)));
  const h = Math.max(1, Math.min(65535, Math.round(height)));
  const lvl = Math.max(0, Math.min(255, Math.round(level)));
  // DC of a flat 8 × 8 block after the level shift is 8 × (level − 128);
  // quantised by 8 it is just (level − 128). Every AC coefficient is zero.
  const DC_Q = 8;
  const dc = Math.round((8 * (lvl - 128)) / DC_Q);
  const first = dcBits(dc);
  // Minimal Huffman tables: DC needs "no change" (category 0) and the first
  // block's category; AC needs only end-of-block (symbol 0x00).
  const dcSymbols = first.category === 0 ? [0] : [0, first.category];
  const dcCounts = first.category === 0 ? [1] : [1, 1];
  const acSymbols = [0x00];
  const acCounts = [1];
  const dcCodes = huffmanCodes(dcCounts, dcSymbols);
  const acCodes = huffmanCodes(acCounts, acSymbols);
  const eob = acCodes.get(0x00)!;
  const same = dcCodes.get(0)!;

  const blocks = Math.ceil(w / 8) * Math.ceil(h / 8);
  const bw = new BitWriter();
  for (let b = 0; b < blocks; b++) {
    if (b === 0 && first.category > 0) {
      const c = dcCodes.get(first.category)!;
      bw.write(c.code, c.len);
      bw.write(first.bits, first.category);
    } else {
      bw.write(same.code, same.len);
    }
    bw.write(eob.code, eob.len);
  }
  const scan = bw.finish();

  const out: number[] = [];
  const u16 = (v: number) => out.push((v >> 8) & 0xff, v & 0xff);
  const segment = (marker: number, body: number[]) => {
    out.push(0xff, marker);
    u16(body.length + 2);
    out.push(...body);
  };
  out.push(0xff, 0xd8); // SOI
  // JFIF header, square pixels.
  segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  // One quantisation table: DC 8, every AC 1 (they are all zero anyway).
  segment(0xdb, [0x00, DC_Q, ...new Array(63).fill(1)]);
  // Baseline frame, 8-bit, one component (id 1, 1×1 sampling, table 0).
  segment(0xc0, [8, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 1, 1, 0x11, 0]);
  const table = (cls: number, counts: number[], symbols: number[]) => {
    const c16 = [...counts, ...new Array(16 - counts.length).fill(0)];
    return [(cls << 4) | 0, ...c16, ...symbols];
  };
  segment(0xc4, [...table(0, dcCounts, dcSymbols), ...table(1, acCounts, acSymbols)]);
  // Start of scan: one component, DC table 0 / AC table 0, full spectrum.
  segment(0xda, [1, 1, 0x00, 0, 63, 0]);
  for (const byte of scan) out.push(byte);
  out.push(0xff, 0xd9); // EOI
  return Uint8Array.from(out);
}

/** The size for a blank page next to a page of `like` (falls back to A4 at 200 dpi). */
export function blankPageSize(like: { width: number; height: number } | null | undefined): { width: number; height: number } {
  if (like && like.width > 0 && like.height > 0) return { width: Math.round(like.width), height: Math.round(like.height) };
  return { width: 1654, height: 2339 };
}

// ── Inserting into a document ────────────────────────────────────────────────

/**
 * Writes a blank page after page `after` of document `doc` (the record as
 * stored, read under the page lock by the caller) and moves it into place.
 * Returns the patch for the record: the new page list and the per-page
 * filters / adjustments with an Original, neutral entry for the new page.
 *
 * The caller runs this inside runPageEdit with remap `i => (i > after ? i + 1 : i)`.
 */
export function insertBlankPageFiles(
  doc: Document,
  after: number,
  size: { width: number; height: number },
): Pick<Document, 'pages' | 'filters' | 'adjustments'> {
  const n = doc.pages.length;
  const at = Math.max(0, Math.min(after + 1, n));
  const dir = docDir(doc.id);
  dir.create({ intermediates: true, idempotent: true });
  // Nothing may be left at the new slot from an earlier, interrupted edit:
  // a stale .orig or source photo there would be paired with the blank page.
  for (const suffix of PAGE_FAMILY_SUFFIXES) {
    const stale = new File(dir, `page-${n}${suffix}`);
    try { if (stale.exists) stale.delete(); } catch {}
  }
  const file = new File(dir, `page-${n}.jpg`);
  file.write(solidGrayJpeg(size.width, size.height));
  let pages: string[];
  try {
    pages = at === n ? [...doc.pages.map((_, i) => new File(dir, `page-${i}.jpg`).uri), file.uri] : reorderPages(doc.id, reinsertOrder(n, at));
  } catch (err) {
    try { if (file.exists) file.delete(); } catch {}
    throw err;
  }
  const filters = insertAt(doc.pages.map((_, i) => doc.filters?.[i] ?? ('original' as PageFilter)), at, 'original' as PageFilter);
  const adjustments = insertAt(
    doc.pages.map((_, i): PageAdjustment => doc.adjustments?.[i] ?? { brightness: 0, contrast: 0, saturation: 0 }),
    at,
    { brightness: 0, contrast: 0, saturation: 0 },
  );
  return {
    pages,
    filters: filters.some(f => f !== 'original') ? filters : undefined,
    adjustments: adjustments.some(a => a.brightness || a.contrast || a.saturation || a.sharpness) ? adjustments : undefined,
  };
}

/** What Undo needs to take an inserted blank page out again. */
export type BlankPageUndo = { docId: string; index: number; layout: number };

/** The Undo token for a blank page just inserted at `index`. */
export function blankPageUndo(docId: string, index: number): BlankPageUndo {
  return { docId, index, layout: pageLayoutGeneration(docId) };
}

/**
 * True when Undo may still remove page `undo.index`: no page was moved or
 * deleted since (the index still means the blank page) and the document still
 * has it.
 */
export function canUndoBlankPage(undo: BlankPageUndo, doc: Pick<Document, 'pages'>): boolean {
  return pageLayoutGeneration(undo.docId) === undo.layout && undo.index >= 0 && undo.index < doc.pages.length && doc.pages.length > 1;
}

/** Removes the inserted page (run inside runPageEdit with remapForDelete(index)); returns the record patch. */
export function removeBlankPageFiles(doc: Document, undo: BlankPageUndo): Pick<Document, 'pages' | 'filters' | 'adjustments'> {
  if (!canUndoBlankPage(undo, doc)) throw new Error('blank-page: pages changed since');
  const n = doc.pages.length;
  deleteSinglePage(doc.id, undo.index, n);
  const dir = docDir(doc.id);
  const pages = Array.from({ length: n - 1 }, (_, i) => new File(dir, `page-${i}.jpg`).uri);
  const filters = doc.filters?.filter((_, i) => i !== undo.index);
  const adjustments = doc.adjustments?.filter((_, i) => i !== undo.index);
  return {
    pages,
    filters: filters && filters.some(f => f !== 'original') ? filters : undefined,
    adjustments: adjustments && adjustments.some(a => a.brightness || a.contrast || a.saturation || a.sharpness) ? adjustments : undefined,
  };
}
