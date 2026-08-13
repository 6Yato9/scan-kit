// lib/bake-queue.ts
//
// A module-level FIFO queue decoupling bake requests (e.g. from ScanContext,
// which isn't always mounted somewhere a WebView can live) from whichever
// component actually hosts the WebView that runs lib/bake-html.ts's HTML and
// serves the results back.
//
// Callers enqueue a job and await its resulting data URL; a WebView host
// pulls jobs one at a time via takeNextJob() and reports the outcome via
// completeJob()/failJob(). setBakeNotifier() lets the host know a new job
// arrived without polling.

export type BakeJobInput = {
  docId: string;
  pageIndex: number;
  src: string;
  css: string;
};

export type BakeJob = BakeJobInput & { id: number };

type PendingEntry = {
  resolve: (dataUrl: string) => void;
  reject: (reason: Error) => void;
};

let nextId = 1;
const queue: BakeJob[] = [];
// Every enqueued job lives here from enqueue until completeJob/failJob,
// regardless of whether it's still sitting in `queue` or has already been
// taken by the host and is being processed.
const pending = new Map<number, PendingEntry>();
let notifier: (() => void) | null = null;

/** Registers (or clears, with null) a callback invoked whenever a job is enqueued. */
export function setBakeNotifier(fn: (() => void) | null): void {
  notifier = fn;
}

/** Enqueues a bake job and returns a promise that resolves with the baked JPEG data URL. */
export function enqueueBake(input: BakeJobInput): Promise<string> {
  const id = nextId++;
  const job: BakeJob = { ...input, id };
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    queue.push(job);
    notifier?.();
  });
}

/** Pops the oldest not-yet-taken job off the queue, or null if empty. */
export function takeNextJob(): BakeJob | null {
  return queue.shift() ?? null;
}

/** Resolves the enqueuer's promise for `id` with the baked data URL. No-op for an unknown id. */
export function completeJob(id: number, dataUrl: string): void {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  entry.resolve(dataUrl);
}

/** Rejects the enqueuer's promise for `id` with `reason`. No-op for an unknown id. */
export function failJob(id: number, reason: string): void {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  entry.reject(new Error(reason));
}

/** Number of jobs enqueued but not yet completed/failed (taken or not). */
export function pendingCount(): number {
  return pending.size;
}
