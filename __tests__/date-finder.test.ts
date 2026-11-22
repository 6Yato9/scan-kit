// lib/date-finder: dates for the calendar chip on Android (and builds without
// NSDataDetector). Every date it reports must survive checkDetections (its
// day is written in its words).
import { findDates, withDates } from '../lib/date-finder';
import { checkDetections, detectDataFallback, eventFromDate, withSpacedEmails } from '../lib/text-actions';
import type { DetectedData } from '../modules/vision-ocr/src';

jest.mock('../modules/vision-ocr/src', () => ({ VisionOcr: null }));
jest.mock('expo-web-browser', () => ({}));

const now = new Date(2026, 10, 22, 9, 0); // 22 Nov 2026
const find = (t: string, monthFirst = false) => findDates(t, { now, monthFirst });
const one = (t: string, monthFirst = false) => {
  const r = find(t, monthFirst);
  expect(r).toHaveLength(1);
  return r[0];
};
const local = (d: DetectedData) => {
  const x = new Date(d.date!);
  return [x.getFullYear(), x.getMonth() + 1, x.getDate(), d.hasTime ? x.getHours() : null, d.hasTime ? x.getMinutes() : null];
};

describe('findDates', () => {
  it('reads English dates with weekday and time', () => {
    const text = 'This letter confirms your next check-up appointment on Thursday, March 12, 2026 at 10:30 AM. Please arrive early.';
    const d = one(text);
    expect(d.text).toBe('Thursday, March 12, 2026 at 10:30 AM');
    expect(local(d)).toEqual([2026, 3, 12, 10, 30]);
    expect(text.slice(d.range[0], d.range[0] + d.range[1])).toBe(d.text);
    expect(eventFromDate(d, text)?.title).toBe('This letter confirms your next check-up appointment');
    expect(local(one('Due 30th November 2026'))).toEqual([2026, 11, 30, null, null]);
    expect(local(one('the 12th of March, 2027 at 3 pm'))).toEqual([2027, 3, 12, 15, 0]);
  });

  it('reads French, German, Spanish, Italian, Dutch and Portuguese', () => {
    expect(local(one('Rendez-vous le jeudi 3 avril 2026 à 14h30.'))).toEqual([2026, 4, 3, 14, 30]);
    expect(local(one('le 1er mai 2027'))).toEqual([2027, 5, 1, null, null]);
    expect(local(one('Termin am 12. März 2026 um 9 Uhr'))).toEqual([2026, 3, 12, 9, 0]);
    expect(local(one('el 5 de enero de 2027'))).toEqual([2027, 1, 5, null, null]);
    expect(local(one('il 7 settembre 2026'))).toEqual([2026, 9, 7, null, null]);
    expect(local(one('op 14 februari 2027'))).toEqual([2027, 2, 14, null, null]);
    expect(local(one('em 9 de março de 2027'))).toEqual([2027, 3, 9, null, null]);
  });

  it('reads numeric dates by locale unless a part settles it', () => {
    expect(local(one('Invoice date: 12/03/2026'))).toEqual([2026, 3, 12, null, null]);
    expect(local(one('Invoice date: 12/03/2026', true))).toEqual([2026, 12, 3, null, null]);
    expect(local(one('31/01/2026', true))).toEqual([2026, 1, 31, null, null]);
    expect(local(one('01/31/2026'))).toEqual([2026, 1, 31, null, null]);
    expect(local(one('Datum: 12.03.26 14:00'))).toEqual([2026, 3, 12, 14, 0]);
    expect(local(one('Issued 2026-03-12.'))).toEqual([2026, 3, 12, null, null]);
  });

  it('reads time ranges as a duration', () => {
    const d = one('Workshop on 4 December 2026, 10:00–11:30');
    expect(local(d)).toEqual([2026, 12, 4, 10, 0]);
    expect(d.duration).toBe(90 * 60);
    expect(one('Friday 4 December 2026 from 9 am to 5 pm').duration).toBe(8 * 3600);
    expect(one('4 December 2026 noon').hasTime).toBe(true);
  });

  it('puts a date without a year at its next occurrence from a month ago', () => {
    expect(local(one('Meeting on 12 March'))).toEqual([2027, 3, 12, null, null]);
    expect(local(one('Paid on 10 November'))).toEqual([2026, 11, 10, null, null]);
  });

  it('finds no date where none is written', () => {
    for (const t of [
      'Call 06 12 34 56 78 or +33 6 12 34 56 78',
      'Mars et Marseille',
      'Open Monday to Friday, 9:00 to 17:00',
      'Version 1.2.3, order 12.345.678',
      '31/02/2026',
      '2026 March sales: 1 234 units',
    ]) {
      expect([t, find(t)]).toEqual([t, []]);
    }
  });

  it('only reports dates checkDetections keeps', () => {
    const text = 'Sent 3 Feb 2026. Reply by Monday, 9 March 2026 at 17:00 or before 30/11/2026.';
    const dates = find(text);
    expect(dates.map(d => d.text)).toEqual(['3 Feb 2026', 'Monday, 9 March 2026 at 17:00', '30/11/2026']);
    expect(checkDetections(dates, text)).toHaveLength(3);
  });
});

describe('withDates', () => {
  it('adds dates to other detections; a date-shaped phone gives way', () => {
    const text = 'Call +1 415 555 0132 by 12.03.2026';
    const found = [...detectDataFallback(text), { type: 'phone' as const, text: '12.03.2026', range: [24, 10] as [number, number], value: '12.03.2026' }];
    const out = withDates(found, text, { now });
    expect(out.map(d => d.type)).toEqual(['phone', 'date']);
    expect(out[1].text).toBe('12.03.2026');
  });

  it('drops a date overlapping something else found', () => {
    const text = 'see https://x.io/12-03-2026';
    const out = withDates(detectDataFallback(text), text, { now });
    expect(out.map(d => d.type)).toEqual(['url']);
  });
});

describe('withSpacedEmails', () => {
  it('reads an address with a space beside the @ as an email, not a link to the domain', () => {
    const text = 'Sarah\nsarah @acme.com\nwww.acme.com\nbob@ example.org';
    const found = detectDataFallback(text);
    const out = withSpacedEmails(found, text);
    expect(out.map(d => [d.type, d.value])).toEqual([
      ['email', 'sarah@acme.com'],
      ['url', 'http://www.acme.com'],
      ['email', 'bob@example.org'],
    ]);
    expect(withSpacedEmails(found.slice(0, 0), 'mail a@b.co')).toEqual([]);
  });
});
