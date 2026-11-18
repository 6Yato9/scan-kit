// lib/viewer-notice.ts
// A message for the viewer to show as a toast once it is the screen on top,
// optionally with an action (Undo). Tools that change a document in place
// (Sign, Watermark, Timestamp) post one and then go back to the viewer, or
// open it: the viewer is a full-screen modal that covers the app-wide toast
// host, and a toast raised under the tool's own modal would never be seen.
//
// One notice at a time, for one document: a newer one replaces it. The viewer
// takes it (consumes it) when it is focused and showing that document.

export type NoticeAction = { label: string; onPress: () => void };
export type ViewerNotice = {
  docId: string;
  message: string;
  action?: NoticeAction;
  /** Show this page (zero-based) with the message: the one the change was made to. */
  page?: number;
};

let pending: ViewerNotice | null = null;
const listeners = new Set<() => void>();

/** Queues `notice` for the viewer of `notice.docId` and wakes any viewer listening. */
export function postViewerNotice(notice: ViewerNotice): void {
  pending = notice;
  for (const l of [...listeners]) {
    try { l(); } catch {}
  }
}

/** The pending notice for `docId`, removed from the queue; null when there is none. */
export function takeViewerNotice(docId: string): ViewerNotice | null {
  if (!pending || pending.docId !== docId) return null;
  const n = pending;
  pending = null;
  return n;
}

/** Called whenever a notice is posted. Returns an unsubscribe function. */
export function subscribeViewerNotices(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function resetViewerNoticesForTests(): void {
  pending = null;
  listeners.clear();
}
