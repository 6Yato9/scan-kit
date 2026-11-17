// bake-queue.ts keeps module-level state (the FIFO queue, pending promise map,
// id counter, notifier). Re-require fresh for each test so state doesn't leak
// between tests (mirrors the pattern used in __tests__/storage.test.ts).
type BakeQueue = typeof import('../lib/bake-queue');
let bakeQueue: BakeQueue;

beforeEach(() => {
  jest.resetModules();
  bakeQueue = require('../lib/bake-queue');
});

describe('enqueueBake / takeNextJob (FIFO)', () => {
  it('returns jobs in the order they were enqueued', () => {
    bakeQueue.enqueueBake({ docId: 'd1', pageIndex: 0, src: 'file:///a.jpg', ops: [] }).catch(() => {});
    bakeQueue.enqueueBake({ docId: 'd1', pageIndex: 1, src: 'file:///b.jpg', ops: [] }).catch(() => {});
    bakeQueue.enqueueBake({ docId: 'd1', pageIndex: 2, src: 'file:///c.jpg', ops: [] }).catch(() => {});

    const first = bakeQueue.takeNextJob();
    const second = bakeQueue.takeNextJob();
    const third = bakeQueue.takeNextJob();

    expect(first?.pageIndex).toBe(0);
    expect(second?.pageIndex).toBe(1);
    expect(third?.pageIndex).toBe(2);
    expect(bakeQueue.takeNextJob()).toBeNull();
  });

  it('assigns each job a unique, increasing id', () => {
    bakeQueue.enqueueBake({ docId: 'd1', pageIndex: 0, src: 'a', ops: [] }).catch(() => {});
    bakeQueue.enqueueBake({ docId: 'd1', pageIndex: 1, src: 'b', ops: [] }).catch(() => {});
    const a = bakeQueue.takeNextJob()!;
    const b = bakeQueue.takeNextJob()!;
    expect(a.id).not.toBe(b.id);
  });

  it('takeNextJob returns null when the queue is empty', () => {
    expect(bakeQueue.takeNextJob()).toBeNull();
  });
});

describe('completeJob', () => {
  it('resolves the enqueuer promise with the data URL', async () => {
    const promise = bakeQueue.enqueueBake({ docId: 'd1', pageIndex: 0, src: 'a', ops: [] });
    const job = bakeQueue.takeNextJob()!;

    bakeQueue.completeJob(job.id, 'data:image/jpeg;base64,AAA');

    await expect(promise).resolves.toBe('data:image/jpeg;base64,AAA');
  });

  it('completing an unknown id is a harmless no-op', () => {
    expect(() => bakeQueue.completeJob(999, 'data:x')).not.toThrow();
  });
});

describe('failJob', () => {
  it('rejects the enqueuer promise with the reason', async () => {
    const promise = bakeQueue.enqueueBake({ docId: 'd1', pageIndex: 0, src: 'a', ops: [] });
    const job = bakeQueue.takeNextJob()!;

    bakeQueue.failJob(job.id, 'boom');

    await expect(promise).rejects.toThrow('boom');
  });

  it('failing an unknown id is a harmless no-op', () => {
    expect(() => bakeQueue.failJob(999, 'boom')).not.toThrow();
  });
});

describe('pendingCount', () => {
  it('increments on enqueue and decrements on complete/fail', async () => {
    expect(bakeQueue.pendingCount()).toBe(0);

    const p1 = bakeQueue.enqueueBake({ docId: 'd1', pageIndex: 0, src: 'a', ops: [] });
    const p2 = bakeQueue.enqueueBake({ docId: 'd1', pageIndex: 1, src: 'b', ops: [] });
    expect(bakeQueue.pendingCount()).toBe(2);

    const job1 = bakeQueue.takeNextJob()!;
    // Taking a job off the FIFO queue doesn't resolve it — it's still pending
    // an outcome from the WebView host.
    expect(bakeQueue.pendingCount()).toBe(2);

    bakeQueue.completeJob(job1.id, 'data:x');
    await p1;
    expect(bakeQueue.pendingCount()).toBe(1);

    const job2 = bakeQueue.takeNextJob()!;
    bakeQueue.failJob(job2.id, 'nope');
    await p2.catch(() => {});
    expect(bakeQueue.pendingCount()).toBe(0);
  });
});

describe('setBakeNotifier', () => {
  it('calls the notifier whenever a job is enqueued', () => {
    const notifier = jest.fn();
    bakeQueue.setBakeNotifier(notifier);

    bakeQueue.enqueueBake({ docId: 'd1', pageIndex: 0, src: 'a', ops: [] }).catch(() => {});
    bakeQueue.enqueueBake({ docId: 'd1', pageIndex: 1, src: 'b', ops: [] }).catch(() => {});

    expect(notifier).toHaveBeenCalledTimes(2);
  });

  it('setBakeNotifier(null) stops notifications', () => {
    const notifier = jest.fn();
    bakeQueue.setBakeNotifier(notifier);
    bakeQueue.setBakeNotifier(null);

    bakeQueue.enqueueBake({ docId: 'd1', pageIndex: 0, src: 'a', ops: [] }).catch(() => {});

    expect(notifier).not.toHaveBeenCalled();
  });
});
