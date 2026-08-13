// components/filter-baker.tsx
//
// Off-screen host for lib/bake-queue.ts: renders a hidden WebView that runs
// lib/bake-html.ts's canvas-filter HTML for one queued job at a time, and
// reports the result back through completeJob/failJob. Mounted once at the
// root (app/_layout.tsx) so it stays alive across navigation and can serve
// bake requests from anywhere (e.g. a future contexts/scan-context.tsx call)
// that isn't itself able to host a WebView.
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { buildBakeHtml } from '../lib/bake-html';
import { BakeJob, completeJob, failJob, setBakeNotifier, takeNextJob } from '../lib/bake-queue';

export function FilterBaker() {
  const [job, setJob] = useState<BakeJob | null>(null);
  // Mirrors `job` synchronously. onMessage must always act on whichever job
  // is actually current at the moment the message arrives — reading the ref
  // (rather than a `job` value captured in a render's closure) keeps that
  // true even if the WebView's message fires on a stale JS turn.
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
    return () => setBakeNotifier(null);
  }, [pump]);

  const handleMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    const current = jobRef.current;
    if (!current) return; // no job in flight — ignore a stray/late message
    const data = event.nativeEvent.data;

    if (data.startsWith('BAKE_ERROR:')) {
      failJob(current.id, data.slice('BAKE_ERROR:'.length));
    } else if (data.startsWith('data:image')) {
      completeJob(current.id, data);
    } else {
      failJob(current.id, 'unexpected message');
    }

    jobRef.current = null;
    busyRef.current = false;
    setJob(null);
    pump();
  }, [pump]);

  if (!job) return null;

  return (
    <View style={styles.hidden} pointerEvents="none">
      <WebView
        source={{ html: buildBakeHtml(job.src, job.css), baseUrl: 'file:///' }}
        style={styles.hidden}
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
  hidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
});
