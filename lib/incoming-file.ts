// lib/incoming-file.ts
// "Open in Scan Kit": iOS hands the app a file:// URL when the user shares a
// PDF or an image to it from Mail, Files, Safari… (app.json registers the
// document types). These helpers decide what that URL is and where it goes.
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

/** The in-app route that imports a file and opens it. */
export const IMPORT_ROUTE = '/import';

/**
 * expo-router's `redirectSystemPath` mapping: a file URL for a PDF or an image
 * becomes `/import?uri=…`; a file of any other type goes Home (nothing to
 * import); every other URL (the app's own scheme, links) passes through.
 */
export function routeForIncomingUrl(path: string): string {
  if (!path || !isFileUrl(path)) return path;
  const uri = path.trim();
  if (!importKindOf(uri)) return '/';
  return `${IMPORT_ROUTE}?uri=${encodeURIComponent(uri)}`;
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
  const base = name.replace(/\.[a-z0-9]{1,5}$/i, '').trim();
  return base || null;
}
