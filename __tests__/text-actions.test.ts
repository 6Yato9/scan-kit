// Round 12: acting on recognized text — data detection fallback, chips,
// calendar drafts, read-aloud sentences and business card parsing.
import {
  detectDataFallback,
  detectionLabel,
  eventFromDate,
  mapsUrl,
  telUrl,
  tidyDetections,
  webUrl,
  type DetectedData,
} from '@/lib/text-actions';
import { sentenceAt } from '@/lib/sentences';
import { hasReadableText } from '@/lib/read-aloud';
import { businessCardDocName, hasContactData, parseBusinessCard, splitName } from '@/lib/business-card';
import type { OcrLine } from '@/lib/ocr';

describe('detectDataFallback', () => {
  const text =
    'Call (617) 555-0148 or appointments@riversidedental.com.\nSee https://www.riversidedental.com/booking, or www.example.org.\nInvoice 2026-03-12 total 1234';

  it('finds phones, emails and links in reading order', () => {
    const found = detectDataFallback(text);
    expect(found.map(d => d.type)).toEqual(['phone', 'email', 'url', 'url']);
    expect(found[0].value).toBe('(617) 555-0148');
    expect(found[1].value).toBe('appointments@riversidedental.com');
    expect(found[2].value).toBe('https://www.riversidedental.com/booking');
    expect(found[3].value).toBe('http://www.example.org');
  });

  it('keeps ranges that point at the matched text', () => {
    for (const d of detectDataFallback(text)) {
      expect(text.slice(d.range[0], d.range[0] + d.range[1])).toBe(d.text);
    }
  });

  it('does not take an ISO date or a short number for a phone number', () => {
    expect(detectDataFallback('Due 2026-03-12, ref 1234').filter(d => d.type === 'phone')).toEqual([]);
  });

  it('does not report the domain of an email address as a link', () => {
    expect(detectDataFallback('mail jo@northwind.com today').map(d => d.type)).toEqual(['email']);
  });

  it('finds nothing in plain prose', () => {
    expect(detectDataFallback('Kind regards, and thank you for your letter.')).toEqual([]);
  });
});

describe('tidyDetections', () => {
  const d = (type: DetectedData['type'], value: string, at: number): DetectedData => ({ type, value, text: value, range: [at, value.length] });

  it('drops repeats of the same number, email or link and sorts by position', () => {
    const out = tidyDetections([
      d('email', 'A@B.COM', 30),
      d('phone', '+1 415 555 0132', 0),
      d('phone', '+1 (415) 555-0132', 50),
      d('email', 'a@b.com', 70),
      d('url', 'https://x.org/', 90),
      d('url', 'http://x.org', 99),
    ]);
    expect(out.map(x => x.range[0])).toEqual([0, 30, 90]);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 40 }, (_, i) => d('phone', `+1 415 555 ${String(1000 + i)}`, i * 20));
    expect(tidyDetections(many)).toHaveLength(24);
  });
});

describe('chip labels and URLs', () => {
  it('shortens long values and drops the scheme of links', () => {
    const url: DetectedData = { type: 'url', text: 'https://www.riversidedental.com/booking/', value: 'https://www.riversidedental.com/booking/', range: [0, 40] };
    expect(detectionLabel(url)).toBe('www.riversidedental.com/booking');
    const long: DetectedData = { type: 'address', text: '1200 Market Street, Suite 400\nSan Francisco, CA 94102', value: 'x', range: [0, 10] };
    const label = detectionLabel(long, 20);
    expect(label.length).toBeLessThanOrEqual(20);
    expect(label.endsWith('…')).toBe(true);
    expect(label).not.toContain('\n');
  });

  it('builds tel:, Maps and web URLs', () => {
    expect(telUrl('+1 (415) 555-0132')).toBe('tel:+14155550132');
    expect(telUrl('020 7946 0958 ext. 12')).toBe('tel:02079460958');
    expect(mapsUrl('45 Elm Road,\nCambridge')).toBe('maps://?q=45%20Elm%20Road%2C%20Cambridge');
    expect(webUrl('www.example.org')).toBe('https://www.example.org');
    expect(webUrl('https://example.org/a')).toBe('https://example.org/a');
    expect(webUrl('javascript:alert(1)')).toBeNull();
    expect(webUrl('tel:123')).toBeNull();
  });
});

describe('eventFromDate', () => {
  const text =
    'Dear Mr. Carter,\nThis letter confirms your next check-up appointment\non Thursday, March 12, 2026 at 10:30 AM.\nKind regards,';
  const dateText = 'Thursday, March 12, 2026 at 10:30 AM';
  const at = text.indexOf(dateText);
  const timed: DetectedData = {
    type: 'date',
    text: dateText,
    value: dateText,
    range: [at, dateText.length],
    date: new Date(2026, 2, 12, 10, 30).getTime(),
    duration: 0,
    hasTime: true,
  };

  it('titles the event with the sentence, the date cut out', () => {
    const e = eventFromDate(timed, text)!;
    expect(e.title).toBe('This letter confirms your next check-up appointment');
    expect(e.allDay).toBe(false);
    expect(e.end - e.start).toBe(60 * 60 * 1000);
    expect(e.notes).toContain('March 12, 2026');
  });

  it('makes a whole-day event when no time is written', () => {
    const t = 'Rendez-vous le 14 avril 2026';
    const e = eventFromDate(
      { type: 'date', text: '14 avril 2026', value: '14 avril 2026', range: [t.indexOf('14'), 13], date: new Date(2026, 3, 14, 12).getTime(), hasTime: false },
      t,
    )!;
    expect(e.allDay).toBe(true);
    expect(new Date(e.start).getHours()).toBe(0);
    expect(e.title).toBe('Rendez-vous');
  });

  it('falls back to "Event" when the date stands alone', () => {
    const t = 'Notes\n12/03/2026\nMore';
    const e = eventFromDate(
      { type: 'date', text: '12/03/2026', value: '12/03/2026', range: [t.indexOf('12/'), 10], date: Date.now(), hasTime: false },
      t,
    )!;
    expect(e.title).toBe('Event');
  });

  it('ignores anything that is not a date', () => {
    expect(eventFromDate({ type: 'phone', text: '1', value: '1', range: [0, 1] }, '1')).toBeNull();
  });
});

describe('sentenceAt', () => {
  it('joins a sentence the page wrapped and keeps titles like Mr.', () => {
    const t = 'Dear Mr. Carter,\nThis letter confirms your next appointment\non Thursday. Kind regards.';
    const [s, e] = sentenceAt(t, t.indexOf('Carter'));
    expect(t.slice(s, e)).toBe('Dear Mr. Carter,');
    const [s2, e2] = sentenceAt(t, t.indexOf('appointment'));
    expect(t.slice(s2, e2)).toBe('This letter confirms your next appointment\non Thursday.');
    const [s3, e3] = sentenceAt(t, t.length - 3);
    expect(t.slice(s3, e3)).toBe('Kind regards.');
  });

  it('tells readable text from punctuation', () => {
    expect(hasReadableText(' — … ')).toBe(false);
    expect(hasReadableText('Total 12')).toBe(true);
  });
});

describe('parseBusinessCard', () => {
  const line = (text: string, top: number, height: number): OcrLine => ({ text, top, height, left: 100, width: 600 });
  const lines = [
    line('Sarah Mitchell', 150, 120),
    line('Senior Product Designer', 300, 62),
    line('Northwind Studio Ltd', 400, 62),
    line('Tel +1 (415) 555-0132', 640, 54),
    line('Mobile +1 415 555 0199', 722, 54),
    line('sarah.mitchell@northwindstudio.com', 804, 54),
    line('www.northwindstudio.com', 886, 54),
    line('1200 Market Street, Suite 400', 968, 54),
    line('San Francisco, CA 94102', 1050, 54),
  ];
  const text = lines.map(l => l.text).join('\n');
  const at = (s: string) => text.indexOf(s);
  const found: DetectedData[] = [
    { type: 'phone', text: '+1 (415) 555-0132', value: '+1 (415) 555-0132', range: [at('+1 (415)'), 17] },
    { type: 'phone', text: '+1 415 555 0199', value: '+1 415 555 0199', range: [at('+1 415 555'), 15] },
    { type: 'email', text: 'sarah.mitchell@northwindstudio.com', value: 'sarah.mitchell@northwindstudio.com', range: [at('sarah.'), 34] },
    { type: 'url', text: 'www.northwindstudio.com', value: 'http://www.northwindstudio.com', range: [at('www.'), 23] },
    {
      type: 'address',
      text: '1200 Market Street, Suite 400\nSan Francisco, CA 94102',
      value: '1200 Market Street, Suite 400\nSan Francisco, CA 94102',
      range: [at('1200'), 53],
      address: { street: '1200 Market Street, Suite 400', city: 'San Francisco', state: 'CA', postalCode: '94102' },
    },
  ];

  it('reads name, title, company and every contact detail', () => {
    const { fields, displayName } = parseBusinessCard(lines, found);
    expect(displayName).toBe('Sarah Mitchell');
    expect(fields.givenName).toBe('Sarah');
    expect(fields.familyName).toBe('Mitchell');
    expect(fields.jobTitle).toBe('Senior Product Designer');
    expect(fields.organizationName).toBe('Northwind Studio Ltd');
    expect(fields.phones).toEqual([
      { number: '+1 (415) 555-0132', label: 'work' },
      { number: '+1 415 555 0199', label: 'mobile' },
    ]);
    expect(fields.emails).toEqual(['sarah.mitchell@northwindstudio.com']);
    expect(fields.urls).toEqual(['http://www.northwindstudio.com']);
    expect(fields.addresses?.[0]).toMatchObject({ city: 'San Francisco', postalCode: '94102' });
    expect(hasContactData(fields)).toBe(true);
  });

  it('prefers the most prominent line for the name, and a name entity when there is one', () => {
    const swapped = [line('Northwind Studio Ltd', 100, 90), line('James Okafor', 260, 70), line('Lena Park', 330, 40)];
    expect(parseBusinessCard(swapped, []).displayName).toBe('James Okafor');
    expect(parseBusinessCard(swapped, [], { people: ['Lena Park'] }).displayName).toBe('Lena Park');
  });

  it('falls back to the company when no person is named', () => {
    const r = parseBusinessCard([line('ACME CONSULTING GROUP', 10, 80), line('info@acme.test', 200, 40)], [
      { type: 'email', text: 'info@acme.test', value: 'info@acme.test', range: [22, 14] },
    ]);
    expect(r.fields.givenName).toBeUndefined();
    expect(r.displayName).toBe('ACME CONSULTING GROUP');
  });

  it('finds nothing on a blank card', () => {
    const r = parseBusinessCard([], []);
    expect(hasContactData(r.fields)).toBe(false);
    expect(r.displayName).toBeNull();
  });
});

describe('splitName and document names', () => {
  it('splits prefixes, particles and suffixes', () => {
    expect(splitName('Dr. Emily Hart')).toEqual({ namePrefix: 'Dr.', givenName: 'Emily', familyName: 'Hart' });
    expect(splitName('Ludwig van Beethoven')).toEqual({ givenName: 'Ludwig', familyName: 'van Beethoven' });
    expect(splitName('MARY ANN SMITH JR.')).toEqual({ givenName: 'Mary', middleName: 'Ann', familyName: 'Smith', nameSuffix: 'Jr.' });
  });

  it('names the saved scan after the person', () => {
    expect(businessCardDocName('Sarah Mitchell', 'Business card 18 Nov')).toBe('Business card – Sarah Mitchell');
    expect(businessCardDocName(null, 'Business card 18 Nov')).toBe('Business card 18 Nov');
  });
});
