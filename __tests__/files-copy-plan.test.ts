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
