import {
  displayNameOf,
  documentNameFor,
  importKindOf,
  isFileUrl,
  routeForIncomingUrl,
} from '../lib/incoming-file';
import { redirectSystemPath } from '../app/+native-intent';

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
    expect(routeForIncomingUrl(url)).toBe(`/import?uri=${encodeURIComponent(url)}`);
    const img = `${INBOX}/IMG_0042.jpg`;
    expect(routeForIncomingUrl(img)).toBe(`/import?uri=${encodeURIComponent(img)}`);
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
    expect(redirectSystemPath({ path: `${INBOX}/x.pdf`, initial: true })).toMatch(/^\/import\?uri=/);
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
    expect(routeForIncomingUrl(C1)).toBe(`/import?uri=${encodeURIComponent(C1)}`);
    expect(new URLSearchParams(routeForIncomingUrl(C2).split('?')[1]).get('uri')).toBe(C2);
  });

  test('several shared files become /import?uris=[…]', () => {
    const native = `scankit://import?uris=${encodeURIComponent(JSON.stringify([C1, C2]))}`;
    const route = routeForIncomingUrl(native);
    expect(route.startsWith('/import?uris=')).toBe(true);
    const uris = new URLSearchParams(route.split('?')[1]).get('uris');
    expect(inc.parseIncomingUris(undefined, uris)).toEqual([C1, C2]);
    expect(routeForIncomingUrl('scankit://import?uris=%5B%5D')).toBe('/');
    expect(routeForIncomingUrl('scankit://import?uris=not-json')).toBe('/');
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
