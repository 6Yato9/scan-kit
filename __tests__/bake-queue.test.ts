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

describe('setBakeNotifier (legacy)', () => {
  it('wakes the notifier whenever a job is enqueued', () => {
    const notifier = jest.fn();
    bakeQueue.setBakeNotifier(notifier);
    notifier.mockClear(); // registering pumps once, in case work is already waiting

    bakeQueue.enqueueBake({ docId: 'd1', pageIndex: 0, src: 'a', ops: [] }).catch(() => {});
    bakeQueue.enqueueBake({ docId: 'd1', pageIndex: 1, src: 'b', ops: [] }).catch(() => {});

    expect(notifier).toHaveBeenCalledTimes(2);
  });

  it('setBakeNotifier(null) stops notifications', () => {
    const notifier = jest.fn();
    bakeQueue.setBakeNotifier(notifier);
    bakeQueue.setBakeNotifier(null);
    notifier.mockClear();

    bakeQueue.enqueueBake({ docId: 'd1', pageIndex: 0, src: 'a', ops: [] }).catch(() => {});

    expect(notifier).not.toHaveBeenCalled();
  });
});

function makeHost() {
  const host = {
    pump: jest.fn(),
    revoke: jest.fn(),
  };
  return host;
}

describe('host stack', () => {
  it('only the topmost host is handed work', () => {
    const root = makeHost();
    const viewer = makeHost();
    bakeQueue.registerBakeHost(root);
    bakeQueue.registerBakeHost(viewer);
    bakeQueue.enqueueBake({ docId: 'd', pageIndex: 0, src: 'a', ops: [] }).catch(() => {});

    expect(viewer.pump).toHaveBeenCalled();
    expect(bakeQueue.takeNextJob(root)).toBeNull();
    expect(bakeQueue.takeNextJob(viewer)?.pageIndex).toBe(0);
  });

  it('a host covered by a new one gives its in-flight job to the new top', () => {
    const root = makeHost();
    bakeQueue.registerBakeHost(root);
    bakeQueue.enqueueBake({ docId: 'd', pageIndex: 0, src: 'a', ops: [] }).catch(() => {});
    const job = bakeQueue.takeNextJob(root)!;

    const viewer = makeHost();
    bakeQueue.registerBakeHost(viewer);

    expect(root.revoke).toHaveBeenCalledWith(job.id);
    expect(viewer.pump).toHaveBeenCalled();
    expect(bakeQueue.takeNextJob(viewer)?.id).toBe(job.id);
  });

  it('closing the top host re-queues its job and wakes the host underneath', async () => {
    const root = makeHost();
    bakeQueue.registerBakeHost(root);
    const viewer = makeHost();
    const unregister = bakeQueue.registerBakeHost(viewer);
    const promise = bakeQueue.enqueueBake({ docId: 'd', pageIndex: 3, src: 'a', ops: [] });
    const job = bakeQueue.takeNextJob(viewer)!;
    root.pump.mockClear();

    unregister();

    expect(root.pump).toHaveBeenCalled();
    const again = bakeQueue.takeNextJob(root)!;
    expect(again.id).toBe(job.id);
    bakeQueue.completeJob(again.id, 'data:ok');
    await expect(promise).resolves.toBe('data:ok');
  });

  it('a late result from a host that lost the job is still accepted once', async () => {
    const root = makeHost();
    bakeQueue.registerBakeHost(root);
    const promise = bakeQueue.enqueueBake({ docId: 'd', pageIndex: 0, src: 'a', ops: [] });
    const job = bakeQueue.takeNextJob(root)!;
    const viewer = makeHost();
    bakeQueue.registerBakeHost(viewer);

    bakeQueue.completeJob(job.id, 'data:late');
    await expect(promise).resolves.toBe('data:late');
    // The re-queued copy is skipped rather than baked a second time.
    expect(bakeQueue.takeNextJob(viewer)).toBeNull();
  });
});

describe('lease timeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('re-queues a stuck job once, then fails it', async () => {
    const host = makeHost();
    bakeQueue.registerBakeHost(host);
    const promise = bakeQueue.enqueueBake({ docId: 'd', pageIndex: 0, src: 'a', ops: [] });
    const first = bakeQueue.takeNextJob(host)!;

    jest.advanceTimersByTime(bakeQueue.LEASE_TIMEOUT_MS + 1);
    expect(host.revoke).toHaveBeenCalledWith(first.id);
    const second = bakeQueue.takeNextJob(host)!;
    expect(second.id).toBe(first.id);

    jest.advanceTimersByTime(bakeQueue.LEASE_TIMEOUT_MS + 1);
    await expect(promise).rejects.toThrow('timeout');
    expect(bakeQueue.pendingCount()).toBe(0);
  });

  it('a host that crashes on every attempt gets the job failed, not looped', async () => {
    const host = makeHost();
    bakeQueue.registerBakeHost(host);
    const promise = bakeQueue.enqueueBake({ docId: 'd', pageIndex: 0, src: 'a', ops: [] });
    bakeQueue.releaseJob(bakeQueue.takeNextJob(host)!);
    bakeQueue.releaseJob(bakeQueue.takeNextJob(host)!);
    await expect(promise).rejects.toThrow('host gave up');
  });
});

describe('cancelJob and priority', () => {
  it('a cancelled queued job rejects with BakeCancelled and is never handed out', async () => {
    const { id, promise } = bakeQueue.enqueueBakeWithId({ docId: 'd', pageIndex: 0, src: 'a', ops: [] });
    expect(bakeQueue.cancelJob(id)).toBe(true);
    await expect(promise).rejects.toBeInstanceOf(bakeQueue.BakeCancelled);
    expect(bakeQueue.takeNextJob()).toBeNull();
    expect(bakeQueue.cancelJob(id)).toBe(false);
  });

  it('cancelling a running job frees its host', async () => {
    const host = makeHost();
    bakeQueue.registerBakeHost(host);
    const { id, promise } = bakeQueue.enqueueBakeWithId({ docId: 'd', pageIndex: 0, src: 'a', ops: [] });
    bakeQueue.takeNextJob(host);
    bakeQueue.cancelJob(id);
    await promise.catch(() => {});
    expect(host.revoke).toHaveBeenCalledWith(id);
  });

  it('high-priority work runs before queued background work, in its own FIFO order', () => {
    bakeQueue.enqueueBake({ docId: 'd', pageIndex: 0, src: 'bg0', ops: [] }).catch(() => {});
    bakeQueue.enqueueBake({ docId: 'd', pageIndex: 1, src: 'bg1', ops: [] }).catch(() => {});
    bakeQueue.enqueueBake({ docId: 'd', pageIndex: 2, src: 'hi1', ops: [] }, { priority: 'high' }).catch(() => {});
    bakeQueue.enqueueBake({ docId: 'd', pageIndex: 3, src: 'hi2', ops: [] }, { priority: 'high' }).catch(() => {});
    const order = [1, 2, 3, 4].map(() => bakeQueue.takeNextJob()!.src);
    expect(order).toEqual(['hi1', 'hi2', 'bg0', 'bg1']);
  });

  it('preview jobs are not counted as visible "Enhancing" activity', () => {
    const counts: number[] = [];
    bakeQueue.subscribeBakeActivity(n => counts.push(n));
    bakeQueue.enqueueBake({ docId: 'd', pageIndex: 0, src: 'a', ops: [], previews: [[]] }).catch(() => {});
    bakeQueue.enqueueBake({ docId: 'd', pageIndex: 0, src: 'a', ops: [] }).catch(() => {});
    expect(counts).toEqual([0, 0, 1]);
  });
});
