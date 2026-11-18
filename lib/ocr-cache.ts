// lib/ocr-cache.ts
//
// Remembers what text recognition found on a page image, so the searchable
// PDF export doesn't run Vision on every page again: the text index
// (lib/save-scan.ts indexDocText) has already read each page once, right after
// the scan was enhanced.
//
// An entry is keyed by the image file's IDENTITY — its byte size and
// modification time — not by its path. Every edit that changes a page's pixels
// (a filter bake, rotate, crop, mark-up, retake) writes a new file, so its
// identity changes and the old entry simply stops matching: a stale result can
// never be used for new pixels. A page that is only renamed (reorder, delete of
// an earlier page) keeps its identity, and a copy that keeps the file's
// modification time (Extract pages) does too, so both still hit.
//
// Entries live in Caches/ocr-lines (iOS may purge it; a miss just means OCR
// runs again) plus a small in-memory layer. The folder is trimmed to the most
// recent MAX_ENTRIES files.
import { Directory, File, Paths } from 'expo-file-system';

export type CachedOcr = {
  text: string;
  lines: { text: string; left: number; top: number; width: number; height: number }[];
};

const DIR_NAME = 'ocr-lines';
const MAX_ENTRIES = 400;
const TRIM_TO = 300;
const MEMORY_ENTRIES = 64;
/** Check the folder size every this many writes, not on every one. */
const TRIM_EVERY = 25;

const memory = new Map<string, CachedOcr>();
let writesSinceTrim = TRIM_EVERY; // trim on the first write of a session

/**
 * The identity of the image at `uri`: `<bytes>-<mtime ms>`, or null when the
 * file is missing or can't be read (then nothing is cached for it).
 */
export function fileIdentity(uri: string): string | null {
  try {
    const f = new File(uri.split('?')[0]);
    if (!f.exists) return null;
    const size = f.size;
    const mtime = f.modificationTime;
    if (!size || mtime == null) return null;
    return `${size}-${Math.round(mtime)}`;
  } catch {
    return null;
  }
}

function entryFile(identity: string): File {
  return new File(Paths.cache, DIR_NAME, `${identity.replace(/[^\w-]/g, '_')}.json`);
}

function remember(identity: string, value: CachedOcr): void {
  memory.delete(identity);
  memory.set(identity, value);
  while (memory.size > MEMORY_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

function isCachedOcr(v: unknown): v is CachedOcr {
  const o = v as CachedOcr;
  return !!o && typeof o.text === 'string' && Array.isArray(o.lines);
}

/** The cached result for `identity`, or null. Never throws. */
export function readCachedOcr(identity: string): CachedOcr | null {
  const hit = memory.get(identity);
  if (hit) {
    remember(identity, hit);
    return hit;
  }
  try {
    const f = entryFile(identity);
    if (!f.exists) return null;
    const parsed: unknown = JSON.parse(f.textSync());
    if (!isCachedOcr(parsed)) return null;
    remember(identity, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/** Stores `value` for `identity`. Best effort: a failed write only costs a later OCR pass. */
export function writeCachedOcr(identity: string, value: CachedOcr): void {
  remember(identity, value);
  try {
    const dir = new Directory(Paths.cache, DIR_NAME);
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const f = entryFile(identity);
    f.create({ overwrite: true });
    f.write(JSON.stringify({ text: value.text, lines: value.lines }));
    if (++writesSinceTrim >= TRIM_EVERY) {
      writesSinceTrim = 0;
      trim(dir);
    }
  } catch {
    // Disk full or Caches unavailable: the in-memory entry still helps this session.
  }
}

/** Deletes the oldest entries once the folder holds more than MAX_ENTRIES. */
function trim(dir: Directory): void {
  const files = dir.list().filter((i): i is File => i instanceof File);
  if (files.length <= MAX_ENTRIES) return;
  const dated = files.map(f => {
    let t = 0;
    try { t = f.modificationTime ?? 0; } catch {}
    return { f, t };
  });
  dated.sort((a, b) => a.t - b.t);
  for (const { f } of dated.slice(0, dated.length - TRIM_TO)) {
    try { f.delete(); } catch {}
  }
}

/** Tests only. */
export function clearOcrMemoryForTests(): void {
  memory.clear();
  writesSinceTrim = TRIM_EVERY;
}
