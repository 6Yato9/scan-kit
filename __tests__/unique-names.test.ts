// __tests__/unique-names.test.ts
// r8 code review #1: Export all / multi-share failed when generated names
// collided with existing ones ("Receipt", "Receipt", "Receipt 2" gave two
// "Receipt 2.pdf" and zip-stream threw "Duplicate ZIP entry").
import { uniqueNames } from '../lib/unique-names';

const lower = (names: string[]) => names.map(n => n.toLowerCase());

describe('uniqueNames', () => {
  it('leaves distinct names alone', () => {
    expect(uniqueNames(['Invoice.pdf', 'Lease.pdf', 'Receipt.pdf'])).toEqual(['Invoice.pdf', 'Lease.pdf', 'Receipt.pdf']);
  });

  it('numbers a repeated name from 2', () => {
    expect(uniqueNames(['Scan.pdf', 'Scan.pdf', 'Scan.pdf'])).toEqual(['Scan.pdf', 'Scan 2.pdf', 'Scan 3.pdf']);
  });

  it('never generates a name that already exists later in the list ("Receipt, Receipt, Receipt 2")', () => {
    // The real "Receipt 2" keeps its name; the duplicate counts past it.
    const out = uniqueNames(['Receipt.pdf', 'Receipt.pdf', 'Receipt 2.pdf']);
    expect(out).toEqual(['Receipt.pdf', 'Receipt 3.pdf', 'Receipt 2.pdf']);
    expect(new Set(lower(out)).size).toBe(3);
  });

  it('skips a generated number that is taken by an earlier name', () => {
    const out = uniqueNames(['Receipt 2.pdf', 'Receipt.pdf', 'Receipt.pdf']);
    expect(out).toEqual(['Receipt 2.pdf', 'Receipt.pdf', 'Receipt 3.pdf']);
  });

  it('treats names that differ only in case as the same file', () => {
    const out = uniqueNames(['Scan.pdf', 'scan.pdf', 'SCAN.PDF', 'Scan 2.pdf']);
    expect(out).toEqual(['Scan.pdf', 'scan 3.pdf', 'SCAN 4.PDF', 'Scan 2.pdf']);
    expect(new Set(lower(out)).size).toBe(out.length);
  });

  it('handles names without an extension and dot-files', () => {
    expect(uniqueNames(['Notes', 'Notes', '.hidden', '.hidden'])).toEqual(['Notes', 'Notes 2', '.hidden', '.hidden 2']);
  });

  it('reserves a real name even when it differs only in case from a generated one', () => {
    expect(uniqueNames(['Scan.pdf', 'Scan.pdf', 'scan 2.pdf'])).toEqual(['Scan.pdf', 'Scan 3.pdf', 'scan 2.pdf']);
  });

  it('is always collision-free and keeps order and length', () => {
    const input = ['A.pdf', 'a.pdf', 'A 2.pdf', 'A 3.pdf', 'a 2.pdf', 'A.pdf', 'B.pdf', 'b 2.pdf', 'B.pdf'];
    const out = uniqueNames(input);
    expect(out).toHaveLength(input.length);
    expect(new Set(lower(out)).size).toBe(out.length);
    expect(out[0]).toBe('A.pdf');
    expect(out[6]).toBe('B.pdf');
  });
});
