import { insertAt, reinsertOrder } from '../lib/page-undo';

test('reinsertOrder moves the appended page back to its old position', () => {
  // 3 pages left after deleting index 1; the restored page is appended as 3.
  expect(reinsertOrder(3, 1)).toEqual([0, 3, 1, 2]);
  expect(reinsertOrder(3, 0)).toEqual([3, 0, 1, 2]);
  expect(reinsertOrder(3, 3)).toEqual([0, 1, 2, 3]);
  // Out of range clamps rather than dropping pages.
  expect(reinsertOrder(2, 9)).toEqual([0, 1, 2]);
  expect(reinsertOrder(2, -1)).toEqual([2, 0, 1]);
});

test('insertAt puts per-page metadata back in place', () => {
  expect(insertAt(['a', 'c'], 1, 'b')).toEqual(['a', 'b', 'c']);
  expect(insertAt([], 0, 'x')).toEqual(['x']);
  expect(insertAt(['a'], 5, 'z')).toEqual(['a', 'z']);
});
