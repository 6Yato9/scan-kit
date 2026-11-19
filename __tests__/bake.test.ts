// __tests__/bake.test.ts
// bakePage runs against the REAL bake queue here; the test plays the WebView
// host (take a job, answer it), so ordering and race behaviour are exercised
// end to end. Only storage and file access are faked.
const mockWriteAsStringAsync = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-file-system/legacy', () => ({
  writeAsStringAsync: (...args: any[]) => mockWriteAsStringAsync(...args),
}));

let mockDirExists = true;
jest.mock('expo-file-system', () => {
  class MockFile {
    uri: string;
    constructor(dirOrUri: any, name?: string) {
      const base = dirOrUri && typeof dirOrUri === 'object' ? dirOrUri.uri : dirOrUri;
      this.uri = name ? `${base}/${name}` : String(base);
    }
  }
  class MockDirectory {
    uri: string;
    constructor(...parts: any[]) {
      this.uri = parts.map(p => (p && typeof p === 'object' ? p.uri : p)).join('/');
    }
    get exists() { return mockDirExists; }
  }
  return {
    File: MockFile,
    Directory: MockDirectory,
    Paths: { document: 'file:///documents' },
  };
});

const mockEnsureOriginal = jest.fn((docId: string, i: number) => `file:///documents/scan-kit/${docId}/page-${i}.orig.jpg`);
const mockPromotePageSide = jest.fn();
jest.mock('../lib/files', () => ({
  ensureOriginal: (docId: string, i: number) => mockEnsureOriginal(docId, i),
  // The bake writes beside the page and renames it over; the tests record the
  // write against the page it ends up as.
  pageSideUri: (docId: string, i: number) => `file:///documents/scan-kit/${docId}/page-${i}.jpg`,
  promotePageSide: (...args: any[]) => mockPromotePageSide(...args),
}));

const mockCapStoredPageSize = jest.fn().mockResolvedValue(false);
jest.mock('../lib/image', () => ({
  capStoredPageSize: (...args: any[]) => mockCapStoredPageSize(...args),
}));

const mockSetPageBaked = jest.fn().mockResolvedValue(undefined);
jest.mock('../lib/storage', () => ({
  setPageBaked: (...args: any[]) => mockSetPageBaked(...args),
}));

import {
  bakePage,
  bakePages,
  BakeWaitAborted,
  hasPendingBakes,
  isEditRefused,
  pendingBakeCount,
  waitForPendingBakes,
  pendingBakesFor,
  remapForDelete,
  remapForReorder,
  runPageEdit,
  subscribeBakeChanges,
} from '../lib/bake';
import { completeJob, failJob, pendingCount, takeNextJob, BakeJob } from '../lib/bake-queue';

const page = (i: number) => `file:///documents/scan-kit/doc1/page-${i}.jpg`;
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
};
/** Plays the WebView: answers the next job with base64 naming its source. */
async function bakeNext(): Promise<BakeJob> {
  await flush();
  const job = takeNextJob();
  if (!job) throw new Error('no job queued');
  completeJob(job.id, `data:image/jpeg;base64,${job.src.split('/').pop()}`);
  await flush();
  return job;
}
const writes = () => mockWriteAsStringAsync.mock.calls.map(c => [c[0], c[1]]);

beforeEach(async () => {
  // Drain anything a previous test left behind.
  await flush();
  for (let j = takeNextJob(); j; j = takeNextJob()) failJob(j.id, 'reset');
  await flush();
  jest.clearAllMocks();
  mockDirExists = true;
  mockWriteAsStringAsync.mockResolvedValue(undefined);
  mockSetPageBaked.mockResolvedValue(undefined);
  mockCapStoredPageSize.mockResolvedValue(false);
});

test('the baked page is renamed into place before the filter is recorded', async () => {
  const done = bakePage('doc1', 2, 'bw', undefined);
  await bakeNext();
  expect(await done).toBe(true);
  expect(mockPromotePageSide).toHaveBeenCalledWith('doc1', 2);
  expect(mockPromotePageSide.mock.invocationCallOrder[0]).toBeLessThan(mockSetPageBaked.mock.invocationCallOrder[0]);
});

test('an oversized page is shrunk (with its shadow) before it is baked', async () => {
  const done = bakePage('doc1', 0, 'grayscale', undefined);
  await bakeNext();
  expect(await done).toBe(true);
  expect(mockCapStoredPageSize).toHaveBeenCalledWith('doc1', 0);
  // Shadow first, then the size cap, so both files are capped together.
  expect(mockEnsureOriginal.mock.invocationCallOrder[0]).toBeLessThan(mockCapStoredPageSize.mock.invocationCallOrder[0]);
});

test('bakes from .orig, writes the decoded bytes to the right page, and records the filter', async () => {
  const done = bakePage('doc1', 0, 'grayscale', undefined);
  const job = await bakeNext();

  expect(job.src).toBe('file:///documents/scan-kit/doc1/page-0.orig.jpg');
  expect(job.ops).toEqual([{ docgray: 1 }]);
  await expect(done).resolves.toBe(true);
  expect(mockWriteAsStringAsync).toHaveBeenCalledWith(page(0), 'page-0.orig.jpg', { encoding: 'base64' });
  expect(mockSetPageBaked).toHaveBeenCalledWith('doc1', 0, 'grayscale', undefined);
  // Write must happen before the filter is recorded.
  expect(mockWriteAsStringAsync.mock.invocationCallOrder[0])
    .toBeLessThan(mockSetPageBaked.mock.invocationCallOrder[0]);
});

test('passes adjustments through to the bake ops and setPageBaked', async () => {
  const adjustment = { brightness: 10, contrast: 0, saturation: 0 };
  const done = bakePage('doc1', 0, 'enhanced', adjustment);
  const job = await bakeNext();
  await done;
  expect(job.ops).toEqual([{ magic: 1 }, { brightness: 1.1 }]);
  expect(mockSetPageBaked).toHaveBeenCalledWith('doc1', 0, 'enhanced', adjustment);
});

test('on a failed bake, neither the write nor setPageBaked happens', async () => {
  const done = bakePage('doc1', 0, 'grayscale', undefined);
  await flush();
  failJob(takeNextJob()!.id, 'load');
  await expect(done).rejects.toThrow('load');
  expect(mockWriteAsStringAsync).not.toHaveBeenCalled();
  expect(mockSetPageBaked).not.toHaveBeenCalled();
});

test('a failed write propagates and setPageBaked is never called', async () => {
  mockWriteAsStringAsync.mockRejectedValue(new Error('disk full'));
  const done = bakePage('doc1', 0, 'grayscale', undefined);
  const assertion = expect(done).rejects.toThrow('disk full');
  await bakeNext();
  await assertion;
  expect(mockSetPageBaked).not.toHaveBeenCalled();
});

test('a document deleted mid-bake is not written to (or resurrected)', async () => {
  const done = bakePage('doc1', 0, 'bw', undefined);
  mockDirExists = false;
  await bakeNext();
  await expect(done).resolves.toBe(false);
  expect(mockWriteAsStringAsync).not.toHaveBeenCalled();
  expect(mockSetPageBaked).not.toHaveBeenCalled();
});

describe('edits during an in-flight bake (core #1)', () => {
  test('deleting an EARLIER page re-targets the bake to the page’s new index', async () => {
    const done = bakePage('doc1', 2, 'bw', undefined);
    await flush();
    const running = takeNextJob()!; // the WebView is working on old page 2
    expect(running.src).toContain('page-2.orig.jpg');

    await runPageEdit('doc1', { remap: remapForDelete(1) }, () => {});
    // The old result would land on the wrong file; it is discarded…
    completeJob(running.id, 'data:image/jpeg;base64,STALE');
    // …and the page is baked again from where it lives now.
    const redo = await bakeNext();
    expect(redo.src).toContain('page-1.orig.jpg');
    await expect(done).resolves.toBe(true);

    expect(writes()).toEqual([[page(1), 'page-1.orig.jpg']]);
    expect(mockSetPageBaked).toHaveBeenCalledTimes(1);
    expect(mockSetPageBaked).toHaveBeenCalledWith('doc1', 1, 'bw', undefined);
  });

  test('deleting the page being baked drops the bake: no write, no resurrection', async () => {
    const done = bakePage('doc1', 1, 'bw', undefined);
    await flush();
    const running = takeNextJob()!;
    await runPageEdit('doc1', { remap: remapForDelete(1) }, () => {});
    completeJob(running.id, 'data:image/jpeg;base64,X');
    await expect(done).resolves.toBe(false);
    expect(mockWriteAsStringAsync).not.toHaveBeenCalled();
    expect(mockSetPageBaked).not.toHaveBeenCalled();
    expect(pendingCount()).toBe(0);
  });

  test('a queued (not yet running) bake follows its page through a reorder', async () => {
    const done = bakePage('doc1', 0, 'grayscale', undefined);
    await flush();
    // Reverse three pages before the WebView picks the job up.
    await runPageEdit('doc1', { remap: remapForReorder([2, 1, 0]) }, () => {});
    const job = await bakeNext();
    expect(job.src).toContain('page-2.orig.jpg');
    await expect(done).resolves.toBe(true);
    expect(mockSetPageBaked).toHaveBeenCalledWith('doc1', 2, 'grayscale', undefined);
    expect(takeNextJob()).toBeNull(); // the stale queued job was withdrawn, not run
  });

  test('rotating the page mid-bake re-bakes from the rotated .orig instead of undoing the rotate', async () => {
    const done = bakePage('doc1', 0, 'enhanced', undefined);
    await flush();
    const running = takeNextJob()!;
    await runPageEdit('doc1', { pages: [0] }, () => {});
    completeJob(running.id, 'data:image/jpeg;base64,UNROTATED');
    await bakeNext();
    await expect(done).resolves.toBe(true);
    expect(writes()).toEqual([[page(0), 'page-0.orig.jpg']]);
  });

  test('an edit to another page leaves the bake alone', async () => {
    const done = bakePage('doc1', 0, 'bw', undefined);
    await flush();
    const running = takeNextJob()!;
    await runPageEdit('doc1', { pages: [3] }, () => {});
    completeJob(running.id, 'data:image/jpeg;base64,OK');
    await expect(done).resolves.toBe(true);
    expect(writes()).toEqual([[page(0), 'OK']]);
  });

  test('a fresh scan baked with bakePages survives a delete in the middle', async () => {
    const all = bakePages('doc1', [0, 1, 2, 3], 'enhanced');
    await flush();
    const first = takeNextJob()!; // page 0 running, 1-3 queued
    await runPageEdit('doc1', { remap: remapForDelete(1) }, () => {});
    completeJob(first.id, `data:image/jpeg;base64,${first.src.split('/').pop()}`);
    await bakeNext();
    await bakeNext();
    await all;
    expect(takeNextJob()).toBeNull();
    // Old pages 0, 2, 3 are now 0, 1, 2 — each baked exactly once, from its own source.
    expect(writes().sort()).toEqual([
      [page(0), 'page-0.orig.jpg'],
      [page(1), 'page-1.orig.jpg'],
      [page(2), 'page-2.orig.jpg'],
    ]);
  });
});

describe('latest choice wins (core #10)', () => {
  test('filter then slider: only the newest request writes, with the new filter', async () => {
    const filterDone = bakePage('doc1', 0, 'bw', undefined, { priority: 'high' });
    await flush();
    const adj = { brightness: 20, contrast: 0, saturation: 0 };
    const adjustDone = bakePage('doc1', 0, 'bw', adj, { priority: 'high' });
    await bakeNext();
    await expect(filterDone).resolves.toBe(false);
    await expect(adjustDone).resolves.toBe(true);
    expect(mockSetPageBaked).toHaveBeenCalledTimes(1);
    expect(mockSetPageBaked).toHaveBeenCalledWith('doc1', 0, 'bw', adj);
  });

  test('a superseded RUNNING bake cannot overwrite the newer one', async () => {
    const older = bakePage('doc1', 0, 'grayscale', undefined);
    await flush();
    const running = takeNextJob()!;
    const newer = bakePage('doc1', 0, 'bw', undefined);
    completeJob(running.id, 'data:image/jpeg;base64,OLD');
    await bakeNext();
    await expect(older).resolves.toBe(false);
    await expect(newer).resolves.toBe(true);
    expect(mockSetPageBaked.mock.calls).toEqual([['doc1', 0, 'bw', undefined]]);
  });

  test('pendingBakesFor exposes the newest choice per page until it lands', async () => {
    const changes: string[] = [];
    const unsub = subscribeBakeChanges(id => changes.push(id));
    const done = bakePage('doc1', 1, 'enhanced', undefined);
    expect(pendingBakesFor('doc1').get(1)).toEqual({ filter: 'enhanced', adjustment: undefined });
    expect(hasPendingBakes('doc1')).toBe(true);
    await bakeNext();
    await done;
    expect(pendingBakesFor('doc1').size).toBe(0);
    expect(changes).toContain('doc1');
    unsub();
  });
});

describe('a refused edit re-targets no bake (r13b code M2)', () => {
  class Refused extends Error { readonly editRefused = true; }

  test('isEditRefused only recognises errors that say so', () => {
    expect(isEditRefused(new Refused())).toBe(true);
    expect(isEditRefused(new Error('x'))).toBe(false);
    expect(isEditRefused(Object.assign(new Error('x'), { editRefused: false }))).toBe(false);
    expect(isEditRefused(null)).toBe(false);
  });

  test('an Undo refused before touching anything leaves a running bake for a trailing page alone', async () => {
    // Say pages 0-2 were merged, then page 3 was added with "B&W": its bake runs.
    const done = bakePage('doc1', 3, 'bw', undefined);
    await flush();
    const running = takeNextJob()!;
    // The merge's Undo (remap: page 2 onwards go) refuses: pages changed since.
    await expect(runPageEdit('doc1', { remap: i => (i >= 2 ? -1 : i) }, () => { throw new Refused('pages-changed'); }))
      .rejects.toThrow('pages-changed');
    completeJob(running.id, 'data:image/jpeg;base64,BW');
    await expect(done).resolves.toBe(true);
    expect(writes()).toEqual([[page(3), 'BW']]);
    expect(mockSetPageBaked).toHaveBeenCalledWith('doc1', 3, 'bw', undefined);
  });

  test('an edit that failed some other way still counts as having changed the pages', async () => {
    const done = bakePage('doc1', 3, 'bw', undefined);
    await flush();
    const running = takeNextJob()!;
    await expect(runPageEdit('doc1', { remap: i => (i >= 2 ? -1 : i) }, () => { throw new Error('disk'); }))
      .rejects.toThrow('disk');
    completeJob(running.id, 'data:image/jpeg;base64,BW');
    await expect(done).resolves.toBe(false);
    expect(mockWriteAsStringAsync).not.toHaveBeenCalled();
  });

  test('the Undo that does go ahead drops the bakes of the pages it removed', async () => {
    const done = bakePage('doc1', 3, 'bw', undefined);
    await flush();
    const running = takeNextJob()!;
    await runPageEdit('doc1', { remap: i => (i >= 2 ? -1 : i) }, () => {});
    completeJob(running.id, 'data:image/jpeg;base64,BW');
    await expect(done).resolves.toBe(false);
    expect(mockWriteAsStringAsync).not.toHaveBeenCalled();
  });
});

test('runPageEdit waits for an in-progress write and vice versa (no interleaving)', async () => {
  const order: string[] = [];
  let release!: () => void;
  mockWriteAsStringAsync.mockImplementationOnce(() => new Promise<void>(r => {
    order.push('write-start');
    release = () => { order.push('write-end'); r(); };
  }));
  const done = bakePage('doc1', 5, 'bw', undefined);
  await bakeNext();
  const edit = runPageEdit('doc1', { pages: [0] }, () => { order.push('edit'); });
  await flush();
  release();
  await Promise.all([done, edit]);
  expect(order).toEqual(['write-start', 'write-end', 'edit']);
});

describe('waitForPendingBakes (exports wait for enhancements, r5 product #1)', () => {
  test('resolves at once when nothing is pending', async () => {
    await expect(waitForPendingBakes('doc1')).resolves.toBe('done');
  });

  test('waits until every page of the document has been baked, reporting progress', async () => {
    const all = bakePages('doc1', [0, 1], 'enhanced');
    expect(pendingBakeCount('doc1')).toBe(2);
    const progress: number[] = [];
    let settled = false;
    const wait = waitForPendingBakes('doc1', { onProgress: n => progress.push(n) }).then(v => { settled = true; return v; });
    await bakeNext();
    expect(settled).toBe(false);
    await bakeNext();
    await expect(wait).resolves.toBe('done');
    await all;
    expect(progress).toEqual([2, 1]);
    // The pixels were written before the export is let through.
    expect(mockSetPageBaked).toHaveBeenCalledTimes(2);
  });

  test("another document's bakes don't hold the export", async () => {
    const other = bakePage('doc2', 0, 'bw', undefined);
    await expect(waitForPendingBakes('doc1')).resolves.toBe('done');
    await bakeNext();
    await other;
  });

  test('a failed bake still releases the wait (the page keeps its raw pixels)', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const all = bakePages('doc1', [0], 'enhanced');
    const wait = waitForPendingBakes('doc1');
    await flush();
    const job = takeNextJob()!;
    failJob(job.id, 'decode');
    await expect(wait).resolves.toBe('done');
    await all;
    spy.mockRestore();
  });

  test('Cancel rejects with BakeWaitAborted and leaves the bake running', async () => {
    const done = bakePage('doc1', 0, 'bw', undefined);
    const controller = new AbortController();
    const wait = waitForPendingBakes('doc1', { signal: controller.signal });
    controller.abort();
    await expect(wait).rejects.toBeInstanceOf(BakeWaitAborted);
    expect(hasPendingBakes('doc1')).toBe(true);
    await bakeNext();
    await expect(done).resolves.toBe(true);
  });

  test('gives up after the timeout so an export is never stuck', async () => {
    jest.useFakeTimers();
    try {
      const done = bakePage('doc1', 0, 'bw', undefined);
      const wait = waitForPendingBakes('doc1', { timeoutMs: 1000 });
      jest.advanceTimersByTime(1000);
      await expect(wait).resolves.toBe('timeout');
      jest.useRealTimers();
      await bakeNext();
      await done;
    } finally {
      jest.useRealTimers();
    }
  });
});
