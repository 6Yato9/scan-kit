// lib/viewer-notice.ts: an action's resources (a stamp's Undo stash) are
// released once the action can no longer be used (r9 code #5), and never
// while it still can.
import {
  ACTION_WINDOW_MS,
  postViewerNotice,
  resetViewerNoticesForTests,
  takeViewerNotice,
} from '../lib/viewer-notice';

beforeEach(() => {
  jest.useFakeTimers();
  resetViewerNoticesForTests();
});
afterEach(() => jest.useRealTimers());

test('expires ACTION_WINDOW_MS after the viewer took it when the action went unused', () => {
  const onExpire = jest.fn();
  postViewerNotice({ docId: 'a', message: 'Signed', action: { label: 'Undo', onPress: jest.fn() }, onExpire });
  const n = takeViewerNotice('a')!;
  jest.advanceTimersByTime(ACTION_WINDOW_MS - 1);
  expect(onExpire).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(onExpire).toHaveBeenCalledTimes(1);
  // Too late: the stash is gone, so the action does nothing.
  n.action!.onPress();
  jest.runAllTimers();
  expect(onExpire).toHaveBeenCalledTimes(1);
});

test('using the action cancels the expiry, and it runs once', () => {
  const onExpire = jest.fn();
  const onPress = jest.fn();
  postViewerNotice({ docId: 'a', message: 'Signed', action: { label: 'Undo', onPress }, onExpire });
  const n = takeViewerNotice('a')!;
  n.action!.onPress();
  n.action!.onPress();
  jest.runAllTimers();
  expect(onPress).toHaveBeenCalledTimes(1);
  expect(onExpire).not.toHaveBeenCalled();
});

test('a notice replaced before any viewer took it expires at once', () => {
  const first = jest.fn();
  const second = jest.fn();
  postViewerNotice({ docId: 'a', message: 'Signed', onExpire: first });
  postViewerNotice({ docId: 'b', message: 'Watermark added', onExpire: second });
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
  expect(takeViewerNotice('a')).toBeNull();
  expect(takeViewerNotice('b')).toMatchObject({ message: 'Watermark added' });
});

test('a notice without onExpire is handed over untouched', () => {
  const action = { label: 'Open', onPress: jest.fn() };
  postViewerNotice({ docId: 'a', message: 'Saved', action });
  expect(takeViewerNotice('a')!.action).toBe(action);
});

// Round 12b: the viewer keeps an Undo in its "…" menu until the next edit
// (lib/last-undo.ts), so it holds the notice's action past ACTION_WINDOW_MS.
describe('hold', () => {
  test('a held action outlives ACTION_WINDOW_MS and its release expires it once', () => {
    const onExpire = jest.fn();
    const onPress = jest.fn();
    postViewerNotice({ docId: 'a', message: 'Signed', action: { label: 'Undo', onPress }, onExpire });
    const n = takeViewerNotice('a')!;
    const release = n.hold!();
    jest.advanceTimersByTime(ACTION_WINDOW_MS * 10);
    expect(onExpire).not.toHaveBeenCalled();
    release();
    release();
    expect(onExpire).toHaveBeenCalledTimes(1);
    n.action!.onPress();
    expect(onPress).not.toHaveBeenCalled();
  });

  test('releasing after the action was used releases nothing', () => {
    const onExpire = jest.fn();
    const onPress = jest.fn();
    postViewerNotice({ docId: 'a', message: 'Signed', action: { label: 'Undo', onPress }, onExpire });
    const n = takeViewerNotice('a')!;
    const release = n.hold!();
    n.action!.onPress();
    release();
    jest.runAllTimers();
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onExpire).not.toHaveBeenCalled();
  });

  test('holding after it expired is a no-op', () => {
    const onExpire = jest.fn();
    postViewerNotice({ docId: 'a', message: 'Signed', action: { label: 'Undo', onPress: jest.fn() }, onExpire });
    const n = takeViewerNotice('a')!;
    jest.advanceTimersByTime(ACTION_WINDOW_MS);
    n.hold!()();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
