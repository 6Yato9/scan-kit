// __tests__/share.test.ts
import * as Sharing from 'expo-sharing';
import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system/legacy';
import {
  cleanFileUri,
  exportFileName,
  isCancelError,
  printFile,
  runAfterDismiss,
  shareFile,
  ShareError,
} from '../lib/share';

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

beforeEach(() => jest.clearAllMocks());

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
