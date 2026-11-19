// Home-screen quick actions (lib/quick-actions.ts): which action a shortcut
// type is, when one may run (App Lock, onboarding, work in progress), and that
// each long-press is delivered exactly once.
import { AppState } from 'react-native';
import {
  isOverlayPresented,
  isQuickActionStale,
  listenForQuickActions,
  parseQuickActionType,
  QUICK_ACTION_TTL_MS,
  QUICK_ACTION_TYPES,
  quickActionsAvailable,
  quickActionStep,
  appStackRoutes,
  isViewerIdle,
  onlyViewerAboveTabs,
  reportViewerIdle,
  setQuickActionsNativeForTests,
  takePendingQuickAction,
  waitForLockSettled,
  type QuickActionId,
  type QuickActionState,
} from '../lib/quick-actions';

const appJson = require('../app.json');

const ALL: QuickActionId[] = ['scan', 'import-photos', 'import-file', 'search'];

const resting: QuickActionState = {
  onboarded: true,
  pathname: '/',
  held: false,
  lockSettled: true,
  capturing: false,
  overlay: false,
};

afterEach(() => setQuickActionsNativeForTests(undefined));

describe('shortcut items', () => {
  test('app.json declares exactly the types JS handles, with SF Symbol icons and sentence-case titles', () => {
    const items = appJson.expo.ios.infoPlist.UIApplicationShortcutItems as Record<string, string>[];
    expect(items.map(i => i.UIApplicationShortcutItemType).sort()).toEqual(Object.keys(QUICK_ACTION_TYPES).sort());
    for (const item of items) {
      expect(item.UIApplicationShortcutItemIconSymbolName).toMatch(/^[a-z.]+$/);
      const title = item.UIApplicationShortcutItemTitle;
      expect(title.slice(1)).toBe(title.slice(1).toLowerCase());
    }
    expect(items.map(i => i.UIApplicationShortcutItemTitle)).toEqual(['Scan document', 'Import photos', 'Import file', 'Search']);
  });

  test('parses known types and ignores anything else', () => {
    expect(parseQuickActionType('com.6yato9.scan-kit.scan')).toBe('scan');
    expect(parseQuickActionType('com.6yato9.scan-kit.import-photos')).toBe('import-photos');
    expect(parseQuickActionType('com.6yato9.scan-kit.import-file')).toBe('import-file');
    expect(parseQuickActionType('com.6yato9.scan-kit.search')).toBe('search');
    expect(parseQuickActionType('com.6yato9.scan-kit.recent')).toBeNull();
    expect(parseQuickActionType('toString')).toBeNull();
    expect(parseQuickActionType(undefined)).toBeNull();
    expect(parseQuickActionType(42)).toBeNull();
  });

  test('an action held too long is stale', () => {
    expect(isQuickActionStale(1000, 1000 + QUICK_ACTION_TTL_MS)).toBe(false);
    expect(isQuickActionStale(1000, 1001 + QUICK_ACTION_TTL_MS)).toBe(true);
  });
});

describe('quickActionStep', () => {
  test('waits for App Lock: its flag unread, locked, or the lock screen still up', () => {
    for (const a of ALL) {
      expect(quickActionStep(a, { ...resting, lockSettled: false })).toEqual({ kind: 'wait', until: 'lock' });
      expect(quickActionStep(a, { ...resting, held: true })).toEqual({ kind: 'wait', until: 'lock' });
      expect(quickActionStep(a, { ...resting, pathname: '/lock' })).toEqual({ kind: 'wait', until: 'lock' });
      // Locked beats everything, even a camera underneath.
      expect(quickActionStep(a, { ...resting, held: true, capturing: true, onboarded: false })).toEqual({ kind: 'wait', until: 'lock' });
    }
  });

  test('waits for onboarding to be finished', () => {
    for (const a of ALL) {
      expect(quickActionStep(a, { ...resting, onboarded: null })).toEqual({ kind: 'wait', until: 'onboarding' });
      expect(quickActionStep(a, { ...resting, onboarded: false })).toEqual({ kind: 'wait', until: 'onboarding' });
      expect(quickActionStep(a, { ...resting, pathname: '/onboarding' })).toEqual({ kind: 'wait', until: 'onboarding' });
      // First launch through "Open in Scan Kit" (onboarding deferred until the viewer closes).
      expect(quickActionStep(a, { ...resting, onboarded: false, pathname: '/viewer' })).toEqual({ kind: 'wait', until: 'onboarding' });
    }
  });

  test('lets an "Open in Scan Kit" import finish first', () => {
    for (const a of ALL) expect(quickActionStep(a, { ...resting, pathname: '/import' })).toEqual({ kind: 'wait', until: 'import' });
  });

  test('never interrupts a capture or an import in progress', () => {
    for (const a of ALL) {
      expect(quickActionStep(a, { ...resting, capturing: true })).toEqual({ kind: 'ignore', reason: 'capturing' });
      expect(quickActionStep(a, { ...resting, pathname: '/camera' })).toEqual({ kind: 'ignore', reason: 'capturing' });
      expect(quickActionStep(a, { ...resting, pathname: '/viewer', capturing: true })).toEqual({ kind: 'ignore', reason: 'capturing' });
    }
  });

  test('never presents over a sheet or alert', () => {
    for (const a of ALL) {
      expect(quickActionStep(a, { ...resting, overlay: true })).toEqual({ kind: 'ignore', reason: 'overlay' });
      expect(quickActionStep(a, { ...resting, pathname: '/viewer', overlay: true })).toEqual({ kind: 'ignore', reason: 'overlay' });
    }
    // Unknown (first pass, or a build without the check): decided on the rest.
    expect(quickActionStep('scan', { ...resting, overlay: null })).toEqual({ kind: 'run', over: 'tab' });
  });

  test('runs every action from any tab', () => {
    for (const pathname of ['/', '/files', '/tools', '/me']) {
      for (const a of ALL) expect(quickActionStep(a, { ...resting, pathname })).toEqual({ kind: 'run', over: 'tab' });
    }
  });

  test('over another screen: scan and imports open above it, search leaves it alone', () => {
    for (const pathname of ['/viewer', '/annotate', '/tools/sign', '/tools/merge', '/settings/scan-settings']) {
      expect(quickActionStep('scan', { ...resting, pathname })).toEqual({ kind: 'run', over: 'screen' });
      expect(quickActionStep('import-photos', { ...resting, pathname })).toEqual({ kind: 'run', over: 'screen' });
      expect(quickActionStep('import-file', { ...resting, pathname })).toEqual({ kind: 'run', over: 'screen' });
      expect(quickActionStep('search', { ...resting, pathname })).toEqual({ kind: 'ignore', reason: 'screen-open' });
    }
  });

  test('search closes a plain viewer (nothing in progress, nothing above the tabs but it) and only that (r13b)', () => {
    expect(quickActionStep('search', { ...resting, pathname: '/viewer', idleViewer: true })).toEqual({ kind: 'run', over: 'idle-viewer' });
    // Busy, or not known to be idle: left alone.
    expect(quickActionStep('search', { ...resting, pathname: '/viewer', idleViewer: false })).toEqual({ kind: 'ignore', reason: 'screen-open' });
    // The flag only ever counts for the viewer itself.
    expect(quickActionStep('search', { ...resting, pathname: '/annotate', idleViewer: true })).toEqual({ kind: 'ignore', reason: 'screen-open' });
    // Still behind the lock, onboarding, a capture and an open sheet.
    expect(quickActionStep('search', { ...resting, pathname: '/viewer', idleViewer: true, held: true })).toEqual({ kind: 'wait', until: 'lock' });
    expect(quickActionStep('search', { ...resting, pathname: '/viewer', idleViewer: true, capturing: true })).toEqual({ kind: 'ignore', reason: 'capturing' });
    expect(quickActionStep('search', { ...resting, pathname: '/viewer', idleViewer: true, overlay: true })).toEqual({ kind: 'ignore', reason: 'overlay' });
    // Other actions over the viewer are unchanged.
    expect(quickActionStep('scan', { ...resting, pathname: '/viewer', idleViewer: true })).toEqual({ kind: 'run', over: 'screen' });
  });

  test('the viewer counts as plain only alone above the tabs, and while it says it is idle', () => {
    expect(onlyViewerAboveTabs([{ name: '(tabs)' }, { name: 'viewer' }])).toBe(true);
    expect(onlyViewerAboveTabs([{ name: '(tabs)' }, { name: 'viewer' }, { name: 'viewer' }])).toBe(false);
    expect(onlyViewerAboveTabs([{ name: '(tabs)' }, { name: 'tools/merge' }])).toBe(false);
    expect(onlyViewerAboveTabs([{ name: '(tabs)' }])).toBe(false);
    expect(onlyViewerAboveTabs(undefined)).toBe(false);
    // expo-router wraps the app's stack in its own "__root" route.
    const wrapped = { routes: [{ name: '__root', state: { routes: [{ name: '(tabs)', state: { routes: [{ name: 'files' }] } }, { name: 'viewer' }] } }] };
    expect(appStackRoutes(wrapped)?.map(r => r.name)).toEqual(['(tabs)', 'viewer']);
    expect(onlyViewerAboveTabs(appStackRoutes(wrapped))).toBe(true);
    expect(appStackRoutes({ routes: [{ name: '__root', state: { routes: [{ name: '(tabs)' }] } }] })?.map(r => r.name)).toEqual(['(tabs)']);
    expect(isViewerIdle()).toBe(false);
    reportViewerIdle(true);
    expect(isViewerIdle()).toBe(true);
    reportViewerIdle(false);
    expect(isViewerIdle()).toBe(false);
  });
});

describe('waitForLockSettled', () => {
  test('resolves at once when App Lock is off', async () => {
    const isLocked = jest.fn(() => false);
    await waitForLockSettled({ readEnabled: async () => false, isLocked });
    expect(isLocked).not.toHaveBeenCalled();
  });

  test('with App Lock on, waits until the lock has engaged', async () => {
    let locked = false;
    setTimeout(() => { locked = true; }, 30);
    const start = Date.now();
    await waitForLockSettled({ readEnabled: async () => true, isLocked: () => locked, intervalMs: 5, timeoutMs: 1000 });
    expect(locked).toBe(true);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test('gives up after the timeout, and treats a failed read as off', async () => {
    await waitForLockSettled({ readEnabled: async () => true, isLocked: () => false, intervalMs: 5, timeoutMs: 20 });
    const isLocked = jest.fn(() => false);
    await waitForLockSettled({ readEnabled: () => Promise.reject(new Error('io')), isLocked });
    expect(isLocked).not.toHaveBeenCalled();
  });
});

describe('native module', () => {
  function fakeNative(pending: string | null) {
    let queued = pending;
    let listener: ((e: { type?: string }) => void) | null = null;
    const removed = jest.fn();
    return {
      mod: {
        takePendingQuickAction: jest.fn(() => { const t = queued; queued = null; return t; }),
        isOverlayPresented: jest.fn(async () => true),
        addListener: jest.fn((_e: 'onQuickAction', fn: (e: { type?: string }) => void) => { listener = fn; return { remove: removed }; }),
      },
      emit: (type: string) => listener?.({ type }),
      queue: (type: string) => { queued = type; },
      removed,
    };
  }

  test('older builds without the module: unavailable, and nothing throws', async () => {
    setQuickActionsNativeForTests(null);
    expect(quickActionsAvailable()).toBe(false);
    expect(takePendingQuickAction()).toBeNull();
    await expect(isOverlayPresented()).resolves.toBeNull();
    const onAction = jest.fn();
    listenForQuickActions(onAction)();
    expect(onAction).not.toHaveBeenCalled();
  });

  test('a module missing a function counts as unavailable', () => {
    setQuickActionsNativeForTests({ takePendingQuickAction: () => null });
    expect(quickActionsAvailable()).toBe(false);
    setQuickActionsNativeForTests({ addListener: () => ({ remove() {} }) });
    expect(quickActionsAvailable()).toBe(false);
  });

  test('cold launch: the launch action is delivered once, then warm ones as they come', () => {
    const n = fakeNative('com.6yato9.scan-kit.scan');
    setQuickActionsNativeForTests(n.mod);
    const got: QuickActionId[] = [];
    const stop = listenForQuickActions(a => got.push(a));
    // Listening started before the waiting action was taken.
    expect(n.mod.addListener.mock.invocationCallOrder[0]).toBeLessThan(n.mod.takePendingQuickAction.mock.invocationCallOrder[0]);
    expect(got).toEqual(['scan']);
    expect(takePendingQuickAction()).toBeNull();
    n.emit('com.6yato9.scan-kit.search');
    n.emit('com.6yato9.scan-kit.unknown');
    expect(got).toEqual(['scan', 'search']);
    stop();
    expect(n.removed).toHaveBeenCalled();
  });

  test('coming back to the foreground picks up an action that arrived unheard', () => {
    const n = fakeNative(null);
    setQuickActionsNativeForTests(n.mod);
    const spy = jest.spyOn(AppState, 'addEventListener');
    const got: QuickActionId[] = [];
    const stop = listenForQuickActions(a => got.push(a));
    const handler = spy.mock.calls[spy.mock.calls.length - 1][1] as (s: string) => void;
    n.queue('com.6yato9.scan-kit.import-file');
    handler('background');
    expect(got).toEqual([]);
    handler('active');
    handler('active');
    expect(got).toEqual(['import-file']);
    stop();
    spy.mockRestore();
  });

  test('a throwing native getter is treated as nothing waiting', async () => {
    setQuickActionsNativeForTests({
      takePendingQuickAction: () => { throw new Error('boom'); },
      isOverlayPresented: () => Promise.reject(new Error('boom')),
      addListener: () => ({ remove() {} }),
    });
    expect(takePendingQuickAction()).toBeNull();
    await expect(isOverlayPresented()).resolves.toBeNull();
  });
});
