// __tests__/auto-name.test.ts
import { autoName, cleanDisplayName, safeFileName, titleFromText } from '../lib/auto-name';

describe('autoName', () => {
  const date = new Date(2026, 10, 18, 0, 35); // Nov 18 2026, 00:35

  test('reads like a date in the device locale (en-US), time with a colon like the rest of the app', () => {
    expect(autoName(date, 'Scan', 'en-US')).toMatch(/^Scan Nov 18, 2026 at 12:35\sAM$/);
  });

  test('follows a 24-hour locale and drops the English "at" elsewhere', () => {
    expect(autoName(date, 'Scan', 'en-GB')).toBe('Scan 18 Nov 2026 at 00:35');
    expect(autoName(date, 'Scan', 'de-DE')).toBe('Scan 18. Nov. 2026 00:35');
  });

  test('becomes a valid file name only when exported', () => {
    for (const locale of ['en-US', 'en-GB', 'fr-FR', 'de-DE', 'ja-JP', 'ar']) {
      expect(safeFileName(autoName(date, 'Scan', locale))).not.toMatch(/[\\/:*?"<>|]/);
    }
    expect(safeFileName(autoName(date, 'Scan', 'en-GB'))).toBe('Scan 18 Nov 2026 at 00.35');
  });

  test('uses the prefix, falling back to Scan when it is blank', () => {
    expect(autoName(date, 'Receipt', 'en-US').startsWith('Receipt ')).toBe(true);
    expect(autoName(date, '   ', 'en-US').startsWith('Scan ')).toBe(true);
  });

  test('defaults to now in the device locale', () => {
    expect(autoName()).toMatch(/^Scan \S.*\d/);
  });
});

describe('titleFromText', () => {
  test('takes the first strong line', () => {
    expect(titleFromText('INVOICE #2026-0417\nAcme Supplies LLC\nTotal $120.00')).toBe('Invoice #2026-0417');
    expect(titleFromText('Residential Lease Agreement\nThis lease is made…')).toBe('Residential Lease Agreement');
  });

  test('skips junk, short fragments, dates, phones, web addresses and page markers', () => {
    const text = [
      '12/03/2026',
      'Nov 18, 2026',
      'p. 1',
      'Page 1 of 2',
      'Tel: +1 (555) 010-2030',
      'www.acme-supplies.com',
      'hello@acme.com',
      '##',
      'ok',
      'Payment Receipt',
    ].join('\n');
    expect(titleFromText(text)).toBe('Payment Receipt');
  });

  test('keeps short all-caps words (acronyms) and tames long shouting ones', () => {
    expect(titleFromText('ACME LLC STATEMENT')).toBe('Acme LLC Statement');
  });

  test('caps the length at a word boundary', () => {
    const title = titleFromText('Notice of Annual General Meeting of the Shareholders of Example Holdings');
    expect(title!.length).toBeLessThanOrEqual(40);
    expect(title).toBe('Notice of Annual General Meeting of the');
  });

  test('keeps ordinary punctuation (file names are made safe only on export)', () => {
    expect(titleFromText('Report: Q3/Q4 "Final"')).toBe('Report: Q3/Q4 "Final"');
    expect(titleFromText('Statement\tfor\u0007 March')).toBe('Statement for March');
  });

  test('returns null when nothing reads like a title', () => {
    expect(titleFromText('')).toBeNull();
    expect(titleFromText('123 456\n$ 12.00\n—')).toBeNull();
    expect(titleFromText(undefined)).toBeNull();
  });
});

test('safeFileName', () => {
  expect(safeFileName(' a/b:c  d ')).toBe('a b c d');
  expect(safeFileName('Scan 18 Nov 2026 at 01:37')).toBe('Scan 18 Nov 2026 at 01.37');
});

test('cleanDisplayName keeps colons and slashes, drops control characters', () => {
  expect(cleanDisplayName(' Scan 18/11/2026 at 01:37\n')).toBe('Scan 18/11/2026 at 01:37');
});
