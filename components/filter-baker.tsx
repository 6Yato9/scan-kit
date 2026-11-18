// components/filter-baker.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { LocalWebView } from './local-webview';
import { buildBakeHtml, buildPreviewHtml } from '@/lib/bake-html';
import { BakeHost, BakeJob, completeJob, failJob, registerBakeHost, releaseJob, takeNextJob } from '@/lib/bake-queue';

/**
 * Off-screen WebView that turns queued bake jobs into filtered JPEG bytes.
 *
 * RN 0.81's iOS `filter` style implements only brightness/opacity, so
 * grayscale/contrast/saturate have to be rendered by WebKit and read back through
 * a canvas — the same trick app/annotate.tsx uses. expo-image-manipulator cannot
 * help: its actions are geometry only.
 *
 * MOUNTING: this must be rendered by whichever screen is actually on top. A
 * full-screen modal is presented in its own native view controller that covers
 * everything below it, so a baker mounted only at the root is buried, and iOS
 * never runs its WebView. Hence one instance at the root (for the tabs) and one
 * inside every full-screen surface (viewer, annotate, crop). The queue keeps
 * them in a stack and only feeds the newest one; when it unmounts, the one
 * underneath is woken (see lib/bake-queue.ts).
 *
 * The file-access props are load-bearing: without allowUniversalAccessFromFileURLs
 * the canvas is tainted by the file:// image and toDataURL throws SecurityError.
 */
export function FilterBaker() {
  const [job, setJob] = useState<BakeJob | null>(null);
  // Bumped to force a brand-new WebView after a content-process crash.
  const [generation, setGeneration] = useState(0);
  const jobRef = useRef<BakeJob | null>(null);
  const hostRef = useRef<BakeHost | null>(null);

  const finish = useCallback(() => {
    jobRef.current = null;
    setJob(null);
  }, []);

  const pump = useCallback(() => {
    if (jobRef.current || !hostRef.current) return;
    const next = takeNextJob(hostRef.current);
    if (!next) return;
    jobRef.current = next;
    setJob(next);
  }, []);

  const host = useMemo<BakeHost>(() => ({
    pump: () => pump(),
    revoke: (jobId: number) => {
      // The queue took this job back (we were covered, or it timed out). Drop
      // it so a late message can't be attributed to it, and look for more.
      if (jobRef.current?.id === jobId) {
        jobRef.current = null;
        setJob(null);
        setGeneration(g => g + 1);
      }
      setTimeout(pump, 0);
    },
  }), [pump]);

  useEffect(() => {
    hostRef.current = host;
    const unregister = registerBakeHost(host);
    return () => {
      hostRef.current = null;
      jobRef.current = null;
      // Hands anything this instance was holding back to the queue and wakes
      // the host underneath (the one that becomes visible again).
      unregister();
    };
  }, [host]);

  const handleMessage = useCallback((e: { nativeEvent: { data: string } }) => {
    // Read the ref, not the render-captured `job` — the message can arrive on a
    // turn where this closure was built for a previous job.
    const current = jobRef.current;
    if (!current) return;
    const data = e.nativeEvent.data;
    if (data.startsWith('BAKE_ERROR:')) {
      failJob(current.id, data.slice('BAKE_ERROR:'.length));
    } else if (data.startsWith('PREVIEWS:') || data.startsWith('data:image')) {
      completeJob(current.id, data);
    } else {
      failJob(current.id, 'unexpected message');
    }
    finish();
    // Next job on the following tick, after this WebView has unmounted.
    setTimeout(pump, 0);
  }, [finish, pump]);

  // WebKit's content process can be killed under memory pressure (large pages).
  // Without this the job would sit leased until the timeout; instead hand it
  // straight back and start over with a fresh WebView.
  const handleCrash = useCallback(() => {
    const current = jobRef.current;
    finish();
    setGeneration(g => g + 1);
    if (current) releaseJob(current);
  }, [finish]);

  const handleLoadError = useCallback(() => {
    const current = jobRef.current;
    if (!current) return;
    failJob(current.id, 'webview load error');
    finish();
    setTimeout(pump, 0);
  }, [finish, pump]);

  if (!job) return null;

  return (
    <View style={styles.host} pointerEvents="none">
      <LocalWebView
        key={`${job.id}-${generation}`}
        html={job.previews
          ? buildPreviewHtml(job.src, job.previews, job.previewWidth ?? 120)
          : buildBakeHtml(job.src, job.ops)}
        style={styles.web}
        onMessage={handleMessage}
        onContentProcessDidTerminate={handleCrash}
        onRenderProcessGone={handleCrash}
        onError={handleLoadError}
        javaScriptEnabled
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // A real on-screen layout box, nudged just off the top edge and behind the
  // screen's own content. iOS WKWebView will not run its JavaScript when it is
  // sized to nothing or parked far outside the viewport, so it cannot simply be
  // hidden — it has to be laid out for real and covered up.
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
  web: {
    width: 320,
    height: 480,
  },
});
