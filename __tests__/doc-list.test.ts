import { compactMeta, matchesQuery, searchSnippet } from '../lib/doc-list';

const doc = (name: string, ocrText?: string): any => ({ id: 'x', name, pages: [], ocrText, createdAt: 1, updatedAt: 1 });

describe('matchesQuery', () => {
  test('matches name or text, ignoring case and accents', () => {
    expect(matchesQuery(doc('Café receipt'), 'cafe')).toBe(true);
    expect(matchesQuery(doc('Scan', 'Rent is due on the 1st'), 'RENT')).toBe(true);
    expect(matchesQuery(doc('Scan', 'nothing here'), 'rent')).toBe(false);
  });
});

describe('searchSnippet', () => {
  const lease = doc('Scan 18 Nov', 'LEASE AGREEMENT\nTenant: Jane Doe\nMonthly rent: $1,450 payable on the 1st');

  test('returns the line that matched the text', () => {
    expect(searchSnippet(lease, 'rent')).toBe('Monthly rent: $1,450 payable on the 1st');
    expect(searchSnippet(lease, 'jane')).toBe('Tenant: Jane Doe');
  });

  test('nothing when the name explains the match, or nothing matched', () => {
    expect(searchSnippet(doc('Rent receipt', 'rent paid'), 'rent')).toBeUndefined();
    expect(searchSnippet(lease, 'invoice')).toBeUndefined();
    expect(searchSnippet(doc('Scan'), 'rent')).toBeUndefined();
    expect(searchSnippet(lease, '  ')).toBeUndefined();
  });

  test('accent-insensitive, keeps the original spelling', () => {
    expect(searchSnippet(doc('Scan', 'Résumé of the café'), 'resume')).toBe('Résumé of the café');
  });

  test('a long line is windowed around the hit without cutting words', () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`);
    words.splice(25, 0, 'NEEDLE');
    const s = searchSnippet(doc('Scan', words.join(' ')), 'needle', 60)!;
    expect(s).toContain('NEEDLE');
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(62);
    // Every word in the window is whole.
    for (const w of s.replace(/…/g, '').trim().split(' ')) expect(words).toContain(w);
  });
});

describe('compactMeta', () => {
  const now = new Date(2026, 10, 18, 12, 0);
  test('today, yesterday, this year, older', () => {
    expect(compactMeta({ pages: ['a', 'b'], updatedAt: new Date(2026, 10, 18, 1).getTime() }, now)).toBe('2 pages, Today');
    expect(compactMeta({ pages: [], pdfUri: 'x', updatedAt: new Date(2026, 10, 17, 23).getTime() }, now)).toBe('PDF, Yesterday');
    expect(compactMeta({ pages: ['a'], updatedAt: new Date(2026, 2, 3).getTime() }, now, 'en-US')).toBe('1 page, Mar 3');
    expect(compactMeta({ pages: ['a'], updatedAt: new Date(2024, 2, 3).getTime() }, now, 'en-US')).toBe('1 page, Mar 2024');
  });
});
