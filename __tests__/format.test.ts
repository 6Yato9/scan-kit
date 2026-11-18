import { formatDocDate, formatPageCount } from '../lib/format';
import { matchesQuery, sortDocuments } from '../lib/doc-list';

const now = new Date(2026, 10, 17, 15, 0);

test('formatDocDate: today, yesterday, older', () => {
  expect(formatDocDate(new Date(2026, 10, 17, 9, 5).getTime(), now)).toMatch(/^Today, 9:05\sAM$/);
  expect(formatDocDate(new Date(2026, 10, 16, 23, 0).getTime(), now)).toBe('Yesterday');
  expect(formatDocDate(new Date(2026, 3, 10).getTime(), now)).toBe('Apr 10, 2026');
});

test('formatPageCount', () => {
  expect(formatPageCount({ pages: ['a'] })).toBe('1 page');
  expect(formatPageCount({ pages: ['a', 'b'] })).toBe('2 pages');
  expect(formatPageCount({ pages: [], pdfUri: 'x' })).toBe('PDF');
});

test('sortDocuments and matchesQuery', () => {
  const docs = [
    { id: '1', name: 'Beta', pages: [], createdAt: 1, updatedAt: 9 },
    { id: '2', name: 'alpha', pages: [], createdAt: 2, updatedAt: 1, ocrText: 'Invoice total' },
  ];
  expect(sortDocuments(docs, 'nameAZ').map(d => d.id)).toEqual(['2', '1']);
  expect(sortDocuments(docs, 'dateAdded').map(d => d.id)).toEqual(['2', '1']);
  expect(sortDocuments(docs, 'dateModified').map(d => d.id)).toEqual(['1', '2']);
  expect(matchesQuery(docs[1], 'invoice')).toBe(true);
  expect(matchesQuery(docs[0], 'invoice')).toBe(false);
});
