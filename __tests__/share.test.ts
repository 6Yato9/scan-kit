// __tests__/share.test.ts
import * as Sharing from 'expo-sharing';
import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system/legacy';
import { Share } from 'react-native';
import {
  cleanFileUri,
  exportFileName,
  isCancelError,
  printFile,
  runAfterDismiss,
  shareFile,
  ShareError,
  shareText,
} from '../lib/share';
import { FLUSH_DELAY_MS, resetNavGuardForTests, setNavLockState } from '../lib/nav-guard';

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(true),
  shareAsync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('expo-print', () => ({ printAsync: jest.fn().mockResolvedValue(undefined) }));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  getInfoAsync: jest.fn().mockResolvedValue({ exists: true }),
  deleteAsync: jest.fn(),
  makeDirectoryAsync: jest.fn(),
  moveAsync: jest.fn(),
  copyAsync: jest.fn(),
  readDirectoryAsync: jest.fn().mockResolvedValue([]),
}));

const mockShare = Sharing.shareAsync as jest.Mock;
const mockPrint = Print.printAsync as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  resetNavGuardForTests();
});

test('cleanFileUri strips cache-bust queries', () => {
  expect(cleanFileUri('file:///a/page-0.jpg?v=17')).toBe('file:///a/page-0.jpg');
  expect(cleanFileUri('file:///a/page-0.jpg')).toBe('file:///a/page-0.jpg');
});

test('shareFile passes a clean URI and options to expo-sharing', async () => {
  const outcome = await shareFile('file:///x.pdf?v=2', { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: 'Doc' });
  expect(mockShare).toHaveBeenCalledWith('file:///x.pdf', { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: 'Doc' });
  expect(outcome).toBe('finished');
});

test('shareFile does not hang when the native promise never settles', async () => {
  mockShare.mockReturnValueOnce(new Promise(() => {}));
  const onFinish = jest.fn();
  await expect(shareFile('file:///x.pdf', { graceMs: 10, onFinish })).resolves.toBe('presented');
  expect(onFinish).not.toHaveBeenCalled();
});

test('shareFile calls onFinish when the sheet finishes later', async () => {
  let resolve!: () => void;
  mockShare.mockReturnValueOnce(new Promise<void>(r => (resolve = r)));
  const onFinish = jest.fn();
  await shareFile('file:///x.pdf', { graceMs: 5, onFinish });
  resolve();
  await new Promise(r => setTimeout(r, 0));
  expect(onFinish).toHaveBeenCalledTimes(1);
});

test('shareFile turns native failures into a user-safe ShareError', async () => {
  mockShare.mockRejectedValueOnce(new Error('MissingCurrentViewControllerException'));
  await expect(shareFile('file:///x.pdf')).rejects.toBeInstanceOf(ShareError);
});

test('shareFile reports a missing file before opening the sheet', async () => {
  (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: false });
  await expect(shareFile('file:///gone.pdf')).rejects.toBeInstanceOf(ShareError);
  expect(mockShare).not.toHaveBeenCalled();
});

test('printFile prints the clean URI and treats cancel as a normal outcome', async () => {
  await expect(printFile('file:///x.pdf?v=1')).resolves.toBe('printed');
  expect(mockPrint).toHaveBeenCalledWith({ uri: 'file:///x.pdf' });
  mockPrint.mockRejectedValueOnce(new Error('Printing did not complete'));
  await expect(printFile('file:///x.pdf')).resolves.toBe('cancelled');
  mockPrint.mockRejectedValueOnce(new Error('Printer exploded'));
  await expect(printFile('file:///x.pdf')).rejects.toBeInstanceOf(ShareError);
});

test('isCancelError recognises iOS cancel messages', () => {
  expect(isCancelError(new Error('Printing did not complete'))).toBe(true);
  expect(isCancelError(new Error('User cancelled'))).toBe(true);
  expect(isCancelError(new Error('Disk full'))).toBe(false);
});

test('exportFileName keeps readable names and drops path characters', () => {
  expect(exportFileName('Invoice 2026', 'pdf')).toBe('Invoice 2026.pdf');
  expect(exportFileName('a/b:c', '.zip')).toBe('a b c.zip');
  expect(exportFileName('   ', 'jpg')).toBe('Document.jpg');
  // Display names show the time with a colon; the file gets macOS's "01.37".
  expect(exportFileName('Scan 18 Nov 2026 at 01:37', 'pdf')).toBe('Scan 18 Nov 2026 at 01.37.pdf');
  expect(exportFileName('Report: Q3/Q4', 'pdf')).toBe('Report Q3 Q4.pdf');
});

describe('runAfterDismiss', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('runs once after the dismiss signal', () => {
    const fn = jest.fn();
    const h = runAfterDismiss(fn, 1000);
    h.signal();
    h.signal();
    jest.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('falls back to a timer when no dismiss event arrives', () => {
    const fn = jest.fn();
    runAfterDismiss(fn, 300);
    jest.advanceTimersByTime(299);
    expect(fn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('can be cancelled', () => {
    const fn = jest.fn();
    runAfterDismiss(fn, 100).cancel();
    jest.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
});

// r6 code review #1: an export that finishes while App Lock is up must not
// present the share sheet / print dialog above the lock screen.
describe('App Lock', () => {
  // Lets pending promise continuations run without advancing fake time.
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const lock = () => setNavLockState({ locked: true, lockRouteShown: true });
  const unlock = () => {
    setNavLockState({ locked: false });
    setNavLockState({ lockRouteShown: false }); // /lock dismissed itself
    jest.advanceTimersByTime(FLUSH_DELAY_MS);
  };
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('shareFile waits while locked and presents once unlocked and the lock screen is gone', async () => {
    lock();
    const done = shareFile('file:///x.pdf', { graceMs: 10 });
    await settle();
    jest.advanceTimersByTime(60_000);
    await settle();
    expect(mockShare).not.toHaveBeenCalled();
    unlock();
    await settle();
    expect(mockShare).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(10);
    await expect(done).resolves.toBe('finished');
  });

  test('shareFile presents nothing when the sheet that started it was closed meanwhile', async () => {
    lock();
    const c = new AbortController();
    const done = shareFile('file:///x.pdf', { signal: c.signal });
    await settle();
    c.abort();
    unlock();
    await expect(done).resolves.toBe('skipped');
    expect(mockShare).not.toHaveBeenCalled();
  });

  test('printFile waits while locked; a closed sheet skips the dialog', async () => {
    lock();
    const done = printFile('file:///x.pdf');
    await settle();
    expect(mockPrint).not.toHaveBeenCalled();
    unlock();
    await expect(done).resolves.toBe('printed');
    expect(mockPrint).toHaveBeenCalledTimes(1);

    lock();
    const c = new AbortController();
    const skipped = printFile('file:///y.pdf', { signal: c.signal });
    c.abort();
    unlock();
    await expect(skipped).resolves.toBe('cancelled');
    expect(mockPrint).toHaveBeenCalledTimes(1);
  });

  test('shareText waits while locked and never rejects', async () => {
    const spy = jest.spyOn(Share, 'share').mockRejectedValue(new Error('dismissed'));
    lock();
    const done = shareText('Invoice 42');
    await settle();
    expect(spy).not.toHaveBeenCalled();
    unlock();
    await expect(done).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith({ message: 'Invoice 42' });
    spy.mockRestore();
  });
});
