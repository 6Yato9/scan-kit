// __tests__/photos.test.ts
// Saving to Photos moves pages out of the locked app, so it waits while App
// Lock is engaged (r6 code review #1) and stops if its sheet was closed.
import * as MediaLibrary from 'expo-media-library';
import { savePagesToPhotos } from '../lib/photos';
import { FLUSH_DELAY_MS, resetNavGuardForTests, setNavLockState } from '../lib/nav-guard';

const mockNative: { saveImageToPhotos?: jest.Mock } = {};
jest.mock('../modules/vision-ocr/src', () => ({ get VisionOcr() { return mockNative; } }));

jest.mock('expo-media-library', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  saveToLibraryAsync: jest.fn().mockResolvedValue(undefined),
}));

const mockGet = MediaLibrary.getPermissionsAsync as jest.Mock;
const mockRequest = MediaLibrary.requestPermissionsAsync as jest.Mock;
const mockSave = MediaLibrary.saveToLibraryAsync as jest.Mock;
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  resetNavGuardForTests();
  mockGet.mockResolvedValue({ granted: true, canAskAgain: true });
});
afterEach(() => jest.useRealTimers());

test('saves every page, reporting progress, with clean URIs', async () => {
  const progress = jest.fn();
  await expect(savePagesToPhotos(['file:///p0.jpg?v=3', 'file:///p1.jpg'], { onProgress: progress })).resolves.toBe('saved');
  expect(mockSave.mock.calls).toEqual([['file:///p0.jpg'], ['file:///p1.jpg']]);
  expect(progress.mock.calls).toEqual([[0, 2], [1, 2]]);
});

test('asks for permission once, and reports a refusal without saving', async () => {
  mockGet.mockResolvedValue({ granted: false, canAskAgain: true });
  mockRequest.mockResolvedValue({ granted: false, canAskAgain: false });
  await expect(savePagesToPhotos(['file:///p0.jpg'])).resolves.toBe('denied');
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockSave).not.toHaveBeenCalled();
});

test('locked part-way: the next page waits for the unlock', async () => {
  let release!: () => void;
  mockSave.mockImplementationOnce(() => new Promise<void>(r => { release = r; }));
  const done = savePagesToPhotos(['file:///p0.jpg', 'file:///p1.jpg']);
  await settle();
  expect(mockSave).toHaveBeenCalledTimes(1);
  setNavLockState({ locked: true, lockRouteShown: true }); // the user locked the phone
  release();
  await settle();
  jest.advanceTimersByTime(60_000);
  await settle();
  expect(mockSave).toHaveBeenCalledTimes(1);
  setNavLockState({ locked: false });
  setNavLockState({ lockRouteShown: false });
  jest.advanceTimersByTime(FLUSH_DELAY_MS);
  await expect(done).resolves.toBe('saved');
  expect(mockSave).toHaveBeenCalledTimes(2);
});

test('nothing more is saved once the sheet that started it is closed', async () => {
  setNavLockState({ locked: true });
  const c = new AbortController();
  const done = savePagesToPhotos(['file:///p0.jpg'], { signal: c.signal });
  c.abort();
  setNavLockState({ locked: false });
  jest.advanceTimersByTime(FLUSH_DELAY_MS);
  await expect(done).resolves.toBe('cancelled');
  expect(mockGet).not.toHaveBeenCalled();
  expect(mockSave).not.toHaveBeenCalled();
});

describe('Android 10+: MediaStore through the native module, no permission', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Platform } = require('react-native');
  const originalOS = Platform.OS;
  beforeEach(() => {
    Platform.OS = 'android';
    mockNative.saveImageToPhotos = jest.fn().mockResolvedValue('content://media/external/images/media/1');
  });
  afterEach(() => {
    Platform.OS = originalOS;
    delete mockNative.saveImageToPhotos;
  });

  test('saves each page natively and never asks for a storage permission', async () => {
    await expect(savePagesToPhotos(['file:///p0.jpg?v=2', 'file:///p1.jpg'])).resolves.toBe('saved');
    expect(mockNative.saveImageToPhotos!.mock.calls).toEqual([['file:///p0.jpg'], ['file:///p1.jpg']]);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  test('Android 8–9 (no native save) still use expo-media-library', async () => {
    delete mockNative.saveImageToPhotos;
    await expect(savePagesToPhotos(['file:///p0.jpg'])).resolves.toBe('saved');
    expect(mockSave.mock.calls).toEqual([['file:///p0.jpg']]);
  });
});
