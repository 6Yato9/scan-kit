// __tests__/new-doc-note.test.ts
// The viewer's greeting for a document just created: "Saved as …" or, when
// auto-crop found no page edges in an imported photo, which page to crop.
import {
  noteNewDocument,
  resetNewDocNotesForTests,
  takeNewDocumentNote,
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
    expect(uncroppedMessage([0], 1)).toBe('Couldn’t find the page edges');
  });
  test('one page of several: names it (1-based)', () => {
    expect(uncroppedMessage([2], 4)).toBe('Couldn’t find the edges of page 3');
  });
  test('several pages: counts them', () => {
    expect(uncroppedMessage([0, 3], 4)).toBe('Couldn’t find the edges of 2 pages');
  });
});
