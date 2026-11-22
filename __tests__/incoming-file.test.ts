import {
  displayNameOf,
  documentNameFor,
  importKindOf,
  isFileUrl,
  isOwnContentUrl,
  isOwnFileUrl,
  isTrustedImportRoute,
  routeForIncomingUrl,
} from '../lib/incoming-file';
import { redirectSystemPath } from '../app/+native-intent';

/** The params of an /import route, and whether it carries this runtime's secret. */
function params(route: string) {
  expect(route.startsWith('/import?')).toBe(true);
  const q = new URLSearchParams(route.split('?')[1]);
  return { uri: q.get('uri'), uris: q.get('uris'), trusted: isTrustedImportRoute(q.get('via')) };
}

const INBOX = 'file:///private/var/mobile/Containers/Data/Application/ABC/Documents/Inbox';

describe('importKindOf', () => {
  test('MIME type wins', () => {
    expect(importKindOf('file:///x/blob', 'application/pdf')).toBe('pdf');
    expect(importKindOf('file:///x/blob', 'image/heic')).toBe('image');
    expect(importKindOf('file:///x/a.pdf', 'image/png')).toBe('image');
  });
  test('falls back to the extension, case-insensitively', () => {
    expect(importKindOf(`${INBOX}/Invoice.PDF`)).toBe('pdf');
    expect(importKindOf(`${INBOX}/IMG_0001.HEIC`)).toBe('image');
    expect(importKindOf(`${INBOX}/photo.jpeg`)).toBe('image');
    expect(importKindOf(`${INBOX}/scan.png?v=3`)).toBe('image');
  });
  test('decodes escaped names', () => {
    expect(importKindOf(`${INBOX}/My%20Lease%20(1).pdf`)).toBe('pdf');
  });
  test('anything else is not importable', () => {
    expect(importKindOf(`${INBOX}/notes.txt`)).toBeNull();
    expect(importKindOf(`${INBOX}/archive.zip`)).toBeNull();
    expect(importKindOf(`${INBOX}/bad%E0%A4%A.pdf`)).toBe('pdf'); // malformed escape still judged by name
  });
});

describe('routeForIncomingUrl (Open in Scan Kit)', () => {
  test('a shared PDF or image goes to /import with the file URL', () => {
    const url = `${INBOX}/Invoice%202026.pdf`;
    expect(params(routeForIncomingUrl(url))).toEqual({ uri: url, uris: null, trusted: true });
    const img = `${INBOX}/IMG_0042.jpg`;
    expect(params(routeForIncomingUrl(img))).toEqual({ uri: img, uris: null, trusted: true });
  });
  test('the uri survives a round trip through the query string', () => {
    // iOS percent-encodes the name, so '&', '#' and spaces arrive escaped.
    const url = `${INBOX}/A%20%26%20B%20%232.pdf`;
    const route = routeForIncomingUrl(url);
    const param = new URLSearchParams(route.split('?')[1]).get('uri');
    expect(param).toBe(url);
  });
  test('an unsupported file goes Home', () => {
    expect(routeForIncomingUrl(`${INBOX}/notes.txt`)).toBe('/');
  });
  test('app links and paths pass through untouched', () => {
    expect(routeForIncomingUrl('scankit://viewer?id=1')).toBe('scankit://viewer?id=1');
    expect(routeForIncomingUrl('/files')).toBe('/files');
    expect(routeForIncomingUrl('')).toBe('');
  });
  test('+native-intent uses the mapping and never throws', () => {
    expect(params(redirectSystemPath({ path: `${INBOX}/x.pdf`, initial: true })).trusted).toBe(true);
    expect(redirectSystemPath({ path: '/settings/about', initial: false })).toBe('/settings/about');
    expect(redirectSystemPath({ path: undefined as unknown as string, initial: false })).toBeUndefined();
  });
});

describe('names', () => {
  test('isFileUrl', () => {
    expect(isFileUrl('file:///a.pdf')).toBe(true);
    expect(isFileUrl(' FILE:///a.pdf')).toBe(true);
    expect(isFileUrl('https://example.com/a.pdf')).toBe(false);
  });
  test('displayNameOf / documentNameFor', () => {
    expect(displayNameOf(`${INBOX}/My%20Lease.pdf`)).toBe('My Lease.pdf');
    expect(documentNameFor(`${INBOX}/My%20Lease.pdf`)).toBe('My Lease');
    expect(documentNameFor(`${INBOX}/IMG_0042.HEIC`)).toBe('IMG_0042');
    expect(documentNameFor('file:///')).toBeNull();
  });
});

describe('Android: content:// and several shared files', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const inc = require('../lib/incoming-file') as typeof import('../lib/incoming-file');
  const C1 = 'content://com.android.providers.media.documents/document/image%3A1000000034';
  const C2 = 'content://com.google.android.apps.photos.contentprovider/0/1/mediakey%3A%2Flocal/ORIGINAL/NONE/2';

  test('a content URL always goes to /import (its type is asked for there)', () => {
    expect(params(routeForIncomingUrl(C1))).toEqual({ uri: C1, uris: null, trusted: true });
    expect(params(routeForIncomingUrl(C2)).uri).toBe(C2);
  });

  test('several shared files become /import?uris=[…]', () => {
    const ctx = { shareKey: 'k3y', fileUrls: false };
    const native = `scankit://import?uris=${encodeURIComponent(JSON.stringify([C1, C2]))}&k=k3y`;
    const route = params(routeForIncomingUrl(native, ctx));
    expect(route.trusted).toBe(true);
    expect(inc.parseIncomingUris(undefined, route.uris)).toEqual([C1, C2]);
    expect(routeForIncomingUrl('scankit://import?uris=%5B%5D&k=k3y', ctx)).toBe('/');
    expect(routeForIncomingUrl('scankit://import?uris=not-json&k=k3y', ctx)).toBe('/');
  });

  test('parseIncomingUris keeps file and content URLs only, without duplicates', () => {
    expect(inc.parseIncomingUris(C1, null)).toEqual([C1]);
    expect(inc.parseIncomingUris(null, JSON.stringify([C1, 'https://x.example/a.pdf', C1, 3, `${INBOX}/a.pdf`]))).toEqual([C1, `${INBOX}/a.pdf`]);
    expect(inc.parseIncomingUris(undefined, undefined)).toEqual([]);
  });

  test('planIncomingImport: images together, else the first PDF', () => {
    expect(inc.planIncomingImport([
      { uri: 'a', kind: 'image' }, { uri: 'b', kind: 'pdf' }, { uri: 'c', kind: 'image' }, { uri: 'd', kind: null },
    ])).toEqual({ kind: 'image', uris: ['a', 'c'] });
    expect(inc.planIncomingImport([{ uri: 'x', kind: null }, { uri: 'p', kind: 'pdf' }, { uri: 'q', kind: 'pdf' }]))
      .toEqual({ kind: 'pdf', uris: ['p'] });
    expect(inc.planIncomingImport([{ uri: 'x', kind: null }])).toBeNull();
  });

  test('a content URL is classified by the name and type the system reports', () => {
    expect(importKindOf('Invoice.pdf', null)).toBe('pdf');
    expect(importKindOf('IMG_1.jpg', 'image/jpeg')).toBe('image');
    expect(inc.documentNameFromFileName('Lease 2026.pdf')).toBe('Lease 2026');
    expect(inc.documentNameFromFileName(null)).toBeNull();
    expect(inc.isContentUrl(C1)).toBe(true);
    expect(inc.isContentUrl(`${INBOX}/a.pdf`)).toBe(false);
  });
});

describe('only files the user handed over are imported (review M7)', () => {
  const ROOT = 'file:///var/mobile/Containers/Data/Application/ABC/';
  const PKG = 'com.sixyato9.scankit';
  const C1 = 'content://com.android.providers.media.documents/document/image%3A1000000034';
  const own = `${ROOT}Documents/doc-1/document.pdf`;
  const ios = { fileUrls: true, isOwn: (u: string) => isOwnFileUrl(u, ROOT) };
  const android = { shareKey: 'secret', fileUrls: false, isOwn: (u: string) => isOwnContentUrl(u, PKG) };

  test('iOS: the container is off limits except the Inbox copies "Open in" makes', () => {
    expect(isOwnFileUrl(own, ROOT)).toBe(true);
    expect(isOwnFileUrl(`${ROOT}Library/Caches/pdf-session/x.pdf`, ROOT)).toBe(true);
    expect(isOwnFileUrl(`${ROOT}Documents/Inbox/Invoice.pdf`, ROOT)).toBe(false);
    expect(isOwnFileUrl(`${INBOX}/Invoice%202026.pdf`, ROOT)).toBe(false); // the /private/var spelling
    expect(isOwnFileUrl(`${ROOT}tmp/com.6yato9.scan-kit-Inbox/a.pdf`, ROOT)).toBe(false);
    // Tricks that still point inside: a nested Inbox path, dot segments, escapes.
    expect(isOwnFileUrl(`${ROOT}Documents/Inbox/../doc-1/document.pdf`, ROOT)).toBe(true);
    expect(isOwnFileUrl(`${ROOT}Documents/Inbox/sub/a.pdf`, ROOT)).toBe(true);
    expect(isOwnFileUrl(`${ROOT}Documents/Inbox/%2E%2E/doc-1/document.pdf`, ROOT)).toBe(true);
    expect(isOwnFileUrl(`${ROOT}Documents//doc-1/./document.pdf`, ROOT)).toBe(true);
    expect(isOwnFileUrl('file:///private/var/mobile/Containers/Data/Application/ABC/Documents/doc-1/document.pdf', ROOT)).toBe(true);
    // Another app's file (open in place, iCloud Drive) is not ours.
    expect(isOwnFileUrl('file:///private/var/mobile/Library/Mobile%20Documents/com~apple~CloudDocs/a.pdf', ROOT)).toBe(false);
    expect(isOwnFileUrl('file:///var/mobile/Containers/Data/Application/XYZ/Documents/a.pdf', ROOT)).toBe(false);
    expect(routeForIncomingUrl(own, ios)).toBe('/');
    expect(params(routeForIncomingUrl(`${ROOT}Documents/Inbox/Invoice.pdf`, ios)).trusted).toBe(true);
  });

  test('Android: file:// URLs and our own providers are refused; other apps\' content is imported', () => {
    expect(isOwnContentUrl(`content://${PKG}.visionocr.fileprovider/cache/a.pdf`, PKG)).toBe(true);
    expect(isOwnContentUrl(`content://${PKG}.FileSystemFileProvider/a.pdf`, PKG)).toBe(true);
    expect(isOwnContentUrl(`content://${PKG}/a.pdf`, PKG)).toBe(true);
    expect(isOwnContentUrl(`content://${PKG}x.provider/a.pdf`, PKG)).toBe(false);
    expect(isOwnContentUrl(C1, PKG)).toBe(false);
    expect(routeForIncomingUrl(`content://${PKG}.visionocr.fileprovider/cache/a.pdf`, android)).toBe('/');
    expect(routeForIncomingUrl('file:///data/user/0/com.sixyato9.scankit/files/doc-1/document.pdf', android)).toBe('/');
    expect(params(routeForIncomingUrl(C1, android)).trusted).toBe(true);
  });

  test('the multi-file link needs the key the share rewrite put on it', () => {
    const list = encodeURIComponent(JSON.stringify([C1]));
    expect(params(routeForIncomingUrl(`scankit://import?uris=${list}&k=secret`, android)).uris).toBe(JSON.stringify([C1]));
    expect(routeForIncomingUrl(`scankit://import?uris=${list}`, android)).toBe('/');
    expect(routeForIncomingUrl(`scankit://import?uris=${list}&k=guess`, android)).toBe('/');
    // iOS never makes it: always refused there.
    expect(routeForIncomingUrl(`scankit://import?uris=${list}&k=secret`, ios)).toBe('/');
    // Our own files inside an accepted list are dropped.
    const mixed = encodeURIComponent(JSON.stringify([C1, `content://${PKG}.visionocr.fileprovider/x.pdf`, 'file:///data/user/0/x.pdf']));
    expect(params(routeForIncomingUrl(`scankit://import?uris=${mixed}&k=secret`, android)).uris).toBe(JSON.stringify([C1]));
  });

  test('a link aimed at /import from outside goes Home, and carries no secret', () => {
    const target = encodeURIComponent(own);
    for (const link of [
      `scankit://import?uri=${target}`,
      `scankit:///import?uri=${target}`,
      `scankit://import/?uri=${target}`,
      `SCANKIT://IMPORT?uri=${target}`,
      `/import?uri=${target}`,
      `import?uri=${target}`,
      `scankit:///--/import?uri=${target}`,
      `scankit://import?k=secret&uris=${encodeURIComponent(JSON.stringify([C1]))}`,
      `scankit://import?uri=${target}&via=guess`,
    ]) {
      expect(routeForIncomingUrl(link, ios)).toBe('/');
      expect(routeForIncomingUrl(link, android)).toBe('/');
    }
    expect(isTrustedImportRoute('guess')).toBe(false);
    expect(isTrustedImportRoute(undefined)).toBe(false);
    expect(isTrustedImportRoute(['x'])).toBe(false);
    // The app's other links still pass through.
    expect(routeForIncomingUrl('scankit://viewer?id=1', ios)).toBe('scankit://viewer?id=1');
    expect(routeForIncomingUrl('scankit://importer', ios)).toBe('scankit://importer');
  });
});
