// components/local-webview.tsx
// A WebView for HTML that draws the app's own page images (file:// URLs):
// filter bakes, Sign / Watermark / Timestamp, Markup, Long image.
//
// Why not `source={{ html, baseUrl: 'file:///' }}`: on a real iPhone, WebKit's
// content process is sandboxed and an HTML *string* gets no read access to the
// app's files, so every <img src="file://…"> fails to load ("couldn't load the
// image", "couldn't sign"). The simulator doesn't enforce that sandbox, which
// is why it only shows up on a device. The supported way is to load the HTML
// from a file with loadFileURL:allowingReadAccessToURL: — so the HTML is written
// to Caches/webview/ and the WebView is given read access to the app's
// container (pages live in Library/Application Support, older ones in
// Documents, temps in Library/Caches and tmp — all under the container root).
//
// The HTML file is removed when the view unmounts or the HTML changes; stray
// ones are swept with the other temps (lib/files.ts TEMP_DIRS 'webview').
import { forwardRef, useEffect, useMemo } from 'react';
import { WebView, type WebViewProps } from 'react-native-webview';
import { Directory, File, Paths } from 'expo-file-system';
import { containerRoot } from '@/lib/files';

let seq = 0;

/** Writes `html` to a fresh file under Caches/webview/ and returns its file:// URI (null if it couldn't be written). */
export function writeHtmlFile(html: string): string | null {
  try {
    const dir = new Directory(Paths.cache, 'webview');
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const file = new File(dir, `page-${Date.now()}-${seq++}.html`);
    file.write(html);
    return file.uri;
  } catch {
    return null;
  }
}

function removeFile(uri: string | null): void {
  if (!uri) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {}
}

type Props = Omit<WebViewProps, 'source' | 'allowingReadAccessToURL'> & { html: string };

export const LocalWebView = forwardRef<WebView, Props>(function LocalWebView({ html, ...rest }, ref) {
  const fileUri = useMemo(() => writeHtmlFile(html), [html]);
  useEffect(() => () => removeFile(fileUri), [fileUri]);
  const readAccess = useMemo(() => containerRoot(), []);
  return (
    <WebView
      ref={ref}
      {...rest}
      // Fallback keeps the old behaviour (works in the simulator) if Caches is unwritable.
      source={fileUri ? { uri: fileUri } : { html, baseUrl: 'file:///' }}
      allowingReadAccessToURL={readAccess}
      originWhitelist={['*']}
      allowFileAccess
      allowFileAccessFromFileURLs
      allowUniversalAccessFromFileURLs
    />
  );
});
