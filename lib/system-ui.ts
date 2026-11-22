// lib/system-ui.ts
//
// Tracks system pickers the app has open: the VisionKit document camera, the
// photo picker and the Files picker. They are view controllers presented by
// someone else's code, which matters in two ways:
//
// - Presenting one of our full-screen routes (the /lock route when the app goes
//   to the background, /import for "Open in Scan Kit") makes react-native-screens
//   dismiss whatever foreign controller is on top. The picker libraries only
//   settle their promise from their own delegate callbacks, so a picker closed
//   that way never resolves: the caller's busy flag (`adding`, `scanningRef`)
//   would stay set for the rest of the session. The app lock therefore checks
//   isSystemUIOpen() and covers the app without presenting anything.
// - If a picker is dismissed from outside anyway, abandonSystemUI() settles every
//   tracked call with the caller's "cancelled" value, so its `finally` runs and
//   the busy flags reset.
//
// Wrap every call that presents a picker in withSystemUI(). It also waits
// while App Lock is engaged, so a picker can never open above the lock screen.

import { isNavigationHeld, whenUnlocked } from './nav-guard';

type Entry = { settle: () => void };

const open = new Set<Entry>();
const listeners = new Set<(isOpen: boolean) => void>();

function emit(): void {
  const isOpen = open.size > 0;
  listeners.forEach(fn => {
    try { fn(isOpen); } catch (err) { console.error('system-ui listener', err); }
  });
}

/** True while a picker started through withSystemUI is on screen. */
export function isSystemUIOpen(): boolean {
  return open.size > 0;
}

/** Calls `fn` whenever a picker opens or the last one closes. */
export function subscribeSystemUI(fn: (isOpen: boolean) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Runs `present` (a call that shows a system picker and resolves when it
 * closes) while marking a picker as open. Resolves with its result, or with
 * `cancelled()` if the picker is abandoned first (see abandonSystemUI). A
 * result that arrives after that is ignored.
 */
export function withSystemUI<T>(present: () => Promise<T>, cancelled: () => T): Promise<T> {
  // App Lock: a picker presented while locked would open above the lock screen
  // (this call ran after slow work). Wait until the app is unlocked and the
  // lock screen has gone (lib/nav-guard). Unlocked: present synchronously.
  if (isNavigationHeld()) return whenUnlocked().then(() => withSystemUI(present, cancelled));
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const entry: Entry = {
      settle: () => {
        if (done) return;
        done = true;
        try { resolve(cancelled()); } catch (err) { reject(err); }
      },
    };
    const finish = () => {
      if (open.delete(entry)) emit();
    };
    open.add(entry);
    emit();
    let pending: Promise<T>;
    try {
      pending = present();
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.then(
      value => {
        finish();
        if (done) return;
        done = true;
        resolve(value);
      },
      err => {
        finish();
        if (done) return;
        done = true;
        reject(err);
      },
    );
  });
}

/**
 * Settles every open picker call as cancelled. Call this when something has
 * just dismissed the pickers from outside (a full-screen route was presented
 * over them). Returns how many were open.
 */
export function abandonSystemUI(): number {
  const entries = [...open];
  open.clear();
  entries.forEach(e => e.settle());
  if (entries.length) emit();
  return entries.length;
}

// ---------------------------------------------------------------------------
// Android hand-offs (lib/android-leave.ts)
// ---------------------------------------------------------------------------
// The share chooser, the print screen and the in-app browser are another
// app's activity on Android, and they settle no promise that says when they
// close (React Native's Share resolves at once; the chooser's target, Gmail
// for one, opens later). So instead of tracking them like pickers, the
// wrapper that opens one marks a hand-off just before; LockGate reads it when
// the activity stops and clears it the next time the app is active again (the
// user is back, or the chooser was dismissed without leaving). iOS never
// reads it: those sheets are shown inside the app there.

let handOffPending = false;

/** About to open another app's screen on purpose (share, print, web page). */
export function markHandOff(): void {
  handOffPending = true;
}

/** The marked hand-off didn't open after all (the call failed). */
export function cancelHandOff(): void {
  handOffPending = false;
}

/** True between markHandOff() and the app being active again (LockGate clears it). */
export function isHandOffPending(): boolean {
  return handOffPending;
}

/** LockGate: the app is active again, so any hand-off is over. */
export function endHandOff(): void {
  handOffPending = false;
}
