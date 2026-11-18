// components/page-stamper.tsx
// Off-screen WebView that draws a signature, watermark or timestamp into a
// page image (and its `.orig` shadow) and hands back the JPEG bytes — the
// pixel half of Sign / Watermark / Timestamp's edit in place (lib/page-stamp.ts
// does the storage half). Same trick as components/filter-baker.tsx: RN can't
// composite images, expo-image-manipulator only does geometry, so WebKit draws
// on a canvas and the result comes back as a data URL.
//
// Usage: `const stamper = usePageStamper();` render `{stamper.host}` somewhere
// in the screen that is on top (an iOS WebView buried under a full-screen
// modal never runs), then `await stamper.stamp(pageUri, origUri, spec)`.
// One page at a time; a call made while another runs waits for it.
//
// Once the screen holding the host has closed, every call (running, queued or
// new) fails at once with StampRenderError('closed'), and `stamper.signal`
// reads aborted: pass it to stampPages / stampCopy so the run puts back what
// it did instead of waiting out a page that will never be drawn.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { LocalWebView } from './local-webview';
import { useRouter } from 'expo-router';
import { buildStampHtml, parseStampMessage, type StampSpec } from '@/lib/stamp';
import {
  discardStampUndo,
  StampError,
  undoStamp,
  type StampedPixels,
  type StampSignal,
  type StampUndo,
} from '@/lib/page-stamp';
import { postViewerNotice } from '@/lib/viewer-notice';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { notifyError, notifySuccess } from '@/lib/haptics';

/**
 * A page whose WebView has said nothing for this long is treated as failed (a
 * hung content process). Measured from the last sign of life, not from the
 * start: the page posts a step as it loads and draws each image, so a slow
 * phone working through a big page is never cut off part-way.
 */
const STAMP_TIMEOUT_MS = 45_000;

type Job = {
  id: number;
  html: string;
  resolve: (r: StampedPixels) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  page: string | null;
  orig: string | null;
};

/**
 * Drawing one page failed. `message` is the page's error code (lib/stamp.ts
 * StampMessage: load-page, load-orig, load-signature, empty, canvas, encode,
 * script:…) or one of the host's: timeout, crashed, webview-load, unreadable,
 * closed.
 */
export class StampRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StampRenderError';
  }
}

/** Failures worth one more try in a fresh WebView: WebKit ran out of memory or hung. */
const RETRYABLE = new Set(['crashed', 'timeout', 'canvas', 'encode']);

/**
 * What to tell the user for a page that couldn't be drawn. The run has already
 * put back every page it changed, so each says the document is unchanged.
 */
export function stampRenderMessage(code: string): string {
  switch (code) {
    case 'load-signature':
      return 'The signature couldn’t be read. Your document is unchanged. Clear it, draw it again and try again.';
    case 'load-page':
    case 'load-orig':
    case 'empty':
      return 'The page image couldn’t be opened. Your document is unchanged. Try again — if it keeps happening, retake the page.';
    case 'canvas':
    case 'encode':
    case 'crashed':
    case 'timeout':
      return 'There wasn’t enough free memory to draw on the page. Your document is unchanged. Close other apps and try again.';
    default:
      return 'Your document is unchanged. Try again.';
  }
}

/** A signal that reads aborted once the component using it has unmounted. */
function useUnmountSignal(): { mounted: { current: boolean }; signal: StampSignal } {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const signal = useMemo<StampSignal>(() => ({ get aborted() { return !mounted.current; } }), []);
  return { mounted, signal };
}

export function usePageStamper(): {
  host: ReactNode;
  stamp: (pageUri: string, origUri: string | null, spec: StampSpec) => Promise<StampedPixels>;
  /** Aborted once the screen has closed: hand it to stampPages / stampCopy. */
  signal: StampSignal;
} {
  const [job, setJob] = useState<Job | null>(null);
  const jobRef = useRef<Job | null>(null);
  const nextId = useRef(1);
  const { mounted, signal } = useUnmountSignal();
  // Calls made while a page is drawing queue behind it.
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  const settle = useCallback((id: number, outcome: { ok: StampedPixels } | { err: Error }) => {
    const current = jobRef.current;
    if (!current || current.id !== id) return;
    clearTimeout(current.timer);
    jobRef.current = null;
    setJob(null);
    if ('ok' in outcome) current.resolve(outcome.ok);
    else current.reject(outcome.err);
  }, []);

  // Unmounted mid-job (the screen closed): fail it rather than leave it hanging.
  useEffect(() => () => {
    const current = jobRef.current;
    if (current) {
      clearTimeout(current.timer);
      jobRef.current = null;
      current.reject(new StampRenderError('closed'));
    }
  }, []);

  const runOne = useCallback((pageUri: string, origUri: string | null, spec: StampSpec) =>
    new Promise<StampedPixels>((resolve, reject) => {
      // Closed: there is no WebView to draw in any more. Fail now rather than
      // after the timeout (the run then puts its pages back straight away).
      if (!mounted.current) {
        reject(new StampRenderError('closed'));
        return;
      }
      const id = nextId.current++;
      // The query defeats WebKit's image cache after an in-place rewrite.
      const bust = `?t=${Date.now()}`;
      const html = buildStampHtml(
        pageUri.split('?')[0] + bust,
        origUri ? origUri.split('?')[0] + bust : null,
        spec,
      );
      const timer = setTimeout(() => settle(id, { err: new StampRenderError('timeout') }), STAMP_TIMEOUT_MS);
      const next: Job = { id, html, resolve, reject, timer, page: null, orig: null };
      jobRef.current = next;
      setJob(next);
    }), [settle, mounted]);

  const stamp = useCallback((pageUri: string, origUri: string | null, spec: StampSpec) => {
    const run = chain.current.then(() =>
      runOne(pageUri, origUri, spec).catch(err => {
        // Out of memory or hung: once more in a fresh WebView (a new content
        // process with nothing else in it) before giving up.
        if (!(err instanceof StampRenderError) || !RETRYABLE.has(err.message) || !mounted.current) throw err;
        console.warn(`Stamp: drawing the page failed (${err.message}), trying once more`);
        return runOne(pageUri, origUri, spec);
      }),
    );
    chain.current = run.catch(() => undefined);
    return run;
  }, [runOne, mounted]);

  const onMessage = useCallback((e: { nativeEvent: { data: string } }) => {
    const current = jobRef.current;
    if (!current) return;
    const msg = parseStampMessage(e.nativeEvent.data);
    if (!msg) return;
    // Alive: the page has the full timeout again for its next step.
    clearTimeout(current.timer);
    const id = current.id;
    current.timer = setTimeout(() => settle(id, { err: new StampRenderError('timeout') }), STAMP_TIMEOUT_MS);
    if (msg.type === 'page') {
      current.page = msg.data;
    } else if (msg.type === 'orig') {
      current.orig = msg.data;
    } else if (msg.type === 'done') {
      if (!current.page?.startsWith('data:image/jpeg') || (current.orig !== null && !current.orig.startsWith('data:image/jpeg'))) {
        settle(id, { err: new StampRenderError('unreadable') });
        return;
      }
      if (msg.scaled) console.warn('Stamp: the page was drawn below full size to fit in memory');
      settle(id, { ok: { page: current.page, orig: current.orig } });
    } else if (msg.type === 'error') {
      settle(id, { err: new StampRenderError(msg.code) });
    }
  }, [settle]);

  const onCrash = useCallback(() => {
    const current = jobRef.current;
    if (current) settle(current.id, { err: new StampRenderError('crashed') });
  }, [settle]);

  // The HTML file itself couldn't be loaded (file access, see LocalWebView).
  const onLoadFail = useCallback((e: { nativeEvent: { code?: number; description?: string } }) => {
    const current = jobRef.current;
    if (!current) return;
    console.warn(`Stamp: the drawing page didn't load (${e.nativeEvent.code ?? '?'}: ${e.nativeEvent.description ?? ''})`);
    settle(current.id, { err: new StampRenderError('webview-load') });
  }, [settle]);

  const host = useMemo(() => (job ? (
    <View style={styles.host} pointerEvents="none">
      <LocalWebView
        key={job.id}
        html={job.html}
        style={styles.web}
        onMessage={onMessage}
        onContentProcessDidTerminate={onCrash}
        onRenderProcessGone={onCrash}
        onError={onLoadFail}
        javaScriptEnabled
      />
    </View>
  ) : null), [job, onMessage, onCrash, onLoadFail]);

  return { host, stamp, signal };
}

/** Runs a stamp Undo and reports how it went in the viewer. */
async function runStampUndo(undo: StampUndo, undoneMessage: string): Promise<void> {
  try {
    await undoStamp(undo);
    notifySuccess();
    postViewerNotice({ docId: undo.docId, message: undoneMessage });
  } catch (err) {
    notifyError();
    if (!(err instanceof StampError)) console.error('Undo stamp failed', err);
    Alert.alert('Couldn’t undo', err instanceof StampError ? err.message : 'Try again.');
  }
}

/**
 * The one way Sign / Watermark / Timestamp report a failed run, so the message
 * is always true:
 * - cancelled (the screen closed mid-run; the pages were put back): nothing.
 * - partial (some pages carry the mark and couldn't be put back): says which,
 *   and offers to try putting them back again.
 * - anything else: the run already put every page back, so the document is
 *   unchanged (a StampError carries its own reason).
 */
export function reportStampFailure(err: unknown, title: string, undoneMessage = 'Change undone'): void {
  if (err instanceof StampError && err.kind === 'cancelled') return;
  notifyError();
  if (err instanceof StampError && err.kind === 'partial') {
    const undo = err.partial?.undo ?? null;
    Alert.alert(
      title,
      err.message,
      undo
        ? [
            { text: 'Keep', style: 'cancel', onPress: () => discardStampUndo(undo) },
            { text: 'Put back', onPress: () => { runStampUndo(undo, undoneMessage); } },
          ]
        : undefined,
    );
    return;
  }
  if (err instanceof StampRenderError) {
    // The code is what a device log needs to tell memory from file access.
    console.warn(`${title}: page drawing failed with "${err.message}"`);
    Alert.alert(title, stampRenderMessage(err.message));
    return;
  }
  if (!(err instanceof StampError)) console.error(`${title}:`, err);
  Alert.alert(title, err instanceof StampError ? err.message : 'Your document is unchanged. Try again.');
}

/**
 * Where a Sign / Watermark / Timestamp screen goes when it's done: back to the
 * viewer it was opened from, or (from the Tools tab) to the document's viewer,
 * which then shows `message` — with Undo for an in-place change.
 */
export function useStampFinish(fromViewer: boolean) {
  const router = useRouter();
  const { mounted } = useUnmountSignal();
  return useCallback(
    (result: {
      docId: string;
      message: string;
      /** The page to show (the first one changed). */
      page?: number;
      undo?: StampUndo | null;
      undoneMessage?: string;
      openCopy?: boolean;
    }) => {
      const { docId, message, page, undo, undoneMessage = 'Change undone', openCopy = false } = result;
      postViewerNotice({
        docId,
        message,
        page,
        action: undo ? { label: 'Undo', onPress: () => { runStampUndo(undo, undoneMessage); } } : undefined,
        // Undo wasn't used (the toast went, or a newer notice replaced it):
        // its copy of the pages is no longer needed.
        onExpire: undo ? () => discardStampUndo(undo) : undefined,
      });
      // This screen is already gone (closed as the run finished): navigating
      // from here would close whatever is on top now — the viewer itself.
      // The viewer shows the notice whenever it is next on top.
      if (!mounted.current) return;
      navigateWhenUnlocked(() => {
        if (!mounted.current) return;
        // In place from the viewer: it is right underneath, showing this document.
        if (fromViewer && !openCopy) router.back();
        else router.replace({ pathname: '/viewer', params: { id: docId } });
      });
    },
    [fromViewer, router, mounted],
  );
}

const styles = StyleSheet.create({
  // Laid out for real and covered up, like the filter baker: iOS WKWebView
  // won't run JavaScript in a zero-sized or far off-screen view.
  host: {
    position: 'absolute',
    top: -2,
    left: 0,
    width: 320,
    height: 2,
    overflow: 'hidden',
    opacity: 0.01,
    zIndex: 0,
  },
  web: { width: 320, height: 480 },
});
