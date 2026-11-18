// components/page-stamper.tsx after the screen closes (r9 code #1): a page that
// is drawing, queued or asked for later fails at once (no 45 s wait for a
// WebView that is gone), the signal reads aborted, and a finish that lands
// after the close doesn't navigate (it would close the viewer underneath).
// Failures are reported truthfully: nothing for a cancelled run, the changed
// pages for a partial one.
import { Alert } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';

jest.mock('react-native-webview', () => ({ WebView: () => null }));
const mockRouter = { back: jest.fn(), replace: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('../lib/nav-guard', () => ({ navigateWhenUnlocked: (fn: () => void) => fn() }));
jest.mock('../lib/haptics', () => ({ notifyError: jest.fn(), notifySuccess: jest.fn() }));
jest.mock('../lib/stamp', () => ({ buildStampHtml: () => '<html></html>' }));
const mockUndo = jest.fn(async (..._a: unknown[]) => ({}));
const mockDiscard = jest.fn();
jest.mock('../lib/page-stamp', () => {
  class StampError extends Error {
    kind: string;
    partial: unknown;
    constructor(k: string, message: string, p?: unknown) { super(message); this.kind = k; this.partial = p; }
  }
  return {
    StampError,
    undoStamp: (...a: unknown[]) => mockUndo(...a),
    discardStampUndo: (...a: unknown[]) => mockDiscard(...a),
  };
});

import { reportStampFailure, usePageStamper, useStampFinish } from '../components/page-stamper';
import { resetViewerNoticesForTests, takeViewerNotice } from '../lib/viewer-notice';

const { StampError } = jest.requireMock('../lib/page-stamp');
const spec = { kind: 'watermark', text: 'X', style: 'diagonal', color: 'gray' } as never;

beforeEach(() => {
  jest.clearAllMocks();
  resetViewerNoticesForTests();
});

test('closing fails the page drawing and every later one at once, and aborts the signal', async () => {
  const { result, unmount } = renderHook(() => usePageStamper());
  expect(result.current.signal.aborted).toBe(false);
  let drawing!: Promise<unknown>;
  let queued!: Promise<unknown>;
  act(() => {
    drawing = result.current.stamp('file:///p0.jpg', null, spec);
    queued = result.current.stamp('file:///p1.jpg', null, spec);
  });
  const signal = result.current.signal;
  const stamp = result.current.stamp;
  unmount();
  await expect(drawing).rejects.toThrow('closed');
  await expect(queued).rejects.toThrow('closed');
  await expect(stamp('file:///p2.jpg', null, spec)).rejects.toThrow('closed');
  expect(signal.aborted).toBe(true);
});

test('a finish that lands after the screen closed posts the notice but does not navigate', () => {
  const { result, unmount } = renderHook(() => useStampFinish(true));
  const finish = result.current;
  unmount();
  const undo = { docId: 'd1' } as never;
  finish({ docId: 'd1', message: 'Signed page 2', page: 1, undo });
  expect(mockRouter.back).not.toHaveBeenCalled();
  expect(mockRouter.replace).not.toHaveBeenCalled();
  // The viewer still offers Undo when it is next on top.
  expect(takeViewerNotice('d1')).toMatchObject({ message: 'Signed page 2', page: 1, action: { label: 'Undo' } });
});

test('while open, finish goes back to the viewer it came from', () => {
  const { result } = renderHook(() => useStampFinish(true));
  result.current({ docId: 'd1', message: 'Signed' });
  expect(mockRouter.back).toHaveBeenCalledTimes(1);
});

describe('reportStampFailure', () => {
  let alert: jest.SpyInstance;
  beforeEach(() => { alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {}); });

  test('a cancelled run (the screen closed) shows nothing', () => {
    reportStampFailure(new StampError('cancelled', 'cancelled'), 'Couldn’t sign the document');
    expect(alert).not.toHaveBeenCalled();
  });

  test('a partial run says which pages changed, never "unchanged", and can try putting them back', async () => {
    const undo = { docId: 'd1' };
    reportStampFailure(
      new StampError('partial', 'Page 1 was changed before the error and couldn’t be put back.', { changed: [0], total: 3, undo }),
      'Couldn’t sign the document',
      'Signature removed',
    );
    const [title, message, buttons] = alert.mock.calls[0];
    expect(title).toBe('Couldn’t sign the document');
    expect(message).not.toMatch(/unchanged/);
    expect(buttons.map((b: { text: string }) => b.text)).toEqual(['Keep', 'Put back']);
    await act(async () => { buttons[1].onPress(); });
    expect(mockUndo).toHaveBeenCalledWith(undo);
    buttons[0].onPress();
    expect(mockDiscard).toHaveBeenCalledWith(undo);
  });

  test('anything else was rolled back: the document is unchanged', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    reportStampFailure(new Error('webview died'), 'Couldn’t add the watermark');
    expect(alert).toHaveBeenCalledWith('Couldn’t add the watermark', 'Your document is unchanged. Try again.');
  });
});
