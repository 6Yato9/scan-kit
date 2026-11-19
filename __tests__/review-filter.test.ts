// lib/review-filter.ts: the filter chosen in the camera's review is the one
// the pages are saved with (r12 product #6); only scans that save with a
// filter show the picker.
const mockEnqueue = jest.fn(async (job: any) => (job.previews ? `PREVIEWS:${JSON.stringify(job.previews.map((_: any, i: number) => `tile${i}`))}` : `data:image/jpeg;base64,${job.ops.length}`));
jest.mock('../lib/bake-queue', () => ({ enqueueBake: (job: any) => mockEnqueue(job) }));
jest.mock('../lib/bake', () => ({ PREVIEW_FILTERS: ['original', 'enhanced', 'noshadow', 'grayscale', 'bw', 'fainttext', 'photo', 'whiteboard', 'inksaver'] }));

import {
  bakeGroups,
  chooseReviewFilter,
  filtersFor,
  hasOwnReviewFilter,
  resetReviewFiltersForTests,
  reviewFilterOf,
  reviewFilterSession,
  reviewPagePreview,
  reviewTilePreviews,
  withReviewFilters,
} from '../lib/review-filter';

const photo = (n: number) => ({ sourceUri: `file:///caches/scanner-src/p${n}.jpg`, quad: null });

beforeEach(() => {
  resetReviewFiltersForTests();
  mockEnqueue.mockClear();
});

test('no picker outside an armed scan', () => {
  expect(reviewFilterSession()).toBeNull();
  chooseReviewFilter('bw');
  expect(reviewFilterOf('file:///x.jpg')).toBeNull();
});

test('untouched: every page gets the default filter; the session ends with the camera', async () => {
  const { pages, filters } = await withReviewFilters('enhanced', async () => {
    expect(reviewFilterSession()).toEqual({ defaultFilter: 'enhanced' });
    return [photo(1), photo(2)];
  });
  expect(pages).toHaveLength(2);
  expect(filters).toEqual(['enhanced', 'enhanced']);
  expect(reviewFilterSession()).toBeNull();
});

test('one filter for every page, then one page of its own', async () => {
  const { filters } = await withReviewFilters('enhanced', async () => {
    chooseReviewFilter('noshadow');
    chooseReviewFilter('bw', `${photo(2).sourceUri}?v=3`);
    expect(hasOwnReviewFilter(photo(2).sourceUri)).toBe(true);
    expect(reviewFilterOf(photo(1).sourceUri)).toBe('noshadow');
    return [photo(1), photo(2), photo(3)];
  });
  expect(filters).toEqual(['noshadow', 'bw', 'noshadow']);
});

test('choosing for all pages again clears the pages’ own choices', async () => {
  const { filters } = await withReviewFilters('original', async () => {
    chooseReviewFilter('bw', photo(1).sourceUri);
    chooseReviewFilter('grayscale');
    return [photo(1), photo(2)];
  });
  expect(filters).toEqual(['grayscale', 'grayscale']);
});

test('cancelled camera: no pages, no filters', async () => {
  const r = await withReviewFilters('enhanced', async () => null);
  expect(r).toEqual({ pages: null, filters: [] });
});

test('bake groups skip Original and keep page order', () => {
  expect(bakeGroups(['bw', 'original', 'bw', 'enhanced'])).toEqual([
    { filter: 'bw', indices: [0, 2] },
    { filter: 'enhanced', indices: [3] },
  ]);
  expect(bakeGroups(['original'])).toEqual([]);
});

test('previews go through the bake queue and are cached; Original needs no bake', async () => {
  const tiles = await reviewTilePreviews('file:///caches/prev.jpg?v=1');
  expect(tiles).toHaveLength(9);
  await reviewTilePreviews('file:///caches/prev.jpg');
  expect(mockEnqueue).toHaveBeenCalledTimes(1);
  expect(mockEnqueue.mock.calls[0][0].src).toBe('file:///caches/prev.jpg');
  expect(await reviewPagePreview('file:///caches/prev.jpg', 'original')).toBe('file:///caches/prev.jpg');
  const bw = await reviewPagePreview('file:///caches/prev.jpg', 'bw');
  expect(bw.startsWith('data:image/jpeg')).toBe(true);
  await reviewPagePreview('file:///caches/prev.jpg', 'bw');
  expect(mockEnqueue).toHaveBeenCalledTimes(2);
});

test('the snapshot is a new object on every change and reads like the session', async () => {
  const { getReviewFilterSnapshot, filterInSnapshot } = jest.requireActual('../lib/review-filter');
  await withReviewFilters('enhanced', async () => {
    const a = getReviewFilterSnapshot();
    expect(filterInSnapshot(a, photo(1).sourceUri)).toBe('enhanced');
    chooseReviewFilter('bw', photo(1).sourceUri);
    const b = getReviewFilterSnapshot();
    expect(b).not.toBe(a);
    expect(filterInSnapshot(b, photo(1).sourceUri)).toBe('bw');
    expect(filterInSnapshot(b, photo(2).sourceUri)).toBe('enhanced');
    return null;
  });
  expect(getReviewFilterSnapshot()).toBeNull();
});
