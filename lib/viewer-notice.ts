// lib/viewer-notice.ts
// A message for the viewer to show as a toast once it is the screen on top,
// optionally with an action (Undo). Tools that change a document in place
// (Sign, Watermark, Timestamp) post one and then go back to the viewer, or
// open it: the viewer is a full-screen modal that covers the app-wide toast
// host, and a toast raised under the tool's own modal would never be seen.
//
// One notice at a time, for one document: a newer one replaces it. The viewer
// takes it (consumes it) when it is focused and showing that document.
//
// An action's resources (Undo's copy of the pages) are released through
// `onExpire`, called once when the action can no longer be used: the notice was
// replaced before any viewer took it, or ACTION_WINDOW_MS after it was taken
// without the action being pressed (the toast is long gone by then).

export type NoticeAction = { label: string; onPress: () => void };
export type ViewerNotice = {
  docId: string;
  message: string;
  action?: NoticeAction;
  /** Show this page (zero-based) with the message: the one the change was made to. */
  page?: number;
  /** Called once if `action` is never used (see the header). */
  onExpire?: () => void;
};

/**
 * How long after a notice is taken its action may still be pressed. Longer
 * than any toast keeps an action on screen (components/toast.tsx: 6 s, 10 s
 * with a screen reader), with room for the toast's own fade.
 */
export const ACTION_WINDOW_MS = 20_000;

let pending: ViewerNotice | null = null;
const listeners = new Set<() => void>();
const timers = new Set<ReturnType<typeof setTimeout>>();

function expire(notice: ViewerNotice | null): void {
  try { notice?.onExpire?.(); } catch {}
}

/** Queues `notice` for the viewer of `notice.docId` and wakes any viewer listening. */
export function postViewerNotice(notice: ViewerNotice): void {
  // The one it replaces will never be shown: its action is dead.
  if (pending && pending !== notice) expire(pending);
  pending = notice;
  for (const l of [...listeners]) {
    try { l(); } catch {}
  }
}

/**
 * The pending notice for `docId`, removed from the queue; null when there is
 * none. Its action is wrapped so that pressing it cancels the expiry; without
 * an action press, `onExpire` runs ACTION_WINDOW_MS from now.
 */
export function takeViewerNotice(docId: string): ViewerNotice | null {
  if (!pending || pending.docId !== docId) return null;
  const n = pending;
  pending = null;
  if (!n.onExpire) return n;
  let settled = false;
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (settled) return;
    settled = true;
    expire(n);
  }, ACTION_WINDOW_MS);
  timers.add(timer);
  const action = n.action;
  return {
    ...n,
    action: action
      ? {
          label: action.label,
          onPress: () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            timers.delete(timer);
            action.onPress();
          },
        }
      : undefined,
  };
}

/** Called whenever a notice is posted. Returns an unsubscribe function. */
export function subscribeViewerNotices(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function resetViewerNoticesForTests(): void {
  pending = null;
  listeners.clear();
  for (const t of timers) clearTimeout(t);
  timers.clear();
}
