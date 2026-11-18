// lib/share.ts
// Safe wrappers around the native share sheet and print dialog.
//
// Why this exists:
// - expo-sharing's iOS promise only settles when the user either completes a
//   share or dismisses the sheet without picking anything. If they pick a target
//   (Save to Files, Mail, Print) and then cancel it, the promise NEVER settles
//   (node_modules/expo-sharing/ios/SharingModule.swift). Awaiting it directly
//   leaves spinners running and sheets locked forever. `shareFile` never makes
//   the caller wait for longer than a short grace period.
// - Presenting a native sheet while an RN <Modal> is open is fine (it is shown
//   on top of the modal), but presenting it while a modal is *dismissing* fails
//   silently. Either share from inside the open modal, or close it and use
//   `runAfterDismiss` / `useCloseThen`.
// - Native APIs must never see a `?v=` cache-bust suffix.
// - App Lock: while the app is locked the top screen is the /lock route, and a
//   sheet presented then appears ABOVE it, usable without unlocking. Both
//   `shareFile` and `printFile` therefore wait (lib/nav-guard whenUnlocked)
//   until the app is unlocked and the lock screen has gone before presenting,
//   and skip presenting altogether if the caller's `signal` was aborted
//   meanwhile (the sheet that started the export has been closed). This is the
//   ONLY place allowed to call Sharing.shareAsync / Print.printAsync / RN
//   Share.share (eslint-rules/lock-safe.js enforces it).
import { useCallback, useEffect, useRef } from 'react';
import { Share } from 'react-native';
import * as Sharing from 'expo-sharing';
import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system/legacy';
import { safeFileName } from './auto-name';
import { whenUnlocked } from './nav-guard';

/** Strip any `?v=` cache-bust query (or other query) before handing a URI to native code. */
export function cleanFileUri(uri: string): string {
  return uri.split('?')[0];
}

export type ShareOptions = {
  mimeType?: string;
  /** iOS Uniform Type Identifier, e.g. 'com.adobe.pdf', 'public.jpeg', 'public.zip-archive'. */
  UTI?: string;
  dialogTitle?: string;
  /**
   * Called once the native sheet reports it is finished (shared or dismissed).
   * May never be called (see file header), so never hold UI state on it —
   * use it for best-effort follow-ups such as closing a sheet.
   */
  onFinish?: () => void;
  /** How long `shareFile` waits for an early failure before resolving. Default 1200 ms. */
  graceMs?: number;
  /**
   * The work's abort signal. Aborted while waiting for the app to be unlocked
   * (the sheet that started the export was closed): nothing is presented and
   * the call resolves 'skipped'.
   */
  signal?: AbortSignal;
};

/**
 * `finished`: the user shared or dismissed within the grace period.
 * `presented`: the sheet is still open; the caller can carry on.
 * `skipped`: `signal` was aborted before the sheet could be shown.
 */
export type ShareOutcome = 'finished' | 'presented' | 'skipped';

/** A failure that is safe to show to the user as-is. */
export class ShareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareError';
  }
}


/**
 * Open the native share sheet for a local file. Resolves as soon as the sheet
 * is up (or finished) — never waits for the user — and rejects with a
 * `ShareError` carrying a human-readable message when sharing can't start.
 * While the app is locked it waits for the unlock first (see file header).
 */
export async function shareFile(uri: string, options: ShareOptions = {}): Promise<ShareOutcome> {
  const clean = cleanFileUri(uri);
  if (!(await Sharing.isAvailableAsync())) {
    throw new ShareError('Sharing isn’t available on this device.');
  }
  const info = await FileSystem.getInfoAsync(clean).catch(() => null);
  if (!info?.exists) {
    throw new ShareError('The file to share couldn’t be found. Try exporting again.');
  }
  // Last await before presenting: nothing can lock the app between this and
  // the native call below.
  await whenUnlocked();
  if (options.signal?.aborted) return 'skipped';

  let settled = false;
  const native = Sharing.shareAsync(clean, {
    mimeType: options.mimeType,
    UTI: options.UTI,
    dialogTitle: options.dialogTitle,
  }).then(
    () => {
      settled = true;
      options.onFinish?.();
      return 'finished' as const;
    },
    (err: unknown) => {
      settled = true;
      options.onFinish?.();
      throw err;
    },
  );

  // Early failures (no presenting view controller, unreadable file) reject
  // within a few ms; a successful presentation simply never settles here.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<'presented'>(resolve => {
    timer = setTimeout(() => resolve('presented'), options.graceMs ?? 1200);
  });
  const outcome = await Promise.race([
    native.catch(() => {
      throw new ShareError('Couldn’t open the share sheet. Try again.');
    }),
    grace,
  ]).finally(() => clearTimeout(timer));
  if (!settled) native.catch(() => {}); // late rejections are not the caller's problem
  return outcome;
}

/**
 * Share plain text (recognised text) through the system share sheet. Waits
 * while the app is locked, like shareFile. Dismissing is not an error; never
 * rejects.
 */
export async function shareText(message: string): Promise<void> {
  await whenUnlocked();
  try {
    await Share.share({ message });
  } catch {
    // dismissed, or the sheet couldn't open: nothing to tell the user
  }
}

/** True for the errors iOS/Android raise when the user simply backs out. */
export function isCancelError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /cancel|did not complete|dismiss/i.test(msg);
}

export type PrintOutcome = 'printed' | 'cancelled';

/**
 * Print a local PDF (or image) through the system print dialog. Cancelling is
 * not an error. Rejects with a `ShareError` for real failures. While the app
 * is locked it waits for the unlock first; an abort of `options.signal`
 * meanwhile skips the dialog ('cancelled').
 */
export async function printFile(uri: string, options: { signal?: AbortSignal } = {}): Promise<PrintOutcome> {
  const clean = cleanFileUri(uri);
  await whenUnlocked();
  if (options.signal?.aborted) return 'cancelled';
  try {
    await Print.printAsync({ uri: clean });
    return 'printed';
  } catch (err) {
    if (isCancelError(err)) return 'cancelled';
    throw new ShareError('Couldn’t print this document. Check the printer and try again.');
  }
}

// ---------------------------------------------------------------------------
// "Close the modal, then present a native sheet"
// ---------------------------------------------------------------------------

/** Long enough for the iOS modal slide-down to finish when no onDismiss arrives. */
export const MODAL_DISMISS_FALLBACK_MS = 650;

/**
 * Run `fn` once a modal has fully dismissed: when `signal()` is called (wire it
 * to the Modal's `onDismiss` or BottomSheet's `onDismissed`) or after `fallbackMs`, whichever
 * comes first. Returns a cancel function.
 */
export function runAfterDismiss(
  fn: () => void,
  fallbackMs: number = MODAL_DISMISS_FALLBACK_MS,
): { signal: () => void; cancel: () => void } {
  let done = false;
  const timer = setTimeout(fire, fallbackMs);
  function fire() {
    if (done) return;
    done = true;
    clearTimeout(timer);
    // One extra frame so UIKit has finished tearing the modal down.
    setTimeout(fn, 50);
  }
  return {
    signal: fire,
    cancel: () => {
      done = true;
      clearTimeout(timer);
    },
  };
}

/**
 * Hook form of `runAfterDismiss` for a component that owns a sheet.
 *
 *   const { closeThen, onDismiss } = useCloseThen(() => setSheetVisible(false));
 *   <BottomSheet visible={sheetVisible} onDismissed={onDismiss} … />
 *   closeThen(() => shareFile(uri, { mimeType: 'image/jpeg' }));
 */
export function useCloseThen(close: () => void) {
  const pending = useRef<ReturnType<typeof runAfterDismiss> | null>(null);
  useEffect(() => () => pending.current?.cancel(), []);

  const closeThen = useCallback(
    (fn: () => void) => {
      pending.current?.cancel();
      pending.current = runAfterDismiss(() => {
        pending.current = null;
        fn();
      });
      close();
    },
    [close],
  );
  const onDismiss = useCallback(() => pending.current?.signal(), []);
  return { closeThen, onDismiss };
}

// ---------------------------------------------------------------------------
// Export temp files
// ---------------------------------------------------------------------------

const EXPORT_DIR = `${FileSystem.cacheDirectory ?? 'file:///tmp/'}exports/`;
/** expo-print writes every generated PDF here with a random UUID name. */
const PRINT_DIR = `${FileSystem.cacheDirectory ?? 'file:///tmp/'}Print/`;

/**
 * Turn a document name into a safe file name: keeps spaces and letters, writes
 * a time's ":" as "." ("Scan 18 Nov 2026 at 01.37.pdf"), drops path characters.
 */
export function exportFileName(docName: string, ext: string): string {
  const base = safeFileName(docName).slice(0, 80).trim() || 'Document';
  return `${base}.${ext.replace(/^\./, '')}`;
}

/**
 * Directory for files about to be shared. Each export gets its own folder so
 * the shared file can carry the document's real name without collisions.
 */
export async function makeExportDir(): Promise<string> {
  const dir = `${EXPORT_DIR}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  return dir;
}

/** Move (or copy, for files we must keep) `src` into `dir` as `name`. Returns the new URI. */
export async function placeExportFile(
  src: string,
  dir: string,
  name: string,
  mode: 'move' | 'copy' = 'move',
): Promise<string> {
  const to = `${dir}${encodeURIComponent(name)}`;
  const from = cleanFileUri(src);
  if (mode === 'move') await FileSystem.moveAsync({ from, to });
  else await FileSystem.copyAsync({ from, to });
  return to;
}

/** Best-effort delete of one file or folder. */
export async function deleteQuietly(uri: string | null | undefined): Promise<void> {
  if (!uri) return;
  try {
    await FileSystem.deleteAsync(cleanFileUri(uri), { idempotent: true });
  } catch {
    // ignore
  }
}

/**
 * Delete leftovers from earlier exports (shared files, expo-print output).
 * Call before starting a new export — by then any previous share sheet has
 * long finished reading its file (and on Android the receiving app has too).
 */
export async function clearExportCache(): Promise<void> {
  await deleteQuietly(EXPORT_DIR);
  // Tools also render into Print/ and copy the result out right away, so only
  // remove files that are clearly stale rather than racing one in flight.
  try {
    const names = await FileSystem.readDirectoryAsync(PRINT_DIR);
    const cutoff = Date.now() / 1000 - 120;
    for (const name of names) {
      const info = await FileSystem.getInfoAsync(`${PRINT_DIR}${name}`);
      if (info.exists && (info.modificationTime ?? 0) < cutoff) {
        await deleteQuietly(`${PRINT_DIR}${name}`);
      }
    }
  } catch {
    // directory doesn't exist yet
  }
}
