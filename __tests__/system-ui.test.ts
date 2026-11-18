// System pickers (document camera, photo picker, Files) are tracked so the app
// lock covers them instead of presenting over them, and so a picker closed
// from outside (its promise never settles) can be settled as cancelled and the
// caller's busy flag reset (critique H1).
import { abandonSystemUI, isSystemUIOpen, subscribeSystemUI, withSystemUI } from '../lib/system-ui';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

afterEach(() => { abandonSystemUI(); });

test('marks a picker open while it is on screen', async () => {
  const d = deferred<string[]>();
  const seen: boolean[] = [];
  const unsub = subscribeSystemUI(open => seen.push(open));
  const call = withSystemUI(() => d.promise, () => []);
  expect(isSystemUIOpen()).toBe(true);
  d.resolve(['a.jpg']);
  await expect(call).resolves.toEqual(['a.jpg']);
  expect(isSystemUIOpen()).toBe(false);
  expect(seen).toEqual([true, false]);
  unsub();
});

test('a failing picker rejects and is no longer open', async () => {
  const call = withSystemUI(() => Promise.reject(new Error('denied')), () => null);
  await expect(call).rejects.toThrow('denied');
  expect(isSystemUIOpen()).toBe(false);
});

test('a picker that throws synchronously is not left open', async () => {
  const call = withSystemUI(() => { throw new Error('boom'); }, () => null);
  await expect(call).rejects.toThrow('boom');
  expect(isSystemUIOpen()).toBe(false);
});

test('an abandoned picker settles as cancelled, so the caller recovers', async () => {
  const d = deferred<{ scannedImages?: string[] }>();
  let busy = true;
  const caller = (async () => {
    try {
      const res = await withSystemUI(() => d.promise, () => ({ scannedImages: [] as string[] }));
      return res.scannedImages;
    } finally {
      busy = false;
    }
  })();
  expect(abandonSystemUI()).toBe(1);
  await expect(caller).resolves.toEqual([]);
  expect(busy).toBe(false);
  expect(isSystemUIOpen()).toBe(false);
  // A late result after that is ignored.
  d.resolve({ scannedImages: ['late.jpg'] });
  await Promise.resolve();
  expect(isSystemUIOpen()).toBe(false);
});

test('counts nested pickers; open until the last one closes', async () => {
  const a = deferred<number>();
  const b = deferred<number>();
  const ca = withSystemUI(() => a.promise, () => 0);
  const cb = withSystemUI(() => b.promise, () => 0);
  a.resolve(1);
  await ca;
  expect(isSystemUIOpen()).toBe(true);
  b.resolve(2);
  await cb;
  expect(isSystemUIOpen()).toBe(false);
});

test('abandon with nothing open is a no-op', () => {
  expect(abandonSystemUI()).toBe(0);
});
