// lib/doc-record.ts
// How a document record is written to and read from AsyncStorage
// (lib/storage.ts), with one Android-only twist: a search text (`ocrText`) too
// long for the record lives in a side file in the document's folder.
//
// Why: Android's AsyncStorage reads each value through a SQLite cursor whose
// window is 2 MB. A larger record can't be read back at all ("Row too big to
// fit into CursorWindow"), and the document would drop out of the library. A
// long Book scan's OCR text gets there (PDF text is capped, lib/pdf-text.ts;
// scans' isn't), sooner in Arabic or CJK (2–3 bytes a character in UTF-8).
// iOS has no such limit, and its records are written exactly as before.
//
// Stored forms, both always readable:
//   - inline (every iOS record, every record written before this, every
//     short text): `ocrText` in the record, used as is;
//   - Android, long text: no `ocrText`, and an added optional `ocrTextFile`
//     naming `ocr-text-<hash>.txt` in the document's folder. The name changes
//     with the text, so the record never points at a half-written file, and
//     an unchanged text isn't written again on every patch. Other side files
//     of the document are removed once the record naming the new one is
//     stored (`committed`).
// In memory a document always has its `ocrText` (read back from the file) and
// never `ocrTextFile`, so nothing else in the app sees the difference. A
// missing side file just leaves the document without search text (rebuilt by
// the next OCR / PDF text run), never unreadable.
import { Platform } from 'react-native';
import { File } from 'expo-file-system';
import type { Document } from '../types/document';
import { resolveDocDir } from './storage-layout';

/** UTF-8 bytes of `ocrText` kept in the record; a longer text goes to the side file (Android). */
export const INLINE_TEXT_MAX_BYTES = 512 * 1024;
const SIDE_FILE = /^ocr-text-[0-9a-z]+\.txt$/;

type StoredDoc = Document & { ocrTextFile?: string };

/** UTF-8 length of `s` (a lone surrogate counts as the 3 bytes of U+FFFD). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** The longest prefix of `s` within `maxBytes` of UTF-8 (never splitting a surrogate pair). */
export function truncateUtf8(s: string, maxBytes: number): string {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const pair = c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00;
    const w = c < 0x80 ? 1 : c < 0x800 ? 2 : pair ? 4 : 3;
    if (n + w > maxBytes) return s.slice(0, i);
    n += w;
    if (pair) i++;
  }
  return s;
}

/** FNV-1a over the UTF-16 units, twice (two seeds), base 36: the side file's name. */
export function textHash(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x0100019d);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36) + s.length.toString(36);
}

/** True when `text` must leave the record on `os`. */
export function needsSideFile(text: string | undefined, os: string = Platform.OS): boolean {
  return os === 'android' && typeof text === 'string' && text.length * 3 > INLINE_TEXT_MAX_BYTES
    && utf8Length(text) > INLINE_TEXT_MAX_BYTES;
}

function sideFile(docId: string, name: string): File {
  return new File(resolveDocDir(docId), name);
}

/** Removes the document's side files other than `keep` (best effort). */
function pruneSideFiles(docId: string, keep: string | null): void {
  try {
    const dir = resolveDocDir(docId);
    if (!dir.exists) return;
    for (const item of dir.list()) {
      if (!(item instanceof File)) continue;
      const name = decodeURIComponent(item.uri.split('/').pop() ?? '');
      if (SIDE_FILE.test(name) && name !== keep) item.delete();
    }
  } catch {}
}

export type EncodedRecord = {
  /** The JSON to store. */
  json: string;
  /** Call once `json` is stored: removes side files the record no longer names (Android). */
  committed: () => void;
};

const NOTHING = () => {};

/**
 * A document as it is stored. iOS (and any short text): exactly
 * JSON.stringify(doc). Android with a long text: the text in a side file. If
 * the side file can't be written, the text is cut to fit the record rather
 * than the save failing (it is only the search index).
 */
export function encodeDocRecord(doc: Document, os: string = Platform.OS): EncodedRecord {
  const { ocrTextFile: _ignored, ...plain } = doc as StoredDoc;
  if (os !== 'android') return { json: JSON.stringify(plain), committed: NOTHING };
  const text = plain.ocrText;
  if (!needsSideFile(text, os)) {
    // A side file left from a longer text is no longer named by anything.
    return { json: JSON.stringify(plain), committed: () => pruneSideFiles(plain.id, null) };
  }
  const name = `ocr-text-${textHash(text!)}.txt`;
  try {
    const file = sideFile(plain.id, name);
    if (!file.exists || file.size !== utf8Length(text!)) {
      // Written beside, then moved in: the name is never a partial file.
      const tmp = sideFile(plain.id, `.${name}.part`);
      if (tmp.exists) tmp.delete();
      tmp.create({ intermediates: true });
      tmp.write(text!);
      if (file.exists) file.delete();
      tmp.move(file);
    }
    const { ocrText: _moved, ...rest } = plain;
    return { json: JSON.stringify({ ...rest, ocrTextFile: name }), committed: () => pruneSideFiles(plain.id, name) };
  } catch {
    return { json: JSON.stringify({ ...plain, ocrText: truncateUtf8(text!, INLINE_TEXT_MAX_BYTES) }), committed: NOTHING };
  }
}

/**
 * A stored document back in memory: the side-file text read in (unless
 * `withText` is false: callers that only need its files skip the read), and
 * `ocrTextFile` dropped. Throws on corrupt JSON, as JSON.parse does.
 */
export function decodeDocRecord(raw: string, withText: boolean = true): Document {
  const parsed = JSON.parse(raw) as StoredDoc;
  if (!parsed || typeof parsed !== 'object' || !('ocrTextFile' in parsed)) return parsed;
  const { ocrTextFile, ...doc } = parsed;
  if (withText && doc.ocrText == null && typeof ocrTextFile === 'string' && SIDE_FILE.test(ocrTextFile)) {
    try {
      const file = sideFile(doc.id, ocrTextFile);
      if (file.exists) doc.ocrText = file.textSync();
    } catch {}
  }
  return doc;
}
