// lib/bake-queue.ts
//
// A module-level queue decoupling bake requests (from the viewer, ScanContext,
// the startup migration, …) from whichever component actually hosts the WebView
// that runs lib/bake-html.ts's HTML and serves the results back.
//
// HOSTS. Several FilterBaker instances can be mounted at once — one at the root
// (for the tabs) and one inside every full-screen surface that covers it (the
// viewer, annotate, the crop modal). iOS does not run a WebView that is buried
// under a full-screen modal, so only the TOPMOST host may take jobs. Hosts form
// a stack: registering pushes, unregistering pops and wakes the host underneath.
// When the top changes, any job a now-buried host is holding is taken back and
// re-queued at the front so the new top host runs it.
//
// LEASES. A job taken by a host is "leased" to it. A lease that has produced no
// result within LEASE_TIMEOUT_MS (WebView crashed, never loaded, image decode
// hung) is revoked: the job is retried once, then failed. That keeps one bad job
// from stalling every bake behind it.
//
// Results are first-wins: a late result from a host whose lease was revoked is
// accepted if the job is still pending, and ignored otherwise.

export type BakeJobInput = {
  docId: string;
  pageIndex: number;
  src: string;
  ops: Record<string, number>[];
  /**
   * When set, this job renders one small preview per entry instead of baking the
   * page, and resolves with 'PREVIEWS:' + a JSON array of data URLs. Lets the
   * filter picker get every tile from a single WebView pass.
   */
  previews?: Record<string, number>[][];
  previewWidth?: number;
  /** A look at a result that changes nothing (Erase marks' After): not shown as "Enhancing". */
  silent?: boolean;
};

export type BakeJob = BakeJobInput & { id: number };

export type BakeHost = {
  /** Called when this host is (or becomes) the top host and work may be waiting. */
  pump: () => void;
  /** Called when a job this host is holding has been taken back from it. */
  revoke: (jobId: number) => void;
};

export type EnqueueOptions = {
  /** User-initiated work (a filter tap) jumps ahead of background bakes. */
  priority?: 'high' | 'normal';
};

type PendingEntry = {
  job: BakeJob;
  priority: 'high' | 'normal';
  attempts: number;
  resolve: (dataUrl: string) => void;
  reject: (reason: Error) => void;
};

type Lease = { host: BakeHost; timer: ReturnType<typeof setTimeout> };

/** How long a host may hold a job before it is assumed stuck. */
export const LEASE_TIMEOUT_MS = 30_000;
/** Total attempts per job (first run + retries after a revoked lease). */
const MAX_ATTEMPTS = 2;

let nextId = 1;
const queue: number[] = [];
// Every enqueued job lives here from enqueue until it settles, whether it is
// still queued or has been taken by a host.
const pending = new Map<number, PendingEntry>();
const leases = new Map<number, Lease>();
const hosts: BakeHost[] = [];

function topHost(): BakeHost | null {
  return hosts.length ? hosts[hosts.length - 1] : null;
}

function wakeTop(): void {
  topHost()?.pump();
}

function clearLease(id: number): Lease | undefined {
  const lease = leases.get(id);
  if (lease) {
    clearTimeout(lease.timer);
    leases.delete(id);
  }
  return lease;
}

function insertQueued(id: number, priority: 'high' | 'normal', front = false): void {
  if (front) {
    queue.unshift(id);
    return;
  }
  if (priority === 'high') {
    // After any other high-priority work, before the first normal job.
    const firstNormal = queue.findIndex(q => pending.get(q)?.priority !== 'high');
    if (firstNormal === -1) queue.push(id);
    else queue.splice(firstNormal, 0, id);
    return;
  }
  queue.push(id);
}

/** Takes a job back from whichever host holds it and re-queues it at the front. */
function requeueFromLease(id: number): void {
  const lease = clearLease(id);
  if (!lease) return;
  const entry = pending.get(id);
  lease.host.revoke(id);
  if (!entry) return;
  insertQueued(id, entry.priority, true);
}

/**
 * Registers a WebView host. The newest host is the only one that receives work.
 * Returns an unregister function; calling it pops the host and wakes the one
 * underneath, re-queueing anything the departing host was holding.
 */
export function registerBakeHost(host: BakeHost): () => void {
  // A newly covered host can't run its WebView any more: take its work back.
  const previous = topHost();
  hosts.push(host);
  if (previous) {
    for (const [id, lease] of [...leases]) {
      if (lease.host === previous) requeueFromLease(id);
    }
  }
  host.pump();

  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const idx = hosts.lastIndexOf(host);
    if (idx !== -1) hosts.splice(idx, 1);
    for (const [id, lease] of [...leases]) {
      if (lease.host === host) {
        clearLease(id);
        const entry = pending.get(id);
        if (entry) insertQueued(id, entry.priority, true);
      }
    }
    wakeTop();
  };
}

/** Enqueues a bake job and returns a promise that resolves with the baked JPEG data URL. */
export function enqueueBake(input: BakeJobInput, options: EnqueueOptions = {}): Promise<string> {
  return enqueueBakeWithId(input, options).promise;
}

/** Like enqueueBake, but also returns the job id so the caller can cancel it. */
export function enqueueBakeWithId(
  input: BakeJobInput,
  options: EnqueueOptions = {},
): { id: number; promise: Promise<string> } {
  const id = nextId++;
  const job: BakeJob = { ...input, id };
  const priority = options.priority ?? 'normal';
  const promise = new Promise<string>((resolve, reject) => {
    pending.set(id, { job, priority, attempts: 0, resolve, reject });
    insertQueued(id, priority);
  });
  emitActivity();
  wakeTop();
  return { id, promise };
}

/**
 * Pops the oldest not-yet-taken job off the queue, or null if empty.
 *
 * With a `host`, only the top host gets work (a buried one gets null) and the
 * job is leased to it under LEASE_TIMEOUT_MS. Without one (tests, legacy
 * callers) the job is handed out with no lease.
 */
export function takeNextJob(host?: BakeHost): BakeJob | null {
  if (host && host !== topHost()) return null;
  while (queue.length) {
    const id = queue.shift()!;
    const entry = pending.get(id);
    if (!entry) continue; // settled while queued (cancelled, or a late result won)
    entry.attempts++;
    if (host) {
      const timer = setTimeout(() => onLeaseTimeout(id), LEASE_TIMEOUT_MS);
      // A watchdog, not work: it must never keep a JS runtime alive on its own
      // (Node/Jest; React Native timers have no unref and ignore this).
      (timer as { unref?: () => void }).unref?.();
      leases.set(id, { host, timer });
    }
    return entry.job;
  }
  return null;
}

function onLeaseTimeout(id: number): void {
  const lease = leases.get(id);
  if (!lease) return;
  const entry = pending.get(id);
  if (entry && entry.attempts >= MAX_ATTEMPTS) {
    clearLease(id);
    lease.host.revoke(id);
    failJob(id, 'timeout');
  } else {
    requeueFromLease(id);
  }
  wakeTop();
}

/** Resolves the enqueuer's promise for `id` with the baked data URL. No-op for an unknown id. */
export function completeJob(id: number, dataUrl: string): void {
  const entry = pending.get(id);
  clearLease(id);
  if (!entry) return;
  pending.delete(id);
  emitActivity();
  entry.resolve(dataUrl);
}

/** Rejects the enqueuer's promise for `id` with `reason`. No-op for an unknown id. */
export function failJob(id: number, reason: string): void {
  const entry = pending.get(id);
  clearLease(id);
  if (!entry) return;
  pending.delete(id);
  emitActivity();
  entry.reject(new Error(reason));
}

/**
 * Withdraws a job that no longer matters (its page was edited or a newer bake
 * superseded it). A queued job is dropped; a job already running is left to
 * finish but its result is discarded. The enqueuer's promise rejects with a
 * BakeCancelled error. Returns false for an unknown/settled id.
 */
export function cancelJob(id: number): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  const lease = clearLease(id);
  const qi = queue.indexOf(id);
  if (qi !== -1) queue.splice(qi, 1);
  pending.delete(id);
  emitActivity();
  entry.reject(new BakeCancelled());
  if (lease) {
    // The host is still busy with it; free it so it moves on.
    lease.host.revoke(id);
    wakeTop();
  }
  return true;
}

export class BakeCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'BakeCancelled';
  }
}

/** Number of jobs enqueued but not yet completed/failed (taken or not). */
export function pendingCount(): number {
  return pending.size;
}

/**
 * Returns a taken-but-unfinished job to the front of the queue.
 *
 * Used when a host has to give up a job without a result (its WebView crashed).
 * No-op for an unknown id.
 */
export function releaseJob(job: BakeJob): void {
  const entry = pending.get(job.id);
  clearLease(job.id);
  if (!entry) return;
  if (entry.attempts >= MAX_ATTEMPTS) {
    // Crashed every time it ran: give up on it rather than crash-looping.
    failJob(job.id, 'host gave up');
  } else if (!queue.includes(job.id)) {
    insertQueued(job.id, entry.priority, true);
  }
  wakeTop();
}

// ── Activity tracking ────────────────────────────────────────────────────────
// Baking is asynchronous and happens off-screen, so without this the user picks
// a filter (or finishes a scan) and nothing appears to happen until the image
// silently changes. Subscribers render a progress affordance from this.

const activityListeners = new Set<(active: number) => void>();

/** Subscribe to changes in the active bake count. Returns an unsubscribe fn. */
export function subscribeBakeActivity(fn: (active: number) => void): () => void {
  activityListeners.add(fn);
  fn(visibleCount());
  return () => { activityListeners.delete(fn); };
}

/** Preview jobs (filter-picker thumbnails, silent looks) change nothing and are not shown as "Enhancing". */
function visibleCount(): number {
  let n = 0;
  for (const entry of pending.values()) if (!entry.job.previews && !entry.job.silent) n++;
  return n;
}

function emitActivity(): void {
  const n = visibleCount();
  activityListeners.forEach(fn => fn(n));
}
