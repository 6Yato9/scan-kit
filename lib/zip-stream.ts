// lib/zip-stream.ts
//
// Writes a ZIP archive straight to a file, a chunk at a time, so packing a
// whole library never holds it in memory. JSZip (used before) needed every
// PDF's bytes in memory and then built a second, full copy of the archive
// before writing it: about twice the library size at the peak, which gets the
// app killed on a library of a few hundred MB.
//
// The archive is a plain "stored" ZIP (no compression: PDFs and JPEGs are
// already compressed, and storing keeps it fast). Each entry's bytes are
// copied from its source file in CHUNK_BYTES pieces through native file
// handles; the CRC-32 is computed on the way and patched into the entry's
// local header afterwards, so readers that check the local header (Archive
// Utility, Files, unzip) all accept it. Peak memory: one chunk plus the
// central directory (about 100 bytes per entry).
//
// Limits: classic ZIP (no ZIP64) — at most 65,535 entries and 4 GB. Past that
// `ZipLimitError` is thrown before anything is written beyond the limit.

import { File } from 'expo-file-system';

/** Bytes copied per read / write. */
export const CHUNK_BYTES = 1024 * 1024;

const MAX_U32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;
/** General purpose flag bit 11: names are UTF-8. */
const FLAG_UTF8 = 0x0800;
const VERSION = 20; // 2.0: stored entries, folders

export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipLimitError';
  }
}

export class ZipCancelledError extends Error {
  constructor() {
    super('ZIP cancelled');
    this.name = 'ZipCancelledError';
  }
}

// ── CRC-32 (IEEE, as ZIP uses) ──────────────────────────────────────────────

let crcTable: Int32Array | null = null;
function table(): Int32Array {
  if (crcTable) return crcTable;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  crcTable = t;
  return t;
}

/** Continues a CRC-32 over `bytes`. Start with 0; the result is unsigned. */
export function crc32(bytes: Uint8Array, crc = 0): number {
  const t = table();
  let c = ~crc;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// ── Little-endian helpers ───────────────────────────────────────────────────

function utf8(s: string): Uint8Array {
  // TextEncoder exists in Hermes and in Node (tests).
  return new TextEncoder().encode(s);
}

/** MS-DOS date and time fields (local time, 2-second resolution, from 1980). */
export function dosDateTime(d: Date): { date: number; time: number } {
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  };
}

type CentralEntry = {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  date: number;
  time: number;
};

function localHeader(e: Omit<CentralEntry, 'offset'>): Uint8Array {
  const out = new Uint8Array(30 + e.name.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, VERSION, true);
  v.setUint16(6, FLAG_UTF8, true);
  v.setUint16(8, 0, true); // stored
  v.setUint16(10, e.time, true);
  v.setUint16(12, e.date, true);
  v.setUint32(14, e.crc, true);
  v.setUint32(18, e.size, true);
  v.setUint32(22, e.size, true);
  v.setUint16(26, e.name.length, true);
  v.setUint16(28, 0, true);
  out.set(e.name, 30);
  return out;
}

function centralHeader(e: CentralEntry): Uint8Array {
  const out = new Uint8Array(46 + e.name.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, VERSION, true); // made by: MS-DOS, 2.0
  v.setUint16(6, VERSION, true);
  v.setUint16(8, FLAG_UTF8, true);
  v.setUint16(10, 0, true);
  v.setUint16(12, e.time, true);
  v.setUint16(14, e.date, true);
  v.setUint32(16, e.crc, true);
  v.setUint32(20, e.size, true);
  v.setUint32(24, e.size, true);
  v.setUint16(28, e.name.length, true);
  // extra, comment, disk, internal attrs: 0; external attrs: 0
  v.setUint32(42, e.offset, true);
  out.set(e.name, 46);
  return out;
}

function endOfCentralDirectory(count: number, size: number, offset: number): Uint8Array {
  const out = new Uint8Array(22);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, count, true);
  v.setUint16(10, count, true);
  v.setUint32(12, size, true);
  v.setUint32(16, offset, true);
  return out;
}

const yieldToUi = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export type ZipWriterOptions = {
  signal?: AbortSignal;
  /** Bytes per read / write. Default CHUNK_BYTES. */
  chunkBytes?: number;
};

/**
 * A ZIP file being written. Add entries one by one (each copied from a file in
 * chunks), then `finish()`. On any failure or cancel call `abort()`, which
 * closes and deletes the partial archive.
 */
export class ZipFileWriter {
  private readonly out: File;
  private handle: ReturnType<File['open']> | null;
  private readonly entries: CentralEntry[] = [];
  private readonly names = new Set<string>();
  private position = 0;
  private readonly chunk: number;
  private readonly signal?: AbortSignal;

  constructor(uri: string, options: ZipWriterOptions = {}) {
    this.out = new File(uri.split('?')[0]);
    this.out.create({ overwrite: true });
    this.handle = this.out.open();
    this.chunk = Math.max(1, options.chunkBytes ?? CHUNK_BYTES);
    this.signal = options.signal;
  }

  get uri(): string {
    return this.out.uri;
  }

  /** Bytes written so far. */
  get bytesWritten(): number {
    return this.position;
  }

  private check(): void {
    if (this.signal?.aborted) throw new ZipCancelledError();
    if (!this.handle) throw new Error('ZIP writer is closed');
  }

  private write(bytes: Uint8Array): void {
    this.handle!.writeBytes(bytes);
    this.position += bytes.length;
  }

  /**
   * Copies the file at `sourceUri` into the archive as `name`, reading
   * `chunkBytes` at a time. `onBytes(copied, total)` reports progress.
   */
  async addFile(
    name: string,
    sourceUri: string,
    options: { date?: Date; onBytes?: (copied: number, total: number) => void } = {},
  ): Promise<void> {
    this.check();
    if (this.entries.length >= MAX_ENTRIES) throw new ZipLimitError('Too many files for one ZIP archive.');
    if (this.names.has(name.toLowerCase())) throw new Error(`Duplicate ZIP entry: ${name}`);
    const source = new File(sourceUri.split('?')[0]);
    if (!source.exists) throw new Error(`ZIP source missing: ${name}`);
    const total = source.size ?? 0;
    const nameBytes = utf8(name);
    const { date, time } = dosDateTime(options.date ?? new Date());
    const offset = this.position;
    if (offset + 30 + nameBytes.length + total > MAX_U32) {
      throw new ZipLimitError('The documents are too large for one ZIP file (over 4 GB).');
    }

    // Header first with a zero CRC, patched once the bytes have been seen.
    this.write(localHeader({ name: nameBytes, crc: 0, size: total, date, time }));
    const input = source.open();
    let crc = 0;
    let copied = 0;
    try {
      while (copied < total) {
        this.check();
        const bytes = input.readBytes(Math.min(this.chunk, total - copied));
        if (bytes.length === 0) break; // the file shrank under us
        crc = crc32(bytes, crc);
        this.write(bytes);
        copied += bytes.length;
        options.onBytes?.(copied, total);
        await yieldToUi();
      }
    } finally {
      input.close();
    }

    // CRC and sizes (the copied count, should the file have changed size).
    const patch = new Uint8Array(12);
    const v = new DataView(patch.buffer);
    v.setUint32(0, crc, true);
    v.setUint32(4, copied, true);
    v.setUint32(8, copied, true);
    const end = this.position;
    this.handle!.offset = offset + 14;
    this.handle!.writeBytes(patch);
    this.handle!.offset = end;

    this.entries.push({ name: nameBytes, crc, size: copied, offset, date, time });
    this.names.add(name.toLowerCase());
  }

  /** Writes the central directory and closes the file. Returns the archive URI. */
  finish(): string {
    this.check();
    const cdOffset = this.position;
    let cdSize = 0;
    for (const e of this.entries) {
      const h = centralHeader(e);
      this.write(h);
      cdSize += h.length;
    }
    if (cdOffset + cdSize > MAX_U32) throw new ZipLimitError('The documents are too large for one ZIP file (over 4 GB).');
    this.write(endOfCentralDirectory(this.entries.length, cdSize, cdOffset));
    this.handle!.close();
    this.handle = null;
    return this.out.uri;
  }

  /** Closes and deletes the partial archive. Safe to call more than once. */
  abort(): void {
    try { this.handle?.close(); } catch {}
    this.handle = null;
    try { if (this.out.exists) this.out.delete(); } catch {}
  }
}

/** One file to pack: `produce` makes (or locates) it just before it is copied. */
export type ZipItem = {
  name: string;
  date?: Date;
  /** `temporary`: delete the file once it is in the archive (a freshly made PDF). */
  produce: () => Promise<{ uri: string; temporary: boolean }>;
};

/**
 * Writes `items` into a new ZIP at `zipUri`, one at a time: each is produced,
 * copied in chunks and (when temporary) deleted before the next is made, so at
 * most one item's file exists outside the archive and nothing is held in
 * memory beyond one chunk. On any error or cancel the partial archive (and the
 * item in flight) is deleted and the error rethrown. Resolves to the URI.
 */
export async function zipFiles(
  zipUri: string,
  items: ZipItem[],
  options: ZipWriterOptions & {
    /** Called before item `index` is produced. */
    onItem?: (index: number) => void;
    onBytes?: (index: number, copied: number, total: number) => void;
  } = {},
): Promise<string> {
  const writer = new ZipFileWriter(zipUri, options);
  try {
    for (let i = 0; i < items.length; i++) {
      if (options.signal?.aborted) throw new ZipCancelledError();
      options.onItem?.(i);
      const item = items[i];
      const { uri, temporary } = await item.produce();
      try {
        await writer.addFile(item.name, uri, {
          date: item.date,
          onBytes: (copied, total) => options.onBytes?.(i, copied, total),
        });
      } finally {
        if (temporary) {
          try { new File(uri.split('?')[0]).delete(); } catch {}
        }
      }
    }
    return writer.finish();
  } catch (err) {
    writer.abort();
    throw err;
  }
}
