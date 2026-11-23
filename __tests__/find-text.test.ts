// lib/find-text.ts: what Find text says once a search has finished.
import { foundSummary, pageList } from '../lib/find-text';

describe('pageList', () => {
  it('reads page numbers out, one-based', () => {
    expect(pageList([0])).toBe('1');
    expect(pageList([0, 2])).toBe('1 and 3');
    expect(pageList([0, 2, 3])).toBe('1, 3 and 4');
    expect(pageList([0, 2, 3, 5])).toBe('1, 3, 4 and 6');
  });

  it('shortens a long list', () => {
    expect(pageList([0, 2, 3, 5, 8])).toBe('1, 3, 4 and 2 more');
  });
});

describe('foundSummary', () => {
  it('says when nothing matched', () => {
    expect(foundSummary('  Fox ', [0, 0])).toBe('No matches for “Fox”');
  });

  it('counts matches, and on several pages says which', () => {
    expect(foundSummary('fox', [3])).toBe('3 matches for “fox”');
    expect(foundSummary('fox', [1])).toBe('1 match for “fox”');
    expect(foundSummary('fox', [0, 2, 0])).toBe('2 matches for “fox”, on page 2');
    expect(foundSummary('fox', [1, 0, 4])).toBe('5 matches for “fox”, on pages 1 and 3');
  });
});
