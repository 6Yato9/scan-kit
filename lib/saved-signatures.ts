// lib/saved-signatures.ts
//
// The Sign tool remembers the last two signatures used, so signing the next
// document is one tap instead of redrawing. Each is a PNG (dark ink on a
// transparent background, already trimmed) in Documents/signatures/, listed
// newest first in a small JSON index next to them.
//
// Kept outside Documents/scan-kit/ on purpose: the orphan sweep deletes any
// folder there that isn't a document.
import { Directory, File, Paths } from 'expo-file-system';
import type { Signature } from './stamp';

export const MAX_SAVED_SIGNATURES = 2;

export type SavedSignatureEntry = {
  /** Content hash of the PNG data URI, so the same signature is stored once. */
  id: string;
  width: number;
  height: number;
  savedAt: number;
};

export type SavedSignature = SavedSignatureEntry & { uri: string };

const DIR = 'signatures';
const INDEX = 'index.json';
const PNG_PREFIX = 'data:image/png;base64,';

function dir(): Directory {
  return new Directory(Paths.document, DIR);
}

function fileFor(id: string): File {
  return new File(dir(), `${id}.png`);
}

/** Small, stable string hash (FNV-1a, 32-bit) used as a signature's id. */
export function signatureId(dataUri: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < dataUri.length; i++) {
    h ^= dataUri.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `sig-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Puts `entry` first in the index (moving it up if it is already there) and
 * keeps at most `max`. Returns the new index and the entries that fell off,
 * whose files the caller deletes.
 */
export function addToIndex(
  index: SavedSignatureEntry[],
  entry: SavedSignatureEntry,
  max = MAX_SAVED_SIGNATURES,
): { index: SavedSignatureEntry[]; dropped: SavedSignatureEntry[] } {
  const rest = index.filter(e => e.id !== entry.id);
  const next = [entry, ...rest];
  return { index: next.slice(0, max), dropped: next.slice(max) };
}

/** Parses the stored index, dropping anything malformed. */
export function parseIndex(text: string | null | undefined): SavedSignatureEntry[] {
  if (!text) return [];
  try {
    const raw = JSON.parse(text);
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is SavedSignatureEntry =>
        !!e && typeof e.id === 'string' && /^sig-[0-9a-f]{8}$/.test(e.id) &&
        e.width > 0 && e.height > 0 && typeof e.savedAt === 'number',
    );
  } catch {
    return [];
  }
}

function readIndex(): SavedSignatureEntry[] {
  try {
    const f = new File(dir(), INDEX);
    return f.exists ? parseIndex(f.textSync()) : [];
  } catch {
    return [];
  }
}

function writeIndex(index: SavedSignatureEntry[]): void {
  const d = dir();
  d.create({ intermediates: true, idempotent: true });
  const f = new File(d, INDEX);
  if (!f.exists) f.create();
  f.write(JSON.stringify(index));
}

/** The saved signatures, newest first. Entries whose PNG is gone (or empty) are skipped. */
export async function listSavedSignatures(): Promise<SavedSignature[]> {
  return readIndex()
    .map(e => ({ ...e, uri: fileFor(e.id).uri }))
    .filter(e => {
      const f = fileFor(e.id);
      return f.exists && f.size > 0;
    });
}

/** A saved signature as the Signature the Sign tool places (a PNG data URI). */
export async function loadSavedSignature(saved: SavedSignatureEntry): Promise<Signature> {
  const base64 = await fileFor(saved.id).base64();
  return { dataUri: `${PNG_PREFIX}${base64}`, width: saved.width, height: saved.height };
}

/**
 * Writes a signature's PNG unless a complete one is already stored. Written to
 * a side file and renamed into place, so a failed write never leaves an empty
 * PNG under the id — which would be skipped as "already saved" on every later
 * attempt and place nothing when used. An empty file left by an older version
 * is rewritten.
 */
function writePng(id: string, base64: string): void {
  const png = fileFor(id);
  if (png.exists && png.size > 0) return;
  const side = new File(dir(), `${id}.png.new`);
  try {
    if (side.exists) side.delete();
    side.create();
    side.write(base64, { encoding: 'base64' });
    if (!(side.size > 0)) throw new Error('signature PNG came out empty');
    if (png.exists) png.delete();
    side.move(png);
  } catch (err) {
    try { if (side.exists) side.delete(); } catch {}
    throw err;
  }
}

/**
 * Remembers `sig` as the most recent signature. Saving one that is already
 * stored just moves it to the front. Best effort: a signature that couldn't be
 * saved is not worth failing the signing for.
 */
export async function rememberSignature(sig: Signature, now: number = Date.now()): Promise<void> {
  if (!sig.dataUri.startsWith(PNG_PREFIX) || !(sig.width > 0) || !(sig.height > 0)) return;
  try {
    const id = signatureId(sig.dataUri);
    const d = dir();
    d.create({ intermediates: true, idempotent: true });
    writePng(id, sig.dataUri.slice(PNG_PREFIX.length));
    const { index, dropped } = addToIndex(readIndex(), { id, width: sig.width, height: sig.height, savedAt: now });
    writeIndex(index);
    for (const e of dropped) {
      try {
        const f = fileFor(e.id);
        if (f.exists) f.delete();
      } catch {}
    }
  } catch (err) {
    console.warn('Saving the signature failed', err);
  }
}

/** Forgets one saved signature and deletes its file. */
export async function forgetSignature(id: string): Promise<void> {
  writeIndex(readIndex().filter(e => e.id !== id));
  try {
    const f = fileFor(id);
    if (f.exists) f.delete();
  } catch {}
}
