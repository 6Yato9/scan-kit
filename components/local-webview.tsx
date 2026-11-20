// components/local-webview.tsx
// A WebView for HTML that draws the app's own page images (file:// URLs):
// filter bakes, Sign / Watermark / Timestamp, Markup, Long image, ID card.
//
// On a real iPhone, WebKit's content process is sandboxed: it reads only the
// files the app grants it when a page loads. The simulator enforces none of
// this, so every mistake here shows up on a device only. What works, verified
// on an iPhone 13 mini (iOS 26.6) with the dev build's bake logs:
//  - An HTML *string* (`source={{ html, baseUrl: 'file:///' }}`) gets no read
//    access at all: every <img src="file://…"> fails (TestFlight build 18:
//    "couldn't load the image", "couldn't sign").
//  - The HTML loaded from a file (loadFileURL:allowingReadAccessToURL:) with
//    read access to the app's container ROOT (its home folder) loads the page
//    but still fails every image: WebKit doesn't honour a grant of the home
//    folder itself (TestFlight builds 19–21: filters never load, Sign won't
//    save, BAKE_ERROR:load for files in Library/Application Support and
//    Library/Caches alike).
//  - The same with read access to <container>/Library/ loads them.
// So: the HTML is written to Caches/webview/ and the WebView may read all of
// Library/ (pages in Library/Application Support, temps and camera captures
// in Library/Caches). A page image anywhere else — Documents/ (pages of older
// versions) or tmp/ (picker temps) — is copied into Caches/webview/ for the
// life of the view and the HTML points at the copy (localImagesOutside).
//
// The HTML file and the copies are removed when the view unmounts or the HTML
// changes; stray ones are swept with the other temps (lib/files.ts TEMP_DIRS
// 'webview').
//
// Android: allowFileAccess (+ FromFileURLs / Universal, so a canvas can read
// the pixels of a file:// image) lets the WebView read every file in the
// app's private data folder, so the readable root is the whole app folder and
// nothing is copied. `allowingReadAccessToURL` is ignored there.
import { forwardRef, useEffect, useMemo } from 'react';
import { Platform } from 'react-native';
import { WebView, type WebViewProps } from 'react-native-webview';
import { Directory, File, Paths } from 'expo-file-system';
import { localImagesOutside, swapUrls, webviewReadRoot } from '@/lib/webview-access';
import { containerRoot } from '@/lib/files';

let seq = 0;

function webviewDir(): Directory {
  const dir = new Directory(Paths.cache, 'webview');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/**
 * Copies the images outside the readable folder into Caches/webview/ and
 * returns the HTML pointing at the copies, plus the copies to delete later.
 * An image that can't be copied (gone, no space) keeps its URL: it fails to
 * load as it would have, and the caller's own error path handles it.
 */
function withReadableImages(html: string, readRoot: string): { html: string; copies: string[] } {
  const outside = localImagesOutside(html, readRoot);
  if (outside.length === 0) return { html, copies: [] };
  const swaps = new Map<string, string>();
  const copies: string[] = [];
  for (const url of outside) {
    try {
      const src = new File(url.split(/[?#]/)[0]);
      if (!src.exists) continue;
      const ext = /\.([a-z0-9]{1,5})$/i.exec(src.uri)?.[1] ?? 'jpg';
      const copy = new File(webviewDir(), `img-${Date.now()}-${seq++}.${ext}`);
      src.copy(copy);
      swaps.set(url, copy.uri);
      copies.push(copy.uri);
    } catch {}
  }
  return { html: swapUrls(html, swaps), copies };
}

/** Writes `html` to a fresh file under Caches/webview/ and returns its file:// URI (null if it couldn't be written). */
export function writeHtmlFile(html: string): string | null {
  try {
    const file = new File(webviewDir(), `page-${Date.now()}-${seq++}.html`);
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
  // Android reads the whole app folder (see the header); iOS only <container>/Library/.
  const readAccess = useMemo(() => (Platform.OS === 'android' ? containerRoot() : webviewReadRoot()), []);
  const page = useMemo(() => {
    const prepared = withReadableImages(html, readAccess);
    return { uri: writeHtmlFile(prepared.html), copies: prepared.copies };
  }, [html, readAccess]);
  useEffect(() => () => {
    removeFile(page.uri);
    for (const c of page.copies) removeFile(c);
  }, [page]);
  return (
    <WebView
      ref={ref}
      {...rest}
      // Fallback keeps the old behaviour (works in the simulator) if Caches is unwritable.
      source={page.uri ? { uri: page.uri } : { html, baseUrl: 'file:///' }}
      allowingReadAccessToURL={readAccess}
      originWhitelist={['*']}
      allowFileAccess
      allowFileAccessFromFileURLs
      allowUniversalAccessFromFileURLs
    />
  );
});
