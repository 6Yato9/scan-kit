import { planFilesCopy, uniqueNamesAvoiding, type CopyDoc } from '../lib/files-copy-plan';

const fileName = (n: string) => `${n}.pdf`;
const doc = (id: string, name: string, createdAt: number, updatedAt = createdAt, pages = ['p']): CopyDoc =>
  ({ id, name, createdAt, updatedAt, pages });

describe('planFilesCopy', () => {
  test('first pass writes every document with pages', () => {
    const p = planFilesCopy([doc('a', 'Lease', 1), doc('b', 'Empty', 2, 2, [])], {}, fileName);
    expect(p.write).toEqual([{ id: 'a', name: 'Lease.pdf', stamp: 1 }]);
    expect(p.remove).toEqual([]);
  });

  test('nothing to do when every copy is current', () => {
    const p = planFilesCopy([doc('a', 'Lease', 1, 5)], { a: { name: 'Lease.pdf', stamp: 5 } }, fileName);
    expect(p).toEqual({ remove: [], write: [] });
  });

  test('an edited document is rewritten in place', () => {
    const p = planFilesCopy([doc('a', 'Lease', 1, 9)], { a: { name: 'Lease.pdf', stamp: 5 } }, fileName);
    expect(p.write).toEqual([{ id: 'a', name: 'Lease.pdf', stamp: 9 }]);
    expect(p.remove).toEqual([]);
  });

  test('a renamed document drops its old file', () => {
    const p = planFilesCopy([doc('a', 'New lease', 1, 9)], { a: { name: 'Lease.pdf', stamp: 5 } }, fileName);
    expect(p.remove).toEqual([{ id: 'a', name: 'Lease.pdf' }]);
    expect(p.write).toEqual([{ id: 'a', name: 'New lease.pdf', stamp: 9 }]);
  });

  test('a deleted document loses its copy', () => {
    const p = planFilesCopy([doc('a', 'Lease', 1, 5)], { a: { name: 'Lease.pdf', stamp: 5 }, gone: { name: 'Old.pdf', stamp: 1 } }, fileName);
    expect(p.remove).toEqual([{ id: 'gone', name: 'Old.pdf' }]);
    expect(p.write).toEqual([]);
  });

  test('same names: the older document keeps the plain name', () => {
    const p = planFilesCopy([doc('new', 'Receipt', 5), doc('old', 'Receipt', 1)], { old: { name: 'Receipt.pdf', stamp: 1 } }, fileName);
    expect(p.write).toEqual([{ id: 'new', name: 'Receipt 2.pdf', stamp: 5 }]);
  });

  test('a name freed by a deleted document is removed FIRST, even though another copy takes it next', () => {
    // So a write that fails or is cancelled can never leave the deleted document's PDF behind.
    const p = planFilesCopy(
      [doc('b', 'Receipt', 2, 7)],
      { a: { name: 'Receipt.pdf', stamp: 1 }, b: { name: 'Receipt 2.pdf', stamp: 2 } },
      fileName,
    );
    expect(p.remove).toEqual([{ id: 'a', name: 'Receipt.pdf' }, { id: 'b', name: 'Receipt 2.pdf' }]);
    expect(p.write).toEqual([{ id: 'b', name: 'Receipt.pdf', stamp: 7 }]);
  });

  test('a name the user’s own file has (or an edited copy) is never planned for a copy', () => {
    const p = planFilesCopy([doc('a', 'Lease', 1)], {}, fileName, ['lease.pdf']);
    expect(p.write).toEqual([{ id: 'a', name: 'Lease 2.pdf', stamp: 1 }]);
  });

  test('a copy whose name became the user’s moves to a free one', () => {
    // The manifest no longer lists it (lib/files-copy disowns an edited copy).
    const p = planFilesCopy([doc('a', 'Lease', 1, 5)], {}, fileName, ['Lease.pdf']);
    expect(p.write).toEqual([{ id: 'a', name: 'Lease 2.pdf', stamp: 5 }]);
    expect(p.remove).toEqual([]);
  });
});

describe('uniqueNamesAvoiding', () => {
  test('reserves real names, counts past them, and avoids occupied names case-insensitively', () => {
    expect(uniqueNamesAvoiding(['Receipt.pdf', 'Receipt.pdf', 'Receipt 2.pdf'], [])).toEqual(['Receipt.pdf', 'Receipt 3.pdf', 'Receipt 2.pdf']);
    expect(uniqueNamesAvoiding(['Scan.pdf', 'Scan.pdf'], ['SCAN.PDF', 'scan 2.pdf'])).toEqual(['Scan 3.pdf', 'Scan 4.pdf']);
  });
});

describe('retrying a copy that could not be made (r11 #8)', () => {
  const { mayAttemptWrite, noteWriteFailure, retryDelayMs, RETRY_BASE_MS, RETRY_MAX_MS } = require('../lib/files-copy-plan');

  test('the delay doubles from 30 s and is capped at an hour', () => {
    expect(retryDelayMs(1)).toBe(RETRY_BASE_MS);
    expect(retryDelayMs(2)).toBe(2 * RETRY_BASE_MS);
    expect(retryDelayMs(3)).toBe(4 * RETRY_BASE_MS);
    expect(retryDelayMs(50)).toBe(RETRY_MAX_MS);
  });

  test('a failure holds off the same version until its delay is over', () => {
    const f1 = noteWriteFailure(undefined, 7, 1000);
    expect(f1).toEqual({ stamp: 7, count: 1, until: 1000 + RETRY_BASE_MS });
    expect(mayAttemptWrite(f1, 7, 1000 + RETRY_BASE_MS - 1)).toBe(false);
    expect(mayAttemptWrite(f1, 7, 1000 + RETRY_BASE_MS)).toBe(true);
    const f2 = noteWriteFailure(f1, 7, 5000);
    expect(f2.count).toBe(2);
    expect(f2.until).toBe(5000 + 2 * RETRY_BASE_MS);
  });

  test('a changed document starts afresh', () => {
    const f = noteWriteFailure(noteWriteFailure(undefined, 7, 0), 7, 0);
    expect(mayAttemptWrite(f, 8, 1)).toBe(true);
    expect(noteWriteFailure(f, 8, 0).count).toBe(1);
    expect(mayAttemptWrite(undefined, 1, 0)).toBe(true);
  });
});
