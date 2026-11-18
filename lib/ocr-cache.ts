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
// an earlier page) keeps its identity, so it still hits.
//
// PRIVACY. Recognised text is document content, so entries live INSIDE the
// document's own folder — Documents/scan-kit/<docId>/ocr/<identity>.json — plus
// a small in-memory layer:
//   - anything that deletes a document's folder (Delete forever, Empty trash,
//     the automatic 30-day purge, the startup orphan sweep) deletes its text
//     too, and lib/files deleteDocumentFiles drops the in-memory entries
//     (forgetDocumentOcr);
//   - deleting a page prunes its entry (pruneDocumentOcr, called by
//     lib/files deleteSinglePage), and entries for pixels a page no longer has
//     (before a filter or a rotate) are pruned as soon as the folder holds more
//     entries than the document has pages.
// An image outside a document folder (a tool's temporary photo) is cached in
// memory only. Earlier builds kept every entry in Caches/ocr-lines, where it
// outlived the document; clearLegacyOcrCache() deletes that folder.
import { Directory, File, Paths } from 'expo-file-system';
import { docDir } from './storage-layout';

export type CachedOcr = {
  text: string;
  lines: { text: string; left: number; top: number; width: number; height: number }[];
  /**
   * The user corrected `text` in the Recognized text sheet. `lines` (the
   * positioned words of the searchable PDF's text layer) are still Vision's:
   * a free-text correction can't be placed on the page.
   */
  edited?: true;
};

const LEGACY_DIR_NAME = 'ocr-lines';
const OCR_DIR_NAME = 'ocr';
const MEMORY_ENTRIES = 64;
/** A stored page image: page-3.jpg (not its .orig shadow or a side file). */
const PAGE_FILE = /^page-\d+\.jpg$/;
/** `…/scan-kit/<docId>/<file>` → the folder and the id. */
const DOC_FILE = /^(.*\/scan-kit\/([^/]+))\/[^/]+$/;

type MemoryEntry = { value: CachedOcr; docId: string | null };
const memory = new Map<string, MemoryEntry>();

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

/** The document folder and id a stored page lives in, or null for any other file. */
function docOf(uri: string): { dir: string; id: string } | null {
  const m = uri.split('?')[0].match(DOC_FILE);
  return m ? { dir: m[1], id: m[2] } : null;
}

function safeName(identity: string): string {
  return identity.replace(/[^\w-]/g, '_');
}

function entryFile(docDir: string, identity: string): File {
  return new File(docDir, OCR_DIR_NAME, `${safeName(identity)}.json`);
}

function remember(identity: string, value: CachedOcr, docId: string | null): void {
  memory.delete(identity);
  memory.set(identity, { value, docId });
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

/** The cached result for the image at `uri` with `identity`, or null. Never throws. */
export function readCachedOcr(uri: string, identity: string): CachedOcr | null {
  const doc = docOf(uri);
  const hit = memory.get(identity);
  if (hit) {
    remember(identity, hit.value, hit.docId);
    return hit.value;
  }
  if (!doc) return null;
  try {
    const f = entryFile(doc.dir, identity);
    if (!f.exists) return null;
    const parsed: unknown = JSON.parse(f.textSync());
    if (!isCachedOcr(parsed)) return null;
    remember(identity, parsed, doc.id);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Stores `value` for the image at `uri` with `identity`. Best effort: a failed
 * write only costs a later OCR pass. Never writes for a document whose folder
 * is gone (deleted while Vision was reading), so no text is left behind.
 */
export function writeCachedOcr(uri: string, identity: string, value: CachedOcr): void {
  const doc = docOf(uri);
  if (!doc) {
    remember(identity, value, null);
    return;
  }
  try {
    const docDir = new Directory(doc.dir);
    if (!docDir.exists) return;
    remember(identity, value, doc.id);
    const dir = new Directory(doc.dir, OCR_DIR_NAME);
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const f = entryFile(doc.dir, identity);
    f.create({ overwrite: true });
    f.write(JSON.stringify(value.edited ? { text: value.text, lines: value.lines, edited: true } : { text: value.text, lines: value.lines }));
    pruneIfStale(doc.dir, doc.id);
  } catch {
    // Disk full: the in-memory entry still helps this session.
  }
}

/**
 * Replaces the recognized text of the page image at `uri` with the user's
 * correction, keeping Vision's positioned lines. Only an image that already
 * has an entry for its current pixels can be corrected (read it with
 * recognizeLines first): the correction then lives exactly as long as those
 * pixels, like any entry. Returns false when there is nothing to correct or
 * the folder is gone. Never throws.
 */
export function writeOcrCorrection(uri: string, text: string): boolean {
  const identity = fileIdentity(uri);
  if (!identity) return false;
  const current = readCachedOcr(uri, identity);
  if (!current) return false;
  if (current.text === text) return true;
  const doc = docOf(uri);
  if (doc && !new Directory(doc.dir).exists) return false;
  writeCachedOcr(uri, identity, { text, lines: current.lines, edited: true });
  // writeCachedOcr is best effort; report whether the correction is what the cache now answers.
  return readCachedOcr(uri, identity)?.text === text;
}

function listNames(dir: Directory): string[] {
  try {
    if (!dir.exists) return [];
    return dir
      .list()
      .filter((i): i is File => i instanceof File)
      .map(f => f.uri.replace(/\/+$/, '').split('/').pop() ?? '');
  } catch {
    return [];
  }
}

/** Prunes only when there are more entries than pages, i.e. some are stale (cheap check). */
function pruneIfStale(docDir: string, docId: string): void {
  const entries = listNames(new Directory(docDir, OCR_DIR_NAME)).length;
  const pages = listNames(new Directory(docDir)).filter(n => PAGE_FILE.test(n)).length;
  if (entries > pages) prune(docDir, docId);
}

/** Deletes every entry (disk and memory) that matches none of the document's current page files. */
function prune(docDir: string, docId: string): void {
  const keep = new Set<string>();
  for (const name of listNames(new Directory(docDir))) {
    if (!PAGE_FILE.test(name)) continue;
    const id = fileIdentity(`${docDir}/${name}`);
    if (id) keep.add(id);
  }
  const keepFiles = new Set([...keep].map(id => `${safeName(id)}.json`));
  const dir = new Directory(docDir, OCR_DIR_NAME);
  try {
    if (dir.exists) {
      for (const item of dir.list()) {
        const name = item.uri.replace(/\/+$/, '').split('/').pop() ?? '';
        if (!keepFiles.has(name)) {
          try { item.delete(); } catch {}
        }
      }
    }
  } catch {}
  for (const [identity, entry] of [...memory]) {
    if (entry.docId === docId && !keep.has(identity)) memory.delete(identity);
  }
}

function docDirFor(docId: string): string {
  return docDir(docId).uri.replace(/\/+$/, '');
}

/**
 * Removes the cached text of pages `docId` no longer has (call after deleting
 * a page). Never throws.
 */
export function pruneDocumentOcr(docId: string): void {
  try {
    prune(docDirFor(docId), docId);
  } catch {}
}

/**
 * Forgets everything cached in memory for `docId`. Its entries on disk live in
 * the document's folder and go with it. Call when the folder is deleted.
 */
export function forgetDocumentOcr(docId: string): void {
  for (const [identity, entry] of [...memory]) {
    if (entry.docId === docId) memory.delete(identity);
  }
}

/** Deletes the pre-r6 shared cache folder (Caches/ocr-lines), which outlived deleted documents. */
export function clearLegacyOcrCache(): void {
  try {
    const legacy = new Directory(Paths.cache, LEGACY_DIR_NAME);
    if (legacy.exists) legacy.delete();
  } catch {}
}

/** Tests only. */
export function clearOcrMemoryForTests(): void {
  memory.clear();
}
