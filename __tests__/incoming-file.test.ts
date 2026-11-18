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
