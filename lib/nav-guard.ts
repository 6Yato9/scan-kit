// lib/nav-guard.ts
//
// Lock-aware navigation for work that finishes on its own time.
//
// App Lock (components/lock-gate.tsx) covers the app by pushing the /lock route
// when it goes to the background. A screen that started slow work before that
// (saving a signed copy, auto-cropping imported photos, a scan being saved) and
// then calls router.replace / router.push when the work completes would act on
// whatever is on top NOW: replace swaps /lock itself out for the viewer, push
// presents the viewer above it. Either way the document is on screen, usable,
// without anyone having unlocked the app.
//
// So every navigation that runs after an await goes through
// navigateWhenUnlocked(), and everything that presents native UI after an
// await (share sheet, print dialog, Photos) first awaits whenUnlocked(). While the app is locked — or the /lock route is still
// on screen, closing itself after an unlock — the navigation is held; it runs
// once the app is unlocked and the lock screen has gone, so it acts on the
// screen that started the work, as intended. A navigation the user triggers by
// tapping something doesn't need this: nothing can be tapped while locked.
//
// LockGate owns the state (setNavLockState); nothing else should set it.

type Action = () => void;

let locked = false;
let lockRouteShown = false;
const waiting: Action[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Held navigations run this long after the lock screen has left the route
 * stack. Its native fade-out is still running at that moment, and changing the
 * screens underneath a modal that is being dismissed leaves native-stack
 * showing a blank window (seen on the simulator with 250 ms); this waits for
 * the dismissal (UIKit cross-dissolve, ~0.35 s) to finish first.
 */
export const FLUSH_DELAY_MS = 700;

function blocked(): boolean {
  return locked || lockRouteShown;
}

function runAction(action: Action): void {
  try {
    action();
  } catch (err) {
    console.error('Held navigation failed', err);
  }
}

function scheduleFlush(): void {
  if (blocked() || waiting.length === 0 || flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    // Locked again in the meantime: keep holding.
    if (blocked()) return;
    const batch = waiting.splice(0);
    batch.forEach(runAction);
  }, FLUSH_DELAY_MS);
}

/** True while the app lock is engaged (read synchronously, e.g. by the alert guard). */
export function isAppLocked(): boolean {
  return locked;
}

/** True while held navigations must wait: locked, or the lock screen is still showing. */
export function isNavigationHeld(): boolean {
  return blocked();
}

/**
 * Called by LockGate whenever the lock engages or releases, and whenever the
 * /lock route appears or leaves the screen.
 */
export function setNavLockState(next: { locked?: boolean; lockRouteShown?: boolean }): void {
  if (next.locked !== undefined) locked = next.locked;
  if (next.lockRouteShown !== undefined) lockRouteShown = next.lockRouteShown;
  if (blocked() && flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  scheduleFlush();
}

/**
 * Runs `action` (a router.replace / push / dismissTo) now if the app is
 * unlocked, or holds it until the app has been unlocked and the lock screen
 * has gone. Held actions run in the order they were requested. Returns a
 * function that withdraws a still-held action.
 */
export function navigateWhenUnlocked(action: Action): () => void {
  // Behind earlier held actions too, so the order is kept.
  if (!blocked() && waiting.length === 0) {
    runAction(action);
    return () => {};
  }
  waiting.push(action);
  scheduleFlush();
  return () => {
    const i = waiting.indexOf(action);
    if (i !== -1) waiting.splice(i, 1);
  };
}

/**
 * Resolves once the app is unlocked AND the lock screen has fully gone (the
 * same moment a held navigation would run). Resolves on the next microtask
 * when nothing is held. Re-checks after waking, so a lock that engages again
 * during the hand-over keeps it waiting.
 *
 * Await it right before anything that PRESENTS or NAVIGATES after slow work:
 * a share sheet, the print dialog, a system prompt, a route change. While the
 * app is locked the top screen is /lock, and a native sheet presented then
 * appears above it — usable without unlocking. lib/share.ts (shareFile,
 * printFile) and lib/photos.ts already wait here internally, so their callers
 * can't forget. ESLint (eslint-rules/lock-safe.js) rejects direct calls to the
 * native presenters elsewhere, and router calls made after an `await`.
 */
export async function whenUnlocked(): Promise<void> {
  while (blocked() || waiting.length > 0) {
    await new Promise<void>(resolve => {
      navigateWhenUnlocked(resolve);
    });
  }
}

export type PickerHandoff = 'none' | 'clear-overlay' | 'push-lock';

/**
 * What LockGate does about the lock overlay it draws over a system picker
 * (components/lock-gate.tsx), given the current state:
 *  - 'push-lock': the last picker has closed while still locked — present the
 *    /lock route, keeping the overlay up until it is on screen;
 *  - 'clear-overlay': a lock screen route (/lock, or /import, which draws the
 *    lock itself) is on screen now, so the overlay can go;
 *  - 'none': nothing to do (no overlay, unlocked, or a picker is still open).
 */
export function pickerHandoffStep(state: {
  overPicker: boolean;
  locked: boolean;
  pickerOpen: boolean;
  pathname: string;
  lockRoutes: readonly string[];
}): PickerHandoff {
  if (!state.overPicker || !state.locked || state.pickerOpen) return 'none';
  return state.lockRoutes.includes(state.pathname) ? 'clear-overlay' : 'push-lock';
}

/** Tests only: forget all state. */
export function resetNavGuardForTests(): void {
  locked = false;
  lockRouteShown = false;
  waiting.length = 0;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}
