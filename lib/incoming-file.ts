// lib/incoming-file.ts
// "Open in Scan Kit": iOS hands the app a file:// URL when the user shares a
// PDF or an image to it from Mail, Files, Safari… (app.json registers the
// document types). Android hands it a content:// URL ("Open with" is a VIEW
// intent; "Share to Scan Kit" is rewritten into one by modules/vision-ocr,
// and several shared files arrive as scankit://import?uris=[…]). These helpers
// decide what that URL is and where it goes.
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

/**
 * expo-router's `redirectSystemPath` mapping: a file URL for a PDF or an image
 * becomes `/import?uri=…`; a file of any other type goes Home (nothing to
 * import). An Android content:// URL can't be judged by its name (it has
 * none), so it always goes to /import, which asks the system for its type.
 * Several shared files become `/import?uris=[…]`. Every other URL (the app's
 * own scheme, links) passes through.
 */
export function routeForIncomingUrl(path: string): string {
  if (!path) return path;
  const multi = MULTI_IMPORT.exec(path.trim());
  if (multi) {
    const uris = parseIncomingUris(undefined, safeDecode(multi[1]));
    return uris.length ? `${IMPORT_ROUTE}?uris=${encodeURIComponent(JSON.stringify(uris))}` : '/';
  }
  if (isContentUrl(path)) return `${IMPORT_ROUTE}?uri=${encodeURIComponent(path.trim())}`;
  if (!isFileUrl(path)) return path;
  const uri = path.trim();
  if (!importKindOf(uri)) return '/';
  return `${IMPORT_ROUTE}?uri=${encodeURIComponent(uri)}`;
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
