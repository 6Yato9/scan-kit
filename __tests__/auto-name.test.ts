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

  test('tames shouting words in mixed-case lines too, keeping acronyms and codes', () => {
    const cases: [string, string][] = [
      ['Northwind INVOICE #4471', 'Northwind Invoice #4471'],
      ['ACME LLC STATEMENT', 'Acme LLC Statement'],
      ['UK VAT RETURN', 'UK VAT Return'],
      ['Order AB-2209 CONFIRMED', 'Order AB-2209 Confirmed'],
      ['HSBC Bank STATEMENT', 'HSBC Bank Statement'],
      ['NOTICE OF ANNUAL GENERAL MEETING', 'Notice of Annual General Meeting'],
      ['W-2 WAGE AND TAX STATEMENT', 'W-2 Wage and Tax Statement'],
      ['IKEA Receipt', 'IKEA Receipt'],
      ['NASA Contract SUMMARY', 'NASA Contract Summary'],
      ['Quote QT2026A for Harbor Bakery', 'Quote QT2026A for Harbor Bakery'],
      ['Tesco RECEIPT - VAT No. GB220430231', 'Tesco Receipt - VAT No. GB220430231'],
      ['IBAN Transfer CONFIRMATION', 'IBAN Transfer Confirmation'],
      ['Report: Q3/Q4 SUMMARY', 'Report: Q3/Q4 Summary'],
      ['DON\'T FORGET: Dentist', 'Don\'t Forget: Dentist'],
      ['ÉTAT DES LIEUX', 'État des Lieux'],
      ['Residential Lease Agreement', 'Residential Lease Agreement'],
    ];
    for (const [text, want] of cases) expect([text, titleFromText(text)]).toEqual([text, want]);
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
