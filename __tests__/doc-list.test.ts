import { compactMeta, matchesQuery, recoveredLabels, searchSnippet, windowAround } from '../lib/doc-list';

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

describe('windowAround', () => {
  const line = 'Payment is due within thirty days of the invoice date and late fees apply after that';

  test('keeps the hit whole and near the middle of a narrow window', () => {
    for (const max of [14, 18, 24, 30, 40]) {
      const s = windowAround(line, 'invoice', max);
      expect(s).toContain('invoice');
      expect(Array.from(s).length).toBeLessThanOrEqual(Math.max(max, 'invoice'.length + 2));
      const at = s.indexOf('invoice');
      // Roughly centred: about as much before the hit as after it.
      expect(Math.abs(at - (s.length - at - 'invoice'.length))).toBeLessThanOrEqual(max / 2);
    }
  });

  test('ellipses mark both cut edges, and whole words only', () => {
    const s = windowAround(line, 'invoice', 30);
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    for (const w of s.replace(/…/g, '').trim().split(' ')) expect(line.split(' ')).toContain(w);
  });

  test('a hit inside a word shows the whole word; short text is left alone', () => {
    expect(windowAround(line, 'voic', 20)).toContain('invoice');
    expect(windowAround('Tenant: Jane Doe', 'jane', 40)).toBe('Tenant: Jane Doe');
  });

  test('re-windowing an earlier snippet keeps its outer ellipses', () => {
    const wide = windowAround(line, 'late', 50);
    const narrow = windowAround(wide, 'late', 20);
    expect(narrow).toContain('late');
    expect(narrow.startsWith('…') && narrow.endsWith('…')).toBe(true);
  });

  test('a hit at the very start or end', () => {
    expect(windowAround(line, 'payment', 20).startsWith('Payment')).toBe(true);
    expect(windowAround(line, 'that', 20).endsWith('that')).toBe(true);
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

describe('recoveredLabels', () => {
  test('pages take the title read from their text, the count goes in the detail', () => {
    expect(recoveredLabels({ kind: 'pages', fileCount: 3, textTitle: 'Northwind Invoice #4471' }))
      .toEqual({ title: 'Northwind Invoice #4471', count: '3 pages' });
  });
  test('without text, say what they are', () => {
    expect(recoveredLabels({ kind: 'pages', fileCount: 1 })).toEqual({ title: 'Scanned pages', count: '1 page' });
    expect(recoveredLabels({ kind: 'signatures', fileCount: 2 })).toEqual({ title: 'Saved signatures', count: '2 signatures' });
    expect(recoveredLabels({ kind: 'files', fileCount: 1 })).toEqual({ title: 'Other files', count: '1 file' });
  });
  test('a PDF counts its pages once read', () => {
    expect(recoveredLabels({ kind: 'pdf', fileCount: 1 })).toEqual({ title: 'PDF document', count: 'PDF' });
    expect(recoveredLabels({ kind: 'pdf', fileCount: 1, textTitle: 'Lease', pdfPages: 4 }))
      .toEqual({ title: 'Lease', count: 'PDF, 4 pages' });
  });
});

describe('recoveredLabels for a lone file', () => {
  test('keeps the file\'s original name and says what it is', () => {
    expect(recoveredLabels({ kind: 'files', fileCount: 1, soleFile: 'file:///a/legacy-documents/Lease%20letter.pdf' }))
      .toEqual({ title: 'Lease letter', count: 'PDF' });
    expect(recoveredLabels({ kind: 'files', fileCount: 1, soleFile: 'file:///a/Paperwork%20(signed).pdf', pdfPages: 3 }))
      .toEqual({ title: 'Paperwork (signed)', count: 'PDF, 3 pages' });
    expect(recoveredLabels({ kind: 'files', fileCount: 1, soleFile: 'file:///a/IMG_0042.JPG' }))
      .toEqual({ title: 'IMG_0042', count: 'Image' });
    expect(recoveredLabels({ kind: 'files', fileCount: 1, soleFile: 'file:///a/harness-log.txt' }))
      .toEqual({ title: 'harness-log', count: 'TXT file' });
  });
});
