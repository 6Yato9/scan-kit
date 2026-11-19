// lib/last-undo.ts
// "Undo that doesn't vanish": the viewer keeps the latest Undo it offered in a
// toast (delete page, crop, retake, Sign / Watermark / Timestamp / Redact,
// PDF rotate / delete / reorder, Apply to all, blank page, convert) as a row
// in its "…" menu — "Undo delete page 3" — until the next edit or until the
// viewer closes, instead of only for the few seconds the toast is up.
//
// One offer at a time. The toast's Undo and the menu row run the SAME
// single-use action, so Undo can never run twice.
//
// Lifetime and the copies Undo needs:
// - offer(): a newer offer replaces the old one (dropped, see below).
// - drop(): the next edit happened (or the viewer lost focus to another
//   screen, where an edit may happen that this Undo would silently revert).
//   The menu row goes at once. The copy behind it (a stamp stash, a held PDF
//   stash) is released a little later, after the toast that offered it could
//   still be on screen, so the toast's own button keeps working as it always
//   did. Every Undo still re-checks the document before it changes anything
//   (page layout generation, PDF fingerprint, stash present).
// - dispose(): the viewer is closing; everything is released now.
// Stashes are crash-safe as before: they live where their module put them
// (Caches/page-undo, Application Support/stamp-undo, pdf-edit work folders),
// which the next launch sweeps; nothing here persists anything.
import { useEffect, useMemo, useSyncExternalStore } from 'react';

/** How long a dropped offer's copy outlives the menu row: the longest a toast keeps its action up, plus its fade. */
export const RELEASE_GRACE_MS = 16_000;

export type UndoOffer = { message: string; label: string };

type Entry = UndoOffer & {
  run: () => void;
  release?: () => void;
  /** Ran, or released: the action is dead. */
  settled: boolean;
};

/**
 * The menu label for an Undo, from the toast's message: "Page 3 deleted" →
 * "Undo delete page 3". Unknown messages: "Undo last change".
 */
export function undoLabelFor(message: string): string {
  const m = message.trim();
  let r: RegExpMatchArray | null;
  if ((r = m.match(/^Page (\d+) deleted$/i))) return `Undo delete page ${r[1]}`;
  if (/^Page deleted$/i.test(m)) return 'Undo delete page';
  if ((r = m.match(/^Page (\d+) replaced$/i))) return `Undo retake page ${r[1]}`;
  if (/^Page replaced$/i.test(m)) return 'Undo retake';
  if (/^Page cropped$/i.test(m)) return 'Undo crop';
  if ((r = m.match(/^Page (\d+) rotated$/i))) return `Undo rotate page ${r[1]}`;
  if (/rotated$/i.test(m)) return 'Undo rotate';
  if (/^Blank page added/i.test(m)) return 'Undo blank page';
  if (/^Pages reordered$/i.test(m)) return 'Undo reorder';
  if (/^Signed/i.test(m)) return 'Undo signature';
  if (/^Watermark added/i.test(m)) return 'Undo watermark';
  if (/^Timestamp added/i.test(m)) return 'Undo timestamp';
  if (/^Redacted/i.test(m)) return 'Undo redaction';
  if (/^(Marks erased|Cleaned \d+)/i.test(m)) return 'Undo erase marks';
  if (/^Converted to/i.test(m)) return 'Undo convert to pages';
  if (/ applied to (both|all) /i.test(m)) return 'Undo apply to all';
  return 'Undo last change';
}

export class LastUndo {
  private entry: Entry | null = null;
  /** Offers dropped whose copy is not released yet (their grace is running). */
  private dropped = new Map<Entry, ReturnType<typeof setTimeout>>();
  private listeners = new Set<() => void>();
  private disposed = false;
  private version = 0;

  /**
   * Records an Undo that is being offered (in a toast) for `message`. Returns
   * the action to put on the toast: running it from there or from the menu is
   * the same single use. `release` frees what the Undo needs (a stash) once it
   * can no longer be used.
   */
  offer(message: string, run: () => void, release?: () => void): () => void {
    const entry: Entry = { message, label: undoLabelFor(message), run, release, settled: false };
    if (this.disposed) {
      // Nobody can use it any more.
      this.release(entry);
      return () => {};
    }
    this.drop();
    this.entry = entry;
    this.emit();
    return () => this.use(entry);
  }

  /** The offer the menu shows, or null. */
  current(): UndoOffer | null {
    return this.entry ? { message: this.entry.message, label: this.entry.label } : null;
  }

  /** Runs the current offer (the menu row). False when there is none. */
  runCurrent(): boolean {
    const e = this.entry;
    if (!e) return false;
    this.use(e);
    return true;
  }

  /** The next edit happened: the menu row goes now, its copy after RELEASE_GRACE_MS (see the header). */
  drop(): void {
    const e = this.entry;
    if (!e) return;
    this.entry = null;
    this.emit();
    if (e.settled) return;
    const t = setTimeout(() => this.release(e), RELEASE_GRACE_MS);
    (t as { unref?: () => void }).unref?.();
    this.dropped.set(e, t);
  }

  /**
   * The screen is (again) mounted. React may run a mount effect's cleanup and
   * the effect again without unmounting (dev StrictMode, Fast Refresh): the
   * slot then works again for new offers.
   */
  activate(): void {
    this.disposed = false;
  }

  /** The viewer is closing: nothing can be undone from it any more. Releases every copy now. */
  dispose(): void {
    this.disposed = true;
    const e = this.entry;
    this.entry = null;
    if (e) this.release(e);
    for (const pending of [...this.dropped.keys()]) this.release(pending);
    this.emit();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  /** Changes whenever the offer does (for useSyncExternalStore). */
  getVersion = (): number => this.version;

  /**
   * The offer as a stable snapshot (a new object only when it changes), for
   * useSyncExternalStore. Read through the hook, never by calling current()
   * during render: the React Compiler memoizes a call on a stable object.
   */
  getSnapshot = (): UndoOffer | null => this.snapshot;
  private snapshot: UndoOffer | null = null;

  private use(e: Entry): void {
    if (e.settled) return;
    e.settled = true;
    this.forget(e);
    if (this.entry === e) {
      this.entry = null;
      this.emit();
    }
    e.run();
  }

  private release(e: Entry): void {
    this.forget(e);
    if (e.settled) return;
    e.settled = true;
    try { e.release?.(); } catch {}
  }

  private forget(e: Entry): void {
    const t = this.dropped.get(e);
    if (t !== undefined) clearTimeout(t);
    this.dropped.delete(e);
  }

  private emit(): void {
    this.version++;
    this.snapshot = this.current();
    for (const l of [...this.listeners]) {
      try { l(); } catch {}
    }
  }
}

type ToastLike = {
  show: (message: string, options?: { action?: { label: string; onPress: () => void }; long?: boolean }) => void;
};

/** Toast options the viewer's wrapped toast accepts: `hold` keeps an Undo's copy alive while it is offered. */
export type UndoToastOptions = {
  action?: { label: string; onPress: () => void };
  /** Stops the copy behind `action` from expiring on its own; returns its release. */
  hold?: () => (() => void) | undefined;
};

/**
 * A toast whose Undo actions are also offered in the viewer's menu (see the
 * header). Undo toasts stay up longer (`long`): they follow an edit that
 * changed or removed something.
 */
export function undoAwareToast(
  base: ToastLike,
  slot: LastUndo,
  /** Holds a copy the toast doesn't know about (a PDF edit's stash), when there is one. */
  holdExtra?: () => (() => void) | undefined,
) {
  return {
    show(message: string, options?: UndoToastOptions) {
      const action = options?.action;
      if (!action || action.label !== 'Undo') {
        base.show(message, action ? { action } : undefined);
        return;
      }
      let release: (() => void) | undefined;
      try {
        release = options?.hold?.() ?? holdExtra?.();
      } catch {
        release = undefined;
      }
      const run = slot.offer(message, action.onPress, release);
      base.show(message, { action: { label: 'Undo', onPress: run }, long: true });
    },
  };
}

/** One LastUndo for the lifetime of a screen; disposed when it unmounts. Re-renders when the offer changes. */
export function useLastUndo(): { slot: LastUndo; offer: UndoOffer | null } {
  const slot = useMemo(() => new LastUndo(), []);
  useEffect(() => {
    slot.activate();
    return () => slot.dispose();
  }, [slot]);
  const offer = useSyncExternalStore(slot.subscribe, slot.getSnapshot, slot.getSnapshot);
  return { slot, offer };
}
