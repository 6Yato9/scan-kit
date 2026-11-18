import { planFilesCopy, type CopyDoc } from '../lib/files-copy-plan';

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
    expect(p).toEqual({ remove: [], write: [], forget: [] });
  });

  test('an edited document is rewritten in place', () => {
    const p = planFilesCopy([doc('a', 'Lease', 1, 9)], { a: { name: 'Lease.pdf', stamp: 5 } }, fileName);
    expect(p.write).toEqual([{ id: 'a', name: 'Lease.pdf', stamp: 9 }]);
    expect(p.remove).toEqual([]);
  });

  test('a renamed document drops its old file', () => {
    const p = planFilesCopy([doc('a', 'New lease', 1, 9)], { a: { name: 'Lease.pdf', stamp: 5 } }, fileName);
    expect(p.remove).toEqual(['Lease.pdf']);
    expect(p.write).toEqual([{ id: 'a', name: 'New lease.pdf', stamp: 9 }]);
  });

  test('a deleted document loses its copy', () => {
    const p = planFilesCopy([doc('a', 'Lease', 1, 5)], { a: { name: 'Lease.pdf', stamp: 5 }, gone: { name: 'Old.pdf', stamp: 1 } }, fileName);
    expect(p.remove).toEqual(['Old.pdf']);
    expect(p.forget).toEqual(['gone']);
    expect(p.write).toEqual([]);
  });

  test('same names: the older document keeps the plain name', () => {
    const p = planFilesCopy([doc('new', 'Receipt', 5), doc('old', 'Receipt', 1)], { old: { name: 'Receipt.pdf', stamp: 1 } }, fileName);
    expect(p.write).toEqual([{ id: 'new', name: 'Receipt 2.pdf', stamp: 5 }]);
  });

  test('a name freed by a deleted document and taken by another is overwritten, not removed', () => {
    const p = planFilesCopy(
      [doc('b', 'Receipt', 2, 7)],
      { a: { name: 'Receipt.pdf', stamp: 1 }, b: { name: 'Receipt 2.pdf', stamp: 2 } },
      fileName,
    );
    expect(p.write).toEqual([{ id: 'b', name: 'Receipt.pdf', stamp: 7 }]);
    expect(p.remove).toEqual(['Receipt 2.pdf']);
    expect(p.forget).toEqual(['a']);
  });
});
