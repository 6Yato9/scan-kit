// __tests__/nav-guard.test.ts
// Navigation after slow work must never act on the /lock route (r5 code review H1):
// held while locked or while the lock screen is still on screen, then run in order.
import {
  FLUSH_DELAY_MS,
  isAppLocked,
  isNavigationHeld,
  navigateWhenUnlocked,
  pickerHandoffStep,
  resetNavGuardForTests,
  setNavLockState,
} from '../lib/nav-guard';

beforeEach(() => {
  jest.useFakeTimers();
  resetNavGuardForTests();
});
afterEach(() => jest.useRealTimers());

describe('navigateWhenUnlocked', () => {
  test('runs immediately while the app is unlocked', () => {
    const nav = jest.fn();
    navigateWhenUnlocked(nav);
    expect(nav).toHaveBeenCalledTimes(1);
  });

  test('holds the navigation while locked, runs it after unlock once /lock has gone', () => {
    // The app went to the background mid-save: the gate locked and pushed /lock.
    setNavLockState({ locked: true });
    setNavLockState({ lockRouteShown: true });
    const nav = jest.fn();
    navigateWhenUnlocked(nav);
    jest.advanceTimersByTime(10_000);
    expect(nav).not.toHaveBeenCalled();

    // Face ID succeeded, but /lock is still the top screen (it dismisses
    // itself): replacing now would replace the lock route, not the tool.
    setNavLockState({ locked: false });
    jest.advanceTimersByTime(10_000);
    expect(nav).not.toHaveBeenCalled();

    // /lock has closed: the tool screen is on top again.
    setNavLockState({ lockRouteShown: false });
    jest.advanceTimersByTime(FLUSH_DELAY_MS - 1);
    expect(nav).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(nav).toHaveBeenCalledTimes(1);
  });

  test('locked over a picker (no /lock route): runs right after unlock', () => {
    setNavLockState({ locked: true });
    const nav = jest.fn();
    navigateWhenUnlocked(nav);
    setNavLockState({ locked: false });
    jest.advanceTimersByTime(FLUSH_DELAY_MS);
    expect(nav).toHaveBeenCalledTimes(1);
  });

  test('locking again during the flush delay keeps holding', () => {
    setNavLockState({ locked: true });
    const nav = jest.fn();
    navigateWhenUnlocked(nav);
    setNavLockState({ locked: false });
    jest.advanceTimersByTime(FLUSH_DELAY_MS / 2);
    setNavLockState({ locked: true });
    jest.advanceTimersByTime(10_000);
    expect(nav).not.toHaveBeenCalled();
    setNavLockState({ locked: false });
    jest.advanceTimersByTime(FLUSH_DELAY_MS);
    expect(nav).toHaveBeenCalledTimes(1);
  });

  test('held navigations run once each, in order, and later ones queue behind them', () => {
    setNavLockState({ locked: true });
    const order: string[] = [];
    navigateWhenUnlocked(() => order.push('a'));
    navigateWhenUnlocked(() => order.push('b'));
    setNavLockState({ locked: false });
    // Requested after the unlock but before the held ones ran: must not jump the queue.
    navigateWhenUnlocked(() => order.push('c'));
    expect(order).toEqual([]);
    jest.advanceTimersByTime(FLUSH_DELAY_MS);
    expect(order).toEqual(['a', 'b', 'c']);
    jest.advanceTimersByTime(10_000);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  test('a withdrawn navigation never runs; a throwing one does not stop the rest', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    setNavLockState({ locked: true });
    const withdrawn = jest.fn();
    const after = jest.fn();
    const cancel = navigateWhenUnlocked(withdrawn);
    navigateWhenUnlocked(() => { throw new Error('boom'); });
    navigateWhenUnlocked(after);
    cancel();
    setNavLockState({ locked: false });
    jest.advanceTimersByTime(FLUSH_DELAY_MS);
    expect(withdrawn).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('exposes the lock state synchronously (alert guard)', () => {
    expect(isAppLocked()).toBe(false);
    setNavLockState({ locked: true });
    expect(isAppLocked()).toBe(true);
    expect(isNavigationHeld()).toBe(true);
    setNavLockState({ locked: false, lockRouteShown: true });
    expect(isAppLocked()).toBe(false);
    expect(isNavigationHeld()).toBe(true);
  });
});

describe('pickerHandoffStep (r5 M2)', () => {
  const routes = ['/lock', '/import'];
  const base = { overPicker: true, locked: true, pickerOpen: false, pathname: '/viewer', lockRoutes: routes };

  test('the last picker closed while locked: push /lock (overlay stays meanwhile)', () => {
    expect(pickerHandoffStep(base)).toBe('push-lock');
  });

  test('once a lock screen route is on screen the overlay can go', () => {
    expect(pickerHandoffStep({ ...base, pathname: '/lock' })).toBe('clear-overlay');
    expect(pickerHandoffStep({ ...base, pathname: '/import' })).toBe('clear-overlay');
  });

  test('nothing to do while a picker is still open, when unlocked, or with no overlay', () => {
    expect(pickerHandoffStep({ ...base, pickerOpen: true })).toBe('none');
    expect(pickerHandoffStep({ ...base, locked: false })).toBe('none');
    expect(pickerHandoffStep({ ...base, overPicker: false })).toBe('none');
  });
});
