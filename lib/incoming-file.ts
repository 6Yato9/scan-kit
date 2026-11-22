// lib/incoming-file.ts
// "Open in Scan Kit": iOS hands the app a file:// URL when the user shares a
// PDF or an image to it from Mail, Files, Safari… (app.json registers the
// document types). Android hands it a content:// URL ("Open with" is a VIEW
// intent; "Share to Scan Kit" is rewritten into one by modules/vision-ocr,
// and several shared files arrive as scankit://import?uris=[…]&k=…). These
// helpers decide what that URL is and where it goes.
//
// Only files the user handed over are imported. Any app, and any web page,
// can open a scankit:// link or hand Scan Kit a URL, and Scan Kit can always
// read its own files, so: a route to /import carries a secret only this
// module knows (app/import.tsx refuses one without it); a link aimed at
// /import from outside goes Home; the multi-file link needs the key the
// Android share rewrite put on it (never made on iOS); and URLs into Scan
// Kit's own storage are refused (iOS: anything in the container but the
// Inbox copies "Open in" makes; Android: file:// and our own providers).
// Pure functions, so the mapping is unit-tested (__tests__/incoming-file.test.ts).

export type ImportKind = 'pdf' | 'image';

/** PDF or image, from a MIME type or, failing that, the file name. Null for anything else. */
export function importKindOf(uri: string, mimeType?: string | null): ImportKind | null {
  const mime = (mimeType ?? '').toLowerCase();
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  let path = uri.split('?')[0].split('#')[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // Malformed escapes: judge the raw name.
  }
  path = path.toLowerCase();
  if (path.endsWith('.pdf')) return 'pdf';
  if (/\.(jpe?g|png|heic|heif|gif|webp|tiff?|bmp)$/.test(path)) return 'image';
  return null;
}

/** True for a local file URL (what iOS passes for "Open in…"). */
export function isFileUrl(url: string): boolean {
  return /^file:\/\//i.test(url.trim());
}

/** True for an Android content provider URL (what "Open with" / "Share" pass there). */
export function isContentUrl(url: string): boolean {
  return /^content:\/\//i.test(url.trim());
}

/** The in-app route that imports a file and opens it. */
export const IMPORT_ROUTE = '/import';

/** Several files shared at once on Android (modules/vision-ocr IncomingFiles.rewriteShareIntent). */
const MULTI_IMPORT = /^scankit:\/\/\/?import\?uris=([^&#]*)/i;
const SHARE_KEY = /[?&]k=([^&#]*)/;

/**
 * Secret of this JS runtime, on every /import route routeForIncomingUrl makes
 * (`via`). Nothing outside the app can see it, so a crafted link that lands
 * on /import directly can't carry it.
 */
const IMPORT_TOKEN = [Date.now(), Math.random(), Math.random(), Math.random()]
  .map(n => n.toString(36).replace('0.', ''))
  .join('');

/** True when an /import route's `via` is this runtime's secret (it came from routeForIncomingUrl). */
export function isTrustedImportRoute(via: string | string[] | null | undefined): boolean {
  return typeof via === 'string' && via === IMPORT_TOKEN;
}

export type IncomingContext = {
  /**
   * Android: VisionOcr.incomingShareKey(), the key IncomingFiles puts on the
   * multi-file link. Without it (iOS, which never makes that link) the link
   * is refused.
   */
  shareKey?: string | null;
  /** Whether a file:// URL can be a real "Open in" (iOS). Android hands files over as content:// only. */
  fileUrls?: boolean;
  /** True for a URL into Scan Kit's own storage (isOwnFileUrl / isOwnContentUrl). */
  isOwn?: (url: string) => boolean;
};

/** One spelling per file URL: no ?query or #fragment, escapes decoded, /private/var as /var. */
function fileKey(url: string): string {
  let u = url.trim().split('?')[0].split('#')[0];
  try {
    u = decodeURIComponent(u);
  } catch {}
  // "a/./b", "a//b" and "a/x/../b" are the same file as "a/b".
  const m = /^file:\/\/([^/]*)(\/.*)?$/i.exec(u);
  if (!m) return u;
  const parts: string[] = [];
  for (const seg of (m[2] ?? '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `file:///${parts.join('/')}`.replace(/^file:\/\/\/private\/var\//, 'file:///var/');
}

/**
 * True for a file URL inside the app's container (`containerRoot`, ending in
 * "/") other than a copy "Open in" made for us: a direct child of
 * Documents/Inbox/ or tmp/<bundle id>-Inbox/. Such a URL can only come from
 * a link someone crafted, never from the system handing over a file.
 */
export function isOwnFileUrl(url: string, containerRoot: string): boolean {
  if (!isFileUrl(url) || !containerRoot) return false;
  const root = fileKey(containerRoot).replace(/\/*$/, '/');
  const key = fileKey(url);
  if (`${key}/` === root) return true;
  if (!key.startsWith(root)) return false;
  const rest = key.slice(root.length);
  return !/^(?:Documents\/Inbox|tmp\/[^/]+-Inbox)\/[^/]+$/.test(rest);
}

/** True for a content:// URL served by one of this app's own providers (authority = package name or below it). */
export function isOwnContentUrl(url: string, packageName: string | null | undefined): boolean {
  const m = /^content:\/\/([^/?#]*)/i.exec(url.trim());
  if (!m || !packageName) return false;
  let authority = m[1].toLowerCase();
  try {
    authority = decodeURIComponent(authority);
  } catch {}
  const pkg = packageName.toLowerCase();
  return authority === pkg || authority.startsWith(`${pkg}.`);
}

/** True for a link aimed straight at the import screen (scankit://import?…, /import, scankit:///--/import…). */
function targetsImportRoute(path: string): boolean {
  const rest = path.trim().replace(/^[a-z][a-z0-9+.-]*:/i, '').replace(/^\/+/, '').replace(/^--\/+/, '');
  return /^import(?:[/?#]|$)/i.test(rest);
}

function importRoute(param: 'uri' | 'uris', value: string): string {
  return `${IMPORT_ROUTE}?${param}=${encodeURIComponent(value)}&via=${IMPORT_TOKEN}`;
}

/**
 * expo-router's `redirectSystemPath` mapping: a file URL for a PDF or an image
 * becomes `/import?uri=…`; a file of any other type goes Home (nothing to
 * import). An Android content:// URL can't be judged by its name (it has
 * none), so it always goes to /import, which asks the system for its type.
 * Several shared files become `/import?uris=[…]` (with the share key, see
 * IncomingContext). Each /import route carries this runtime's secret (`via`).
 * URLs into Scan Kit's own storage, and links aimed at /import from outside,
 * go Home. Every other URL (the app's own scheme, links) passes through.
 */
export function routeForIncomingUrl(path: string, context: IncomingContext = {}): string {
  if (!path) return path;
  const { shareKey, fileUrls = true, isOwn } = context;
  const acceptable = (u: string) => !(isOwn?.(u)) && (fileUrls || !isFileUrl(u));
  const trimmed = path.trim();
  const multi = MULTI_IMPORT.exec(trimmed);
  if (multi) {
    const key = SHARE_KEY.exec(trimmed)?.[1];
    if (!shareKey || !key || safeDecode(key) !== shareKey) return '/';
    const uris = parseIncomingUris(undefined, safeDecode(multi[1])).filter(acceptable);
    return uris.length ? importRoute('uris', JSON.stringify(uris)) : '/';
  }
  if (isContentUrl(trimmed)) return acceptable(trimmed) ? importRoute('uri', trimmed) : '/';
  if (!isFileUrl(trimmed)) return targetsImportRoute(trimmed) ? '/' : path;
  if (!acceptable(trimmed) || !importKindOf(trimmed)) return '/';
  return importRoute('uri', trimmed);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return '';
  }
}

/**
 * The incoming files of an /import route: `uri` (one file) or `uris` (a JSON
 * array of file:// or content:// URLs). Anything else is dropped.
 */
export function parseIncomingUris(uri?: string | null, uris?: string | null): string[] {
  const out: string[] = [];
  const add = (u: unknown) => {
    if (typeof u !== 'string') return;
    const t = u.trim();
    if ((isFileUrl(t) || isContentUrl(t)) && !out.includes(t)) out.push(t);
  };
  if (uris) {
    try {
      const list = JSON.parse(uris);
      if (Array.isArray(list)) list.forEach(add);
    } catch {
      // Not a list: nothing to import from it.
    }
  }
  if (uri) add(uri);
  return out;
}

export type IncomingItem = { uri: string; kind: ImportKind | null };

/**
 * What to import from the files shared together: every image as the pages of
 * one document (in the order shared), or, with no image among them, the first
 * PDF. Null when none can be imported.
 */
export function planIncomingImport(items: IncomingItem[]): { kind: ImportKind; uris: string[] } | null {
  const images = items.filter(i => i.kind === 'image').map(i => i.uri);
  if (images.length) return { kind: 'image', uris: images };
  const pdf = items.find(i => i.kind === 'pdf');
  return pdf ? { kind: 'pdf', uris: [pdf.uri] } : null;
}

/**
 * The file name to show while importing ("Invoice.pdf"), from a file URL.
 * Falls back to "this file".
 */
export function displayNameOf(uri: string): string {
  const last = uri.replace(/^[a-z]+:\/\//i, '').split('?')[0].split('#')[0].split('/').filter(Boolean).pop();
  if (!last) return 'this file';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** The document name for an imported file: its name without the extension. */
export function documentNameFor(uri: string): string | null {
  const name = displayNameOf(uri);
  if (name === 'this file') return null;
  return documentNameFromFileName(name);
}

/** "Invoice.pdf" → "Invoice" (a file name as the system reports it, e.g. for a content:// URL). */
export function documentNameFromFileName(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = name.replace(/\.[a-z0-9]{1,5}$/i, '').trim();
  return base || null;
}
