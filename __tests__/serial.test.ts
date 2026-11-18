// __tests__/serial.test.ts
// scan-context saveAndOpen runs saves one at a time: a file opened with
// "Open in Scan Kit" while a scan is still being saved waits for it instead of
// failing (r6 code review #5).
import { serialized } from '../lib/serial';

test('a call made while another runs waits for it, then runs with its own result', async () => {
  const order: string[] = [];
  let finishFirst!: () => void;
  const save = serialized(async (name: string) => {
    order.push(`start ${name}`);
    if (name === 'scan') await new Promise<void>(r => { finishFirst = r; });
    order.push(`end ${name}`);
    return `${name}-id`;
  });
  const scan = save('scan');
  const incoming = save('incoming');
  await Promise.resolve();
  expect(order).toEqual(['start scan']);
  finishFirst();
  await expect(scan).resolves.toBe('scan-id');
  await expect(incoming).resolves.toBe('incoming-id');
  expect(order).toEqual(['start scan', 'end scan', 'start incoming', 'end incoming']);
});

test('a failed call does not stop the next one', async () => {
  const fn = jest.fn()
    .mockRejectedValueOnce(new Error('disk full'))
    .mockResolvedValueOnce('ok');
  const run = serialized(fn);
  const a = run();
  const b = run();
  await expect(a).rejects.toThrow('disk full');
  await expect(b).resolves.toBe('ok');
});
