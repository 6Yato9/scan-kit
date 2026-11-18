// lib/serial.ts
// Runs async calls one at a time, in the order they were made.

/**
 * Wraps `fn` so each call starts only after every earlier call has settled
 * (fulfilled or rejected). Each call still gets its own result or error.
 */
export function serialized<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve();
  return (...args: A) => {
    const run = tail.then(() => fn(...args), () => fn(...args));
    tail = run.catch(() => {});
    return run;
  };
}
