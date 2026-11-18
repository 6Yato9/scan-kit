// components/page-stamper.tsx after the screen closes (r9 code #1): a page that
// is drawing, queued or asked for later fails at once (no 45 s wait for a
// WebView that is gone), the signal reads aborted, and a finish that lands
// after the close doesn't navigate (it would close the viewer underneath).
// Failures are reported truthfully: nothing for a cancelled run, the changed
// pages for a partial one.
import { Alert } from 'react-native';
import { act, render, renderHook } from '@testing-library/react-native';

jest.mock('react-native-webview', () => ({ WebView: () => null }));
jest.mock('../components/local-webview', () => ({ LocalWebView: () => null }));
const mockRouter = { back: jest.fn(), replace: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('../lib/nav-guard', () => ({ navigateWhenUnlocked: (fn: () => void) => fn() }));
jest.mock('../lib/haptics', () => ({ notifyError: jest.fn(), notifySuccess: jest.fn() }));
jest.mock('../lib/stamp', () => ({
  buildStampHtml: () => '<html></html>',
  parseStampMessage: jest.requireActual('../lib/stamp').parseStampMessage,
}));
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

import { reportStampFailure, StampRenderError, stampRenderMessage, usePageStamper, useStampFinish } from '../components/page-stamper';
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

describe('drawing a page (one WebView at a time)', () => {
  let stamper!: ReturnType<typeof usePageStamper>;
  function Host() {
    stamper = usePageStamper();
    return <>{stamper.host}</>;
  }
  const webView = (root: { findAll: (p: (n: { props: Record<string, unknown> }) => boolean) => { props: Record<string, unknown> }[] }) =>
    root.findAll(n => typeof n.props.onMessage === 'function' && typeof n.props.html === 'string')[0];
  const send = (root: Parameters<typeof webView>[0], data: string) =>
    act(() => { (webView(root).props.onMessage as (e: unknown) => void)({ nativeEvent: { data } }); });

  test('the page and its shadow arrive one at a time, then done', async () => {
    const { UNSAFE_root } = render(<Host />);
    let run!: Promise<unknown>;
    act(() => { run = stamper.stamp('file:///p.jpg', 'file:///p.orig.jpg', spec); });
    await act(async () => {});
    send(UNSAFE_root, 'STAMP_STEP:page-loaded');
    send(UNSAFE_root, 'STAMP_PAGE:data:image/jpeg;base64,PAGE');
    send(UNSAFE_root, 'STAMP_ORIG:data:image/jpeg;base64,ORIG');
    send(UNSAFE_root, 'STAMP_DONE:{"scaled":false}');
    await expect(run).resolves.toEqual({ page: 'data:image/jpeg;base64,PAGE', orig: 'data:image/jpeg;base64,ORIG' });
  });

  test('an error code fails the page with that code', async () => {
    const { UNSAFE_root } = render(<Host />);
    let run!: Promise<unknown>;
    act(() => { run = stamper.stamp('file:///p.jpg', null, spec); });
    await act(async () => {});
    send(UNSAFE_root, 'STAMP_ERROR:load-page');
    await expect(run).rejects.toThrow('load-page');
  });

  test('out of memory: tried once more in a fresh WebView before failing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { UNSAFE_root } = render(<Host />);
    let run!: Promise<unknown>;
    act(() => { run = stamper.stamp('file:///p.jpg', null, spec); });
    await act(async () => {});
    send(UNSAFE_root, 'STAMP_ERROR:encode');
    await act(async () => {});
    // The retry: a new page, which this time works.
    send(UNSAFE_root, 'STAMP_PAGE:data:image/jpeg;base64,OK');
    send(UNSAFE_root, 'STAMP_DONE:{"scaled":true}');
    await expect(run).resolves.toEqual({ page: 'data:image/jpeg;base64,OK', orig: null });
    warn.mockRestore();
  });

  test('done without a usable page is a failure, never a blank page', async () => {
    const { UNSAFE_root } = render(<Host />);
    let run!: Promise<unknown>;
    act(() => { run = stamper.stamp('file:///p.jpg', null, spec); });
    await act(async () => {});
    send(UNSAFE_root, 'STAMP_PAGE:data:,');
    send(UNSAFE_root, 'STAMP_DONE:{}');
    await expect(run).rejects.toThrow('unreadable');
  });
});

describe('what a failed drawing tells the user', () => {
  test('each cause says what to do, and that the document is unchanged', () => {
    for (const code of ['load-signature', 'load-page', 'canvas', 'crashed', 'timeout', 'script:x', 'webview-load']) {
      expect(stampRenderMessage(code)).toMatch(/unchanged/);
    }
    expect(stampRenderMessage('canvas')).toMatch(/memory/);
    expect(stampRenderMessage('load-signature')).toMatch(/draw it again/);
  });

  test('the alert carries it, and the code goes to the device log', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    reportStampFailure(new StampRenderError('encode'), 'Couldn’t sign the document');
    expect(alert).toHaveBeenCalledWith('Couldn’t sign the document', stampRenderMessage('encode'));
    expect(warn.mock.calls[0][0]).toContain('encode');
    alert.mockRestore();
    warn.mockRestore();
  });
});
