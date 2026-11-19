// lib/webview-access.ts
// Which app files a LocalWebView (components/local-webview.tsx) can read on a
// real iPhone, and the pure helpers that keep page images inside that folder.
// See the component's header for why it is <container>/Library/ and not the
// container root (verified on a device; the simulator enforces nothing).
import { containerRoot } from './files';

/** The folder the WebView may read: <container>/Library/ (see the header). */
export function webviewReadRoot(root: string = containerRoot()): string {
  return `${root.replace(/\/*$/, '/')}Library/`;
}

/** file:// URLs in `html` (attributes, CSS url(), JS strings): up to a quote, whitespace, `)` or `<`. */
const FILE_URL = /file:\/\/\/[^"'\s)<>`\\]+/g;

/** A file URL's path, comparable across `/private/var` and `/var` and percent-encoding. */
function pathKey(uri: string): string {
  let p = uri.replace(/^file:\/\//, '').split(/[?#]/)[0];
  try {
    p = decodeURI(p);
  } catch {}
  return p.replace(/^\/private\/var\//, '/var/');
}

/**
 * The distinct file:// URLs in `html` that lie outside `readRoot` (so the
 * WebView couldn't read them). Pure; see the header.
 */
export function localImagesOutside(html: string, readRoot: string): string[] {
  const root = pathKey(readRoot).replace(/\/*$/, '/');
  const out = new Set<string>();
  for (const url of html.match(FILE_URL) ?? []) {
    if (!pathKey(url).startsWith(root)) out.add(url);
  }
  return [...out];
}

/** `html` with every occurrence of each key of `swaps` replaced by its value. Pure. */
export function swapUrls(html: string, swaps: Map<string, string>): string {
  if (swaps.size === 0) return html;
  return html.replace(FILE_URL, url => swaps.get(url) ?? url);
}

