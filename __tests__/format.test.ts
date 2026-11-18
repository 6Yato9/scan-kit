import { formatDate, formatDateTime, formatDocDate, formatPageCount, formatTime } from '../lib/format';
import { matchesQuery, sortDocuments } from '../lib/doc-list';

const now = new Date(2026, 10, 17, 15, 0);

test('formatDocDate: today, yesterday, older', () => {
  expect(formatDocDate(new Date(2026, 10, 17, 9, 5).getTime(), now, 'en-US')).toMatch(/^Today, 9:05\sAM$/);
  expect(formatDocDate(new Date(2026, 10, 16, 23, 0).getTime(), now, 'en-US')).toBe('Yesterday');
  expect(formatDocDate(new Date(2026, 3, 10).getTime(), now, 'en-US')).toBe('Apr 10, 2026');
});

test('formatting follows the locale, including its 24-hour clock', () => {
  const t = new Date(2026, 10, 17, 21, 5).getTime();
  expect(formatTime(t, 'en-GB')).toBe('21:05');
  expect(formatTime(t, 'en-US')).toMatch(/^9:05\sPM$/);
  expect(formatDate(t, 'en-GB')).toBe('17 Nov 2026');
  expect(formatDocDate(t, now, 'en-GB')).toBe('Today, 21:05');
  expect(formatDateTime(t, 'en-US')).toMatch(/^Nov 17, 2026, 9:05\sPM$/);
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
