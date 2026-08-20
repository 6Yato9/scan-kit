// components/filter-baker.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { buildBakeHtml } from '@/lib/bake-html';
import { BakeJob, completeJob, failJob, releaseJob, setBakeNotifier, takeNextJob } from '@/lib/bake-queue';

/**
 * Off-screen WebView that turns queued bake jobs into filtered JPEG bytes.
 *
 * RN 0.81's iOS `filter` style implements only brightness/opacity, so
 * grayscale/contrast/saturate have to be rendered by WebKit and read back through
 * a canvas — the same trick app/annotate.tsx uses. expo-image-manipulator cannot
 * help: its actions are geometry only.
 *
 * MOUNTING: this must be rendered by whichever screen is actually on top. A
 * `fullScreenModal` (the viewer) is presented in its own native view controller
 * that covers everything below it, so a baker mounted only at the root is buried
 * under the modal, never becomes visible, and iOS then never loads its WebView at
 * all — no loadStart, no onMessage, and every bake hangs forever. Hence one
 * instance at the root (for the tabs) and one inside the viewer.
 *
 * The file-access props are load-bearing: without allowUniversalAccessFromFileURLs
 * the canvas is tainted by the file:// image and toDataURL throws SecurityError.
 */
export function FilterBaker() {
  const [job, setJob] = useState<BakeJob | null>(null);
  const jobRef = useRef<BakeJob | null>(null);
  const busyRef = useRef(false);

  const pump = useCallback(() => {
    if (busyRef.current) return;
    const next = takeNextJob();
    if (!next) return;
    busyRef.current = true;
    jobRef.current = next;
    setJob(next);
  }, []);

  useEffect(() => {
    setBakeNotifier(pump);
    pump();
    return () => {
      setBakeNotifier(null);
      // Hand any in-flight job back to the queue rather than stranding it. This
      // instance is going away (screen dismissed) and its WebView will never
      // report; without this the enqueuer's promise never settles.
      const inFlight = jobRef.current;
      jobRef.current = null;
      busyRef.current = false;
      if (inFlight) releaseJob(inFlight);
    };
  }, [pump]);

  const handleMessage = useCallback((e: { nativeEvent: { data: string } }) => {
    // Read the ref, not the render-captured `job` — the message can arrive on a
    // turn where this closure was built for a previous job.
    const current = jobRef.current;
    if (!current) return;
    const data = e.nativeEvent.data;
    if (data.startsWith('BAKE_ERROR:')) {
      failJob(current.id, data.slice('BAKE_ERROR:'.length));
    } else if (data.startsWith('data:image')) {
      completeJob(current.id, data);
    } else {
      failJob(current.id, 'unexpected message');
    }
    jobRef.current = null;
    setJob(null);
    busyRef.current = false;
    pump();
  }, [pump]);

  if (!job) return null;

  return (
    <View style={styles.host} pointerEvents="none">
      <WebView
        source={{ html: buildBakeHtml(job.src, job.ops), baseUrl: 'file:///' }}
        style={styles.web}
        onMessage={handleMessage}
        originWhitelist={['*']}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
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
