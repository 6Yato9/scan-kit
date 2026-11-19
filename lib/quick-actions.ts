// lib/quick-actions.ts
//
// Home-screen quick actions: long-press the app icon for Scan document, Import
// photos, Import file or Search. Fully on-device.
//
// The items are static (UIApplicationShortcutItems in app.json ios.infoPlist,
// mirrored in ios/scankit/Info.plist). There are no dynamic items on purpose:
// a "recent document" item would show a document's name on the home screen,
// which App Lock exists to keep private.
//
// Native side: modules/vision-ocr/ios/QuickActions.swift keeps the action the
// app was cold-launched with until JS takes it (takePendingQuickAction), sends
// later ones as "onQuickAction" events, and drops iOS's echo of the launch
// item, so each long-press is delivered once. Builds made before it have no
// ScanKitQuickActions module: everything here is then a no-op.
//
// What happens when one arrives (quickActionStep; the handler is
// components/quick-actions-handler.tsx, mounted in app/_layout.tsx):
//   1. It waits until App Lock's state is known (cold start reads it
//      asynchronously), the app is unlocked and the lock screen has gone, and
//      onboarding has been finished. "Open in Scan Kit" (/import) is let finish
//      first. An action still waiting after QUICK_ACTION_TTL_MS is dropped.
//   2. It is ignored while a capture or import is already underway — the
//      camera, a system picker, a scan or import being saved: a second camera
//      or picker would be stacked on the first, or the captured pages lost, and
//      the user is already doing what the action offers.
//   3. It is ignored while a sheet, alert or other modal is presented over the
//      screen: iOS refuses (silently) to present a screen over one, and closing
//      it would throw away what it holds (a rename being typed, an export).
//   4. On a tab (Home, Files, Tools, Settings) every action runs, exactly like
//      its in-app button.
//   5. With another screen open (the viewer, an editor, a tool, a settings
//      page) nothing is closed — it may hold unsaved work. Scan and the imports
//      open ABOVE it, as the viewer's own Add pages does, and the new document
//      opens above that; closing it returns to the screen as it was. Search
//      lives in Files, under that screen, so it can't be reached without
//      closing it: it is ignored and the user stays where they were.
import { AppState } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

export type QuickActionId = 'scan' | 'import-photos' | 'import-file' | 'search';

/** UIApplicationShortcutItemType of each item (app.json). Never rename one: iOS keeps them across updates. */
export const QUICK_ACTION_TYPES: Readonly<Record<string, QuickActionId>> = {
  'com.6yato9.scan-kit.scan': 'scan',
  'com.6yato9.scan-kit.import-photos': 'import-photos',
  'com.6yato9.scan-kit.import-file': 'import-file',
  'com.6yato9.scan-kit.search': 'search',
};

/** The action for a shortcut item type, or null for one this version doesn't know. */
export function parseQuickActionType(type: unknown): QuickActionId | null {
  if (typeof type !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(QUICK_ACTION_TYPES, type) ? QUICK_ACTION_TYPES[type] : null;
}

/** A held action older than this (the lock or onboarding took that long) no longer reflects what the user wants. */
export const QUICK_ACTION_TTL_MS = 5 * 60_000;

export function isQuickActionStale(receivedAt: number, now = Date.now()): boolean {
  return now - receivedAt > QUICK_ACTION_TTL_MS;
}

/** The tab screens: nothing above them can hold work. ('/scan' is the tab bar's camera button, never a screen.) */
export const TAB_PATHS: readonly string[] = ['/', '/files', '/tools', '/me'];

export type QuickActionState = {
  /** getOnboardedSync(): null while not yet read. */
  onboarded: boolean | null;
  pathname: string;
  /** App Lock is engaged or its screen is still closing (nav-guard isNavigationHeld). */
  held: boolean;
  /** App Lock's setting has been read (cold start). */
  lockSettled: boolean;
  /** The camera, a system picker, or a scan / import being saved. */
  capturing: boolean;
  /** A sheet, alert or other modal is presented (native check); null = not known yet / not available. */
  overlay: boolean | null;
};

export type QuickActionStep =
  | { kind: 'wait'; until: 'lock' | 'onboarding' | 'import' }
  | { kind: 'ignore'; reason: 'capturing' | 'overlay' | 'screen-open' }
  | { kind: 'run'; over: 'tab' | 'screen' };

/** What to do with `action` now (see the header for the policy). */
export function quickActionStep(action: QuickActionId, s: QuickActionState): QuickActionStep {
  if (!s.lockSettled || s.held || s.pathname === '/lock') return { kind: 'wait', until: 'lock' };
  if (s.onboarded !== true || s.pathname === '/onboarding') return { kind: 'wait', until: 'onboarding' };
  if (s.pathname === '/import') return { kind: 'wait', until: 'import' };
  if (s.capturing || s.pathname === '/camera') return { kind: 'ignore', reason: 'capturing' };
  if (s.overlay === true) return { kind: 'ignore', reason: 'overlay' };
  if (TAB_PATHS.includes(s.pathname)) return { kind: 'run', over: 'tab' };
  if (action === 'search') return { kind: 'ignore', reason: 'screen-open' };
  return { kind: 'run', over: 'screen' };
}

/**
 * Cold start: resolves once App Lock's setting is known AND, when it is on,
 * the lock has engaged (LockGate reads the same flag at the same time and
 * locks in its callback). Until then nothing is held, so an action run early
 * would open the camera above a lock that is about to appear. Gives up waiting
 * for the lock after `timeoutMs` (the flag read failed: LockGate fails open
 * the same way).
 */
export async function waitForLockSettled(deps: {
  readEnabled: () => Promise<boolean>;
  isLocked: () => boolean;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<void> {
  const { readEnabled, isLocked, timeoutMs = 2000, intervalMs = 50 } = deps;
  let enabled = false;
  try {
    enabled = await readEnabled();
  } catch {
    enabled = false;
  }
  if (!enabled) return;
  const start = Date.now();
  while (!isLocked() && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

// ── Native module ────────────────────────────────────────────────────────────

type QuickActionsNative = {
  takePendingQuickAction?: () => string | null;
  isOverlayPresented?: () => Promise<boolean>;
  addListener?: (event: 'onQuickAction', listener: (e: { type?: string }) => void) => { remove: () => void };
};

let nativeOverride: QuickActionsNative | null | undefined;

function native(): QuickActionsNative | null {
  if (nativeOverride !== undefined) return nativeOverride;
  return requireOptionalNativeModule<QuickActionsNative>('ScanKitQuickActions');
}

/** Tests only: stand in for the native module (null = an older build without it). */
export function setQuickActionsNativeForTests(mod: QuickActionsNative | null | undefined): void {
  nativeOverride = mod;
}

/** Whether this build delivers quick actions (builds before round 13 don't). */
export function quickActionsAvailable(): boolean {
  const m = native();
  return typeof m?.takePendingQuickAction === 'function' && typeof m?.addListener === 'function';
}

/** The action the app was launched with (or one that arrived while JS wasn't listening), once. */
export function takePendingQuickAction(): QuickActionId | null {
  const m = native();
  if (typeof m?.takePendingQuickAction !== 'function') return null;
  try {
    return parseQuickActionType(m.takePendingQuickAction());
  } catch {
    return null;
  }
}

/**
 * Whether a sheet, alert or other modal is presented over the screens. null
 * when this build can't tell (then the caller goes ahead, as before this
 * check existed).
 */
export async function isOverlayPresented(): Promise<boolean | null> {
  const m = native();
  if (typeof m?.isOverlayPresented !== 'function') return null;
  try {
    return await m.isOverlayPresented();
  } catch {
    return null;
  }
}

/**
 * Calls `onAction` for every quick action: the one the app was launched with
 * (already waiting), and each later one. Listens first, then takes the waiting
 * one, so none falls in between; the native side hands each one out only once.
 * Coming back to the foreground also checks for a waiting one (an action that
 * arrived while the listener wasn't attached, e.g. across a dev reload).
 * Returns the unsubscribe; a no-op on builds without the native module.
 */
export function listenForQuickActions(onAction: (action: QuickActionId) => void): () => void {
  const m = native();
  if (!m || !quickActionsAvailable()) return () => {};
  const deliver = (action: QuickActionId | null) => {
    if (action) onAction(action);
  };
  let sub: { remove: () => void } | null = null;
  try {
    // A method of the native module: call it on the module (an unbound call
    // aborts in expo's EventEmitter).
    sub = m.addListener!('onQuickAction', e => deliver(parseQuickActionType(e?.type)));
  } catch {
    sub = null;
  }
  deliver(takePendingQuickAction());
  // Development only: lets a test drive an action through the same path
  // (`globalThis.__skQuickAction('com.6yato9.scan-kit.search')`).
  const g = globalThis as { __skQuickAction?: (type: string) => void };
  if (__DEV__) g.__skQuickAction = type => deliver(parseQuickActionType(type));
  const appState = AppState.addEventListener('change', state => {
    if (state === 'active') deliver(takePendingQuickAction());
  });
  return () => {
    sub?.remove();
    appState.remove();
    if (__DEV__) delete g.__skQuickAction;
  };
}
