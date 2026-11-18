// __tests__/new-doc-note.test.ts
// The viewer's greeting for a document just created: "Saved as …" or, when
// auto-crop found no page edges in an imported photo, which page to crop.
import {
  noteNewDocument,
  resetNewDocNotesForTests,
  takeNewDocumentNote,
  looksLikeFlatPage,
  uncroppedMessage,
} from '../lib/new-doc-note';

beforeEach(() => resetNewDocNotesForTests());

describe('new document notes', () => {
  test('a note is taken once', () => {
    noteNewDocument('a');
    expect(takeNewDocumentNote('a')).toEqual({ uncropped: [] });
    expect(takeNewDocumentNote('a')).toBeNull();
  });

  test('no note for a document nobody created here', () => {
    expect(takeNewDocumentNote('never')).toBeNull();
  });

  test('uncropped pages are kept sorted and merged across calls', () => {
    noteNewDocument('a', { uncropped: [2] }, 1000);
    noteNewDocument('a', { uncropped: [0, 2] }, 1000);
    expect(takeNewDocumentNote('a', 1000)).toEqual({ uncropped: [0, 2] });
  });

  test('a stale note is dropped, so a document opened much later is not greeted', () => {
    noteNewDocument('a', {}, 0);
    expect(takeNewDocumentNote('a', 61_000)).toBeNull();
  });

  test('an empty id is ignored', () => {
    noteNewDocument('');
    expect(takeNewDocumentNote('')).toBeNull();
  });
});

describe('uncroppedMessage', () => {
  test('a one-page document: no page number', () => {
    expect(uncroppedMessage([0], 1)).toBe('No page edges found. Kept the whole photo.');
  });
  test('one page of several: names it (1-based)', () => {
    expect(uncroppedMessage([2], 4)).toBe('No page edges found on page 3. Kept it whole.');
  });
  test('several pages: counts them', () => {
    expect(uncroppedMessage([0, 3], 4)).toBe('No page edges found on 2 pages. Kept them whole.');
  });
});

describe('looksLikeFlatPage', () => {
  test('page-shaped images (already flat) are not misses', () => {
    expect(looksLikeFlatPage(2480, 3508)).toBe(true); // A4 at 300 dpi
    expect(looksLikeFlatPage(3508, 2480)).toBe(true); // landscape A4
    expect(looksLikeFlatPage(2550, 3300)).toBe(true); // US Letter
    expect(looksLikeFlatPage(2550, 4200)).toBe(true); // US Legal
  });
  test('camera photos and screenshots are not page-shaped', () => {
    expect(looksLikeFlatPage(3024, 4032)).toBe(false); // 4:3
    expect(looksLikeFlatPage(4000, 6000)).toBe(false); // 3:2
    expect(looksLikeFlatPage(1080, 1920)).toBe(false); // 16:9
    expect(looksLikeFlatPage(1206, 2622)).toBe(false); // phone screenshot
    expect(looksLikeFlatPage(0, 100)).toBe(false);
  });
});
