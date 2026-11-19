// lib/pdf-session.ts
//
// Password-protected PDFs, unlocked for this session only. The stored PDF
// stays encrypted (Tools › Protect PDF means something inside Scan Kit too);
// the password the user types in the viewer opens it until the session ends:
//
//  - The password is kept in memory only (docId → password), never written,
//    never logged.
//  - Reading the PDF's content goes through a decrypted working copy in
//    Caches/pdf-session/<process>/ (VisionOcr.unlockPdf: a faithful copy that
//    keeps forms, annotations and bookmarks). Everything that reads a PDF's
//    pages, text or form asks readablePdfUri(doc) for the file to read: the
//    session copy when the document is unlocked, the stored file otherwise —
//    a protected PDF that isn't unlocked then reports "locked" from native,
//    exactly as before.
//  - The copy is keyed to the exact stored bytes it came from (size + MD5).
//    A cheap stat key (size, mtime and a generation that every in-place write
//    and Undo bumps through noteStoredPdfReplaced — Undo puts back a
//    byte-identical copy that may keep its old mtime, the trap
//    lib/pdf-thumb.ts describes)
//    says when the MD5 must be checked again; after any change to the stored
//    file the next read re-derives the copy with the remembered password. A
//    stale copy is never returned, and in-place writes check the MD5 itself.
//  - In-place writes (lib/pdf-edit.ts rewriteStoredPdf) write from the copy,
//    then encrypt the result again before swapping it in, keeping the
//    protection exactly (VisionOcr.protectPdfKeeping): the same open
//    password, a separate owner password (random; the same one when the file
//    had user = owner) and the author's permission bits. What the
//    permissions allow (read with the password at unlock time) is checked
//    here, because the decrypted copy allows everything. A PDF opened with
//    its OWNER password can't be written back (its open password isn't
//    known): in-place edits are refused, pointing to Unlock PDF. A build
//    without protectPdfKeeping refuses in-place edits of a PDF with any
//    restriction rather than weaken it.
//  - The decrypted intermediate of a write lives here too (newSessionWorkFile),
//    never in Application Support, which backups include.
//
// When the session ends (installPdfSessionWatch):
//  - App Lock on: the moment the app goes to the background (App Lock locks
//    then anyway, components/lock-gate.tsx).
//  - App Lock off: when the app comes back after more than SESSION_IDLE_MS in
//    the background (checked on 'active': iOS runs no timers in a suspended
//    app).
//  - A document's session also ends when it is trashed or deleted, when its
//    PDF no longer needs a password (Unlock PDF, an Undo of Protect PDF), or
//    when the password stops opening it.
// Listeners are told FIRST (a viewer stops showing the copy and goes back to
// its "Enter password" state); the files are deleted a moment later, never
// from under a PDF view that is still showing one — except when the app goes
// to the background, where nothing is on screen and a timer may never run:
// then they are deleted at once (an open file survives its unlink), and
// anything left is swept the next time the app is active. The launch sweep
// (lib/files.ts TEMP_DIRS) and the first use in a new process remove what a
// crash or a kill left behind.
//
// Nothing derived from a protected PDF is persisted: no search text
// (lib/pdf-text.ts reads the stored file only), no card thumbnail (lib/pdf-thumb
// renders the stored file; page renders of a session copy go into its scratch
// folder here), no ocrText from an in-place write.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import { VisionOcr, type NativePdfPermissions } from '../modules/vision-ocr/src';

/** App Lock off: the session ends when the app returns after this long in the background. */
export const SESSION_IDLE_MS = 5 * 60 * 1000;
/** Files of an ended session (or a replaced copy) are deleted this long after listeners were told. */
export const SESSION_FILE_GRACE_MS = 2000;

/** Caches/pdf-session (also swept at launch, lib/files.ts TEMP_DIRS). */
export const SESSION_DIR = 'pdf-session';

export type PdfSessionErrorKind = 'wrong-password' | 'locked' | 'restricted' | 'unavailable' | 'missing' | 'failed';

/**
 * Messages match what the other PDF classifiers already read: 'locked',
 * 'restricted' and 'wrong-password' (lib/pdf-edit.ts, lib/convert-pdf.ts).
 */
export class PdfSessionError extends Error {
  readonly kind: PdfSessionErrorKind;
  constructor(kind: PdfSessionErrorKind, message: string = kind) {
    super(message);
    this.name = 'PdfSessionError';
    this.kind = kind;
  }
}

/** A permission an operation needs (the eight PDF permission bits). */
export type PdfPermission = keyof NativePdfPermissions;

const ALL_ALLOWED: NativePdfPermissions = {
  printLow: true,
  printHigh: true,
  changeContent: true,
  assemblePages: true,
  copy: true,
  accessibility: true,
  comment: true,
  fillForms: true,
};

/** The first of `needs` that `permissions` doesn't allow, or null (pure). */
export function missingPermission(permissions: NativePdfPermissions, needs: readonly PdfPermission[] = []): PdfPermission | null {
  for (const n of needs) if (!permissions[n]) return n;
  return null;
}

/**
 * Whether the session ends on this app state change (pure; see the header).
 * `backgroundedAt`: when the app last went to the background, or null.
 */
export function sessionEndsOn(
  next: AppStateStatus,
  appLockOn: boolean,
  backgroundedAt: number | null,
  now: number,
): boolean {
  if (next === 'background') return appLockOn;
  if (next === 'active') return backgroundedAt !== null && now - backgroundedAt > SESSION_IDLE_MS;
  return false;
}

// ── State ────────────────────────────────────────────────────────────────────

type Print = { size: number | null; md5: string | null };
type Copy = {
  /** The decrypted working copy (file://). */
  uri: string;
  /** The stored bytes it was made from. */
  source: Print;
  /** The stored file's stat key when `source` was last checked (see the header). */
  stat: string;
};
/**
 * How an in-place write keeps the protection (decided at unlock time):
 * - 'user': opened with the open password; written back with it, a random
 *   owner password and `bits` (the author's exact permissions).
 * - 'same': the password is both the open and the owner password; written
 *   back the same way.
 * - 'owner-only': opened with the owner password; the open password is
 *   unknown, so it can't be written back.
 */
export type KeepProtection = { mode: 'user' | 'same'; bits: number } | { mode: 'owner-only' };

type Entry = {
  password: string;
  permissions: NativePdfPermissions;
  keep: KeepProtection;
  /** An in-place write in progress (readers wait for it, then see its result). */
  writing: Promise<void> | null;
  copy: Copy | null;
  /** The derivation in progress (one at a time per document). */
  busy: Promise<unknown> | null;
};

const sessions = new Map<string, Entry>();
/** Document id → how many times its stored PDF was replaced in place this process. */
const generations = new Map<string, number>();
const listeners = new Set<(docId: string) => void>();
/** Bumped on every change, for useSyncExternalStore snapshots. */
const revs = new Map<string, number>();
let seq = 0;
/** This process: earlier processes' folders are removed on first use. */
const PROCESS = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let swept = false;

const clean = (uri: string) => uri.split('?')[0];

function root(): Directory {
  return new Directory(Paths.cache, SESSION_DIR);
}

/** Copies left by a crash, a kill or a JS reload: nothing here outlives its process. */
function sweepEarlierProcesses(): void {
  if (swept) return;
  swept = true;
  try {
    const r = root();
    if (!r.exists) return;
    for (const item of r.list()) {
      if (!item.uri.replace(/\/+$/, '').endsWith(`/${PROCESS}`)) deleteQuietly(item);
    }
  } catch {}
}

function processDir(): Directory {
  sweepEarlierProcesses();
  const dir = new Directory(Paths.cache, SESSION_DIR, PROCESS);
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function deleteQuietly(item: File | Directory | null | undefined): void {
  try {
    if (item?.exists) item.delete();
  } catch {}
}

function printOf(uri: string): Print {
  const f = new File(clean(uri));
  let size: number | null = null;
  let md5: string | null = null;
  try { size = typeof f.size === 'number' ? f.size : null; } catch {}
  try { md5 = typeof f.md5 === 'string' ? f.md5 : null; } catch {}
  return { size, md5 };
}

/** Both known and equal (an unreadable print never matches). */
function samePrint(a: Print, b: Print): boolean {
  return a.size !== null && a.md5 !== null && a.size === b.size && a.md5 === b.md5;
}

function statKey(docId: string, uri: string): string {
  try {
    const f = new File(clean(uri));
    if (!f.exists) return 'gone';
    return `${f.size}-${Math.round(f.modificationTime ?? 0)}-g${generations.get(docId) ?? 0}`;
  } catch {
    return 'unknown';
  }
}

function exists(uri: string): boolean {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

function emit(docId: string): void {
  revs.set(docId, ++seq);
  for (const l of [...listeners]) {
    try { l(docId); } catch {}
  }
}

/** Deletes a copy and its scratch folder after the grace period (see the header). */
function retire(copyUri: string | null | undefined, now = false): void {
  if (!copyUri) return;
  const remove = () => {
    deleteQuietly(new File(copyUri));
    deleteQuietly(scratchFor(copyUri));
  };
  if (now) {
    remove();
    return;
  }
  const t = setTimeout(remove, SESSION_FILE_GRACE_MS);
  (t as { unref?: () => void }).unref?.();
}

function scratchFor(copyUri: string): Directory {
  return new Directory(clean(copyUri).replace(/\.pdf$/i, '-scratch'));
}

function newCopyFile(docId: string): File {
  seq += 1;
  return new File(processDir(), `${docId}-${Date.now().toString(36)}-${seq}.pdf`);
}

// ── Availability ─────────────────────────────────────────────────────────────

/** True when this build can open a protected PDF for the session (VisionOcr.unlockPdf). */
export function canUnlockForSession(): boolean {
  return typeof VisionOcr?.unlockPdf === 'function';
}

/** Maps a native unlock rejection to what the user is told. */
export function unlockErrorKind(err: unknown): 'wrong-password' | 'failed' {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /wrong-password|password|locked/i.test(msg) ? 'wrong-password' : 'failed';
}

/**
 * Document `docId`'s stored PDF was replaced in place (lib/pdf-edit.ts swapIn:
 * edits and their Undo). Its session copy is checked against the new bytes
 * on the next read. Never throws.
 */
export function noteStoredPdfReplaced(docId: string): void {
  generations.set(docId, (generations.get(docId) ?? 0) + 1);
  // Screens showing it read it again (an unlocked one waits for the write in
  // progress, then gets the copy of the new bytes).
  emit(docId);
}

/** Decrypted intermediates of writes in progress (never swept from under them). */
const pendingWork = new Set<string>();

/**
 * A file for a decrypted intermediate (an in-place write's plaintext result),
 * in this process's session folder in Caches — never Application Support,
 * which backups include. `release` forgets it (call it when done; the file is
 * deleted unless it was adopted as the session copy).
 */
export function newSessionWorkFile(docId: string): { file: File; release: () => void } {
  seq += 1;
  const file = new File(processDir(), `work-${docId}-${Date.now().toString(36)}-${seq}.pdf`);
  const key = clean(file.uri);
  pendingWork.add(key);
  return {
    file,
    release: () => {
      pendingWork.delete(key);
      deleteQuietly(new File(key));
    },
  };
}

// ── Queries ──────────────────────────────────────────────────────────────────

/** True while document `docId`'s PDF is unlocked for this session. */
export function isSessionUnlocked(docId: string | null | undefined): boolean {
  return !!docId && sessions.has(docId);
}

/** The session password, for re-protecting a write (lib/pdf-edit.ts) or Unlock PDF; null when not unlocked. */
export function sessionPassword(docId: string): string | null {
  return sessions.get(docId)?.password ?? null;
}

/** What the PDF's permissions allow, opened with the session password; null when not unlocked. */
export function sessionPermissions(docId: string): NativePdfPermissions | null {
  const e = sessions.get(docId);
  return e ? { ...e.permissions } : null;
}

/** True when `uri` is a session copy (or a file in its scratch folder). */
export function isSessionPath(uri: string | null | undefined): boolean {
  return !!uri && clean(uri).includes(`/${SESSION_DIR}/`);
}

/** The document a session copy belongs to, or null. */
function docOfCopy(uri: string): string | null {
  const u = clean(uri);
  for (const [docId, e] of sessions) {
    if (e.copy && (u === e.copy.uri || u.startsWith(`${scratchFor(e.copy.uri).uri.replace(/\/+$/, '')}/`))) return docId;
  }
  return null;
}

/** The permissions behind a session copy at `uri` (null: not a live session copy). */
export function sessionPermissionsForPath(uri: string | null | undefined): NativePdfPermissions | null {
  if (!uri || !isSessionPath(uri)) return null;
  const id = docOfCopy(uri);
  return id ? sessionPermissions(id) : null;
}

/**
 * A folder beside session copy `uri` for renders made from it (page
 * thumbnails, Fill & sign previews): deleted with the copy. Null when `uri`
 * isn't a session copy.
 */
export function sessionScratchDir(uri: string | null | undefined): Directory | null {
  if (!uri || !isSessionPath(uri)) return null;
  const dir = scratchFor(uri);
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** Calls `fn(docId)` when a document's session starts, ends or its copy changes. */
export function subscribePdfSessions(fn: (docId: string) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** A value that changes whenever `docId`'s session does (useSyncExternalStore). */
export function sessionSnapshot(docId: string | null | undefined): string {
  if (!docId) return '-';
  return `${sessions.has(docId) ? 'u' : 'l'}${revs.get(docId) ?? 0}`;
}

// ── Starting and ending ──────────────────────────────────────────────────────

const NO_CHANGES = { assemblePages: false, changeContent: false, comment: false, fillForms: false };
/** PDFKit's PDFAccessPermissions bits for "everything allowed" (older builds). */
const ALL_BITS = 0xff;

/** What the password allows, and how a write keeps the protection (pure). */
export function sessionAccessOf(
  info: { locked?: boolean; passwordAccepted?: boolean; permissions?: Partial<NativePdfPermissions>; ownerUnlocked?: boolean; userPassword?: boolean | null; permissionBits?: number } | null,
): { permissions: NativePdfPermissions; keep: KeepProtection } {
  if (!info || info.locked || !info.passwordAccepted) return { permissions: { ...ALL_ALLOWED, ...NO_CHANGES }, keep: { mode: 'owner-only' } };
  const permissions = { ...ALL_ALLOWED, ...info.permissions };
  const bits = typeof info.permissionBits === 'number' ? info.permissionBits : ALL_BITS;
  if (info.ownerUnlocked) {
    // Owner status: the same password opens it only when it is also the user one.
    return { permissions, keep: info.userPassword === true ? { mode: 'same', bits } : { mode: 'owner-only' } };
  }
  return { permissions, keep: { mode: 'user', bits } };
}

async function readAccess(stored: string, password: string): Promise<{ permissions: NativePdfPermissions; keep: KeepProtection }> {
  const read = VisionOcr?.pdfPermissions;
  // Older builds can't say: everything allowed once unlocked (the old
  // permanent unlock removed every restriction), written back as before.
  if (typeof read !== 'function') return { permissions: { ...ALL_ALLOWED }, keep: { mode: 'same', bits: ALL_BITS } };
  try {
    const info = await read(stored, password);
    // Builds before round 14 don't say which password it was: as a user's.
    if (info && !info.locked && info.passwordAccepted && info.ownerUnlocked === undefined) {
      return { permissions: { ...ALL_ALLOWED, ...info.permissions }, keep: { mode: 'user', bits: -1 } };
    }
    return sessionAccessOf(info);
  } catch {
    // Unknown: refuse changes rather than allow what the author may forbid.
    return { permissions: { ...ALL_ALLOWED, ...NO_CHANGES }, keep: { mode: 'owner-only' } };
  }
}

/** True when every permission is granted (nothing the author restricts). */
export function allAllowed(p: NativePdfPermissions): boolean {
  return (Object.keys(ALL_ALLOWED) as PdfPermission[]).every(k => p[k]);
}

/** What the screens say for the two refusals only protected PDFs get (lib/pdf-edit messages). */
export const PROTECTED_EDIT_REFUSALS = {
  'owner-password': {
    title: 'Remove its password first',
    body: 'This PDF was opened with its owner password. Remove its password with Unlock PDF to edit it.',
  },
  'keep-unavailable': {
    title: 'This PDF can’t be changed here',
    body: 'This version of Scan Kit can’t keep its restrictions after a change. Update Scan Kit to edit it. Your PDF is unchanged.',
  },
} as const;

/** The refusal copy for an error from an in-place edit of a protected PDF, or null. */
export function protectedEditRefusal(err: unknown): { title: string; body: string } | null {
  const msg = err instanceof Error ? err.message : '';
  return msg === 'owner-password' || msg === 'keep-unavailable' ? PROTECTED_EDIT_REFUSALS[msg] : null;
}

/** Said after making an unprotected document from a PDF unlocked this session. */
export const NO_PASSWORD_NOTE = 'The new PDF doesn’t need a password.';

/**
 * `message` with NO_PASSWORD_NOTE added when any of `docIds` is unlocked this
 * session: a merge, split, flattened copy or Create PDF made from it is a new,
 * unprotected document, said when it is made (no confirm in the way).
 */
export function withNoPasswordNote(message: string, docIds: readonly (string | null | undefined)[]): string {
  if (!docIds.some(id => isSessionUnlocked(id))) return message;
  return `${/[.!?]$/.test(message) ? message : `${message}.`} ${NO_PASSWORD_NOTE}`;
}

/** A merge source needs its password: what to do now that unlocking lasts only for the session. */
export const LOCKED_MERGE_BODY = 'Open it and enter its password, then merge again before you leave Scan Kit.';

/** Why `docId` (unlocked) can't be changed in place, or null. */
export function sessionEditBlock(docId: string): 'owner-password' | null {
  return sessions.get(docId)?.keep.mode === 'owner-only' ? 'owner-password' : null;
}

/**
 * Unlocks document `doc`'s PDF for this session with `password`: checks it
 * (by making the working copy with it) and remembers it in memory. The stored
 * file is not touched. Rejects with PdfSessionError ('wrong-password',
 * 'unavailable', 'missing', 'failed').
 */
export async function unlockForSession(doc: { id: string; pdfUri?: string | null }, password: string): Promise<void> {
  const unlock = VisionOcr?.unlockPdf;
  if (typeof unlock !== 'function') throw new PdfSessionError('unavailable', 'unlockPdf missing');
  if (!doc.pdfUri) throw new PdfSessionError('missing', 'not a PDF document');
  if (!password) throw new PdfSessionError('wrong-password');
  const stored = clean(doc.pdfUri);
  if (!exists(stored)) throw new PdfSessionError('missing', 'stored PDF missing');
  const before = printOf(stored);
  const stat = statKey(doc.id, stored);
  const out = newCopyFile(doc.id);
  try {
    await unlock(stored, out.uri, password);
  } catch (err) {
    deleteQuietly(out);
    const kind = unlockErrorKind(err);
    throw new PdfSessionError(kind, kind === 'wrong-password' ? 'wrong-password' : 'unlock failed');
  }
  if (!out.exists) throw new PdfSessionError('failed', 'no output');
  if (!samePrint(printOf(stored), before)) {
    // Rewritten while it was being opened: the copy would describe old bytes.
    deleteQuietly(out);
    throw new PdfSessionError('failed', 'changed while unlocking');
  }
  const { permissions, keep } = await readAccess(stored, password);
  const old = sessions.get(doc.id);
  sessions.set(doc.id, { password, permissions, keep, writing: null, copy: { uri: out.uri, source: before, stat }, busy: null });
  emit(doc.id);
  retire(old?.copy?.uri);
}

/**
 * Ends the session of `docId` (or of every document): listeners are told
 * first, the copies are deleted a moment later. Never throws.
 */
export function forgetSession(docId?: string, options: { now?: boolean } = {}): void {
  const ids = docId ? (sessions.has(docId) ? [docId] : []) : [...sessions.keys()];
  const copies: (string | null)[] = [];
  for (const id of ids) {
    copies.push(sessions.get(id)?.copy?.uri ?? null);
    sessions.delete(id);
  }
  for (const id of ids) emit(id);
  for (const c of copies) retire(c, options.now);
}

/**
 * Deletes every file in this process's session folder that isn't a live
 * session's copy (or its scratch): what a retire timer that never ran (the
 * app was suspended) left behind. Never throws.
 */
export function sweepEndedSessionFiles(): void {
  try {
    const dir = new Directory(Paths.cache, SESSION_DIR, PROCESS);
    if (!dir.exists) return;
    const live = new Set<string>();
    for (const e of sessions.values()) {
      if (!e.copy) continue;
      live.add(clean(e.copy.uri));
      live.add(scratchFor(e.copy.uri).uri.replace(/\/+$/, ''));
    }
    for (const item of dir.list()) {
      const u = clean(item.uri).replace(/\/+$/, '');
      if (!live.has(u) && !pendingWork.has(u)) deleteQuietly(item);
    }
  } catch {}
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** Runs `fn` after any derivation already running for `docId` (one at a time). */
async function serial<T>(entry: Entry, fn: () => Promise<T>): Promise<T> {
  while (entry.busy) {
    try { await entry.busy; } catch {}
  }
  const p = fn();
  entry.busy = p;
  try {
    return await p;
  } finally {
    if (entry.busy === p) entry.busy = null;
  }
}

/**
 * The live session copy of `docId` for the stored file at `stored`, made
 * again from the stored bytes when they changed. `verify`: always check the
 * MD5 (writes). Null when the session ended meanwhile (or just now: the
 * stored PDF no longer needs this password).
 */
async function liveCopy(docId: string, stored: string, verify: boolean): Promise<string | null> {
  const entry = sessions.get(docId);
  if (!entry) return null;
  // A reader waits for an in-place write in progress: it then gets the copy
  // the write adopted instead of decrypting the new file again.
  if (!verify) {
    while (entry.writing) {
      try { await entry.writing; } catch {}
    }
  }
  return serial(entry, async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (sessions.get(docId) !== entry) return null;
      const stat = statKey(docId, stored);
      const copy = entry.copy;
      if (copy && exists(copy.uri)) {
        if (!verify && copy.stat === stat) return copy.uri;
        const now = printOf(stored);
        if (samePrint(now, copy.source)) {
          copy.stat = stat;
          return copy.uri;
        }
      }
      // The stored file changed (an edit, an Undo, a tool): make the copy again.
      const result = await derive(docId, entry, stored);
      if (result !== 'retry') return result;
    }
    throw new PdfSessionError('failed', 'the PDF kept changing');
  });
}

async function derive(docId: string, entry: Entry, stored: string): Promise<string | null | 'retry'> {
  const unlock = VisionOcr?.unlockPdf;
  if (typeof unlock !== 'function') throw new PdfSessionError('unavailable', 'unlockPdf missing');
  if (!exists(stored)) throw new PdfSessionError('missing', 'stored PDF missing');
  const before = printOf(stored);
  const stat = statKey(docId, stored);
  // Still protected? (An Undo of Protect PDF, Unlock PDF in place.) Then the
  // session has nothing to unlock: it ends, and the stored file is read as is.
  const info = VisionOcr?.pdfInfo;
  if (typeof info === 'function') {
    const i = await info(stored, null).catch(() => null);
    if (i && !i.locked) {
      endBecause(docId, entry);
      return null;
    }
  }
  const out = newCopyFile(docId);
  try {
    await unlock(stored, out.uri, entry.password);
  } catch (err) {
    deleteQuietly(out);
    if (unlockErrorKind(err) === 'wrong-password') {
      // A different file is there now (another password): ask again.
      endBecause(docId, entry);
      return null;
    }
    throw new PdfSessionError('failed', 'unlock failed');
  }
  if (!out.exists) throw new PdfSessionError('failed', 'no output');
  if (!samePrint(printOf(stored), before)) {
    deleteQuietly(out);
    return 'retry';
  }
  if (sessions.get(docId) !== entry) {
    deleteQuietly(out);
    return null;
  }
  const old = entry.copy;
  entry.copy = { uri: out.uri, source: before, stat };
  if (old && old.uri !== out.uri) {
    emit(docId);
    retire(old.uri);
  }
  return out.uri;
}

function endBecause(docId: string, entry: Entry): void {
  if (sessions.get(docId) !== entry) return;
  forgetSession(docId);
}

/**
 * The file to read `doc`'s PDF content from: the session copy when it is
 * unlocked this session (made again if the stored PDF changed), else the
 * stored file — a protected PDF that isn't unlocked then rejects "locked" in
 * native, as it always did. `needs`: what the operation needs the PDF's
 * permissions to allow (checked for a session copy, which allows everything
 * itself; native checks the stored file's). Rejects with PdfSessionError.
 */
export async function readablePdfUri(
  doc: { id: string; pdfUri?: string | null; trashedAt?: number | null },
  options: { needs?: readonly PdfPermission[] } = {},
): Promise<string> {
  if (!doc.pdfUri) throw new PdfSessionError('missing', 'not a PDF document');
  const stored = clean(doc.pdfUri);
  if (doc.trashedAt != null) forgetSession(doc.id);
  const entry = sessions.get(doc.id);
  if (!entry) return stored;
  if (missingPermission(entry.permissions, options.needs)) throw new PdfSessionError('restricted');
  return (await liveCopy(doc.id, stored, false)) ?? stored;
}

/**
 * For an in-place write of a session-unlocked PDF (lib/pdf-edit.ts
 * rewriteStoredPdf, under the document's page lock): the copy to write from,
 * verified against the stored bytes, and the password to encrypt the result
 * with. Null when `docId` isn't unlocked (native then reads the stored file,
 * and refuses it if it needs a password). Rejects with PdfSessionError
 * ('restricted' when the permissions don't allow `needs`).
 */
export async function sessionWriteSource(
  docId: string,
  stored: string,
  needs: readonly PdfPermission[] = [],
): Promise<{ uri: string; password: string; keep: KeepProtection; restricted: boolean; done: () => void } | null> {
  const entry = sessions.get(docId);
  if (!entry) return null;
  if (entry.keep.mode === 'owner-only') throw new PdfSessionError('restricted', 'owner-password');
  if (missingPermission(entry.permissions, needs)) throw new PdfSessionError('restricted');
  let finish: () => void = () => {};
  const writing = new Promise<void>(resolve => { finish = resolve; });
  entry.writing = writing;
  const done = () => {
    if (entry.writing === writing) entry.writing = null;
    finish();
  };
  try {
    const uri = await liveCopy(docId, clean(stored), true);
    const live = sessions.get(docId);
    if (!uri || !live) {
      done();
      return null;
    }
    return { uri, password: live.password, keep: live.keep, restricted: !allAllowed(live.permissions), done };
  } catch (err) {
    done();
    throw err;
  }
}

/**
 * After an in-place write: `plainUri` is the decrypted form of what is now
 * stored (`storedPrint`), so it becomes the session copy instead of
 * decrypting the new file again. Moves the file; deletes it when the session
 * ended meanwhile. Never throws.
 */
export function adoptSessionCopy(docId: string, plainUri: string, stored: string, storedPrint: Print): void {
  const entry = sessions.get(docId);
  const plain = new File(clean(plainUri));
  pendingWork.delete(clean(plainUri));
  try {
    if (!entry || !storedPrint.md5 || (entry.copy && samePrint(entry.copy.source, storedPrint) && exists(entry.copy.uri))) {
      deleteQuietly(plain);
      return;
    }
    const dest = newCopyFile(docId);
    plain.move(dest);
    const old = entry.copy;
    entry.copy = { uri: dest.uri, source: storedPrint, stat: statKey(docId, stored) };
    emit(docId);
    retire(old?.uri);
  } catch {
    deleteQuietly(plain);
  }
}

// ── Watching the app ─────────────────────────────────────────────────────────

let appLockOn = false;
let backgroundedAt: number | null = null;
let installed = false;

/** One app state change (exported for tests; installPdfSessionWatch feeds it). */
export function handleAppStateForSessions(next: AppStateStatus, now: number = Date.now(), lockOn: boolean = appLockOn): void {
  // In the background nothing is on screen and a timer may never run: the
  // copies go at once (see the header).
  if (sessionEndsOn(next, lockOn, backgroundedAt, now)) forgetSession(undefined, { now: next === 'background' });
  if (next === 'background') backgroundedAt = now;
  else if (next === 'active') {
    backgroundedAt = null;
    sweepEndedSessionFiles();
  }
}

/** What the watch needs from lib/storage (passed in, so this module stays free of AsyncStorage). */
export type SessionWatchDeps = {
  getAppLockEnabled: () => Promise<boolean>;
  subscribeAppLock: (fn: (on: boolean) => void) => () => void;
  subscribeDocumentsRemoved: (fn: (ids: string[]) => void) => () => void;
};

/**
 * Ends sessions as the header describes. Called once from the root layout
 * with lib/storage's functions. Returns an uninstall function.
 */
export function installPdfSessionWatch(deps: SessionWatchDeps): () => void {
  if (installed) return () => {};
  installed = true;
  sweepEarlierProcesses();
  deps.getAppLockEnabled().then(on => { appLockOn = on; }).catch(() => {});
  const offLock = deps.subscribeAppLock(on => { appLockOn = on; });
  const offRemoved = deps.subscribeDocumentsRemoved(ids => {
    for (const id of ids) if (sessions.has(id)) forgetSession(id);
  });
  const sub = AppState.addEventListener('change', next => handleAppStateForSessions(next));
  return () => {
    installed = false;
    offLock();
    offRemoved();
    sub.remove();
  };
}

// ── React ────────────────────────────────────────────────────────────────────

/** A value that changes whenever `docId`'s session starts, ends or its copy changes (an effect dependency). */
export function useSessionRevision(docId: string | null | undefined): string {
  const subscribe = useCallback(
    (onChange: () => void) => subscribePdfSessions(id => { if (id === docId) onChange(); }),
    [docId],
  );
  return useSyncExternalStore(subscribe, () => sessionSnapshot(docId), () => sessionSnapshot(docId));
}

/** Whether `docId` is unlocked this session, re-rendering when that changes. */
export function useSessionUnlocked(docId: string | null | undefined): boolean {
  return useSessionRevision(docId).startsWith('u');
}

/**
 * readablePdfUri as a hook: `uri` is the file to show or read (null only
 * while the first session copy is being made), `unlocked` whether it is the
 * session copy. Follows the session (started, ended, copy replaced, stored
 * file replaced: one revision, read through useSyncExternalStore). A record
 * change that leaves the file alone (rename, move) keeps the same uri, so a
 * PDF view showing it isn't reloaded; while a changed file's copy is being
 * made the previous one stays until the new one is ready.
 */
export function useReadablePdfUri(
  doc: { id: string; pdfUri?: string | null } | null | undefined,
): { uri: string | null; unlocked: boolean } {
  const id = doc?.id ?? null;
  const stored = doc?.pdfUri ? clean(doc.pdfUri) : null;
  const rev = useSessionRevision(id);
  const unlocked = rev.startsWith('u');
  const key = `${id}|${stored}|${rev}`;
  const [resolved, setResolved] = useState<{ key: string; id: string; uri: string } | null>(null);
  useEffect(() => {
    if (!id || !stored || !unlocked) return;
    let live = true;
    readablePdfUri({ id, pdfUri: stored })
      .then(uri => { if (live) setResolved({ key, id, uri }); })
      .catch(() => { if (live) setResolved({ key, id, uri: stored }); });
    return () => { live = false; };
  }, [key, id, stored, unlocked]);
  if (!id || !stored) return { uri: null, unlocked: false };
  if (!unlocked) return { uri: stored, unlocked: false };
  // The previous copy of this document until the new one is ready.
  return { uri: resolved && resolved.id === id && isSessionPath(resolved.uri) ? resolved.uri : null, unlocked: true };
}

export function resetPdfSessionsForTests(): void {
  sessions.clear();
  listeners.clear();
  revs.clear();
  generations.clear();
  pendingWork.clear();
  backgroundedAt = null;
  appLockOn = false;
}
