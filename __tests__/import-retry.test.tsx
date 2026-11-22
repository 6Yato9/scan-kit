// __tests__/import-retry.test.tsx
// "Open in Scan Kit" (app/import.tsx), r6 code review #5: a failed save must
// not lose the incoming file. iOS's Inbox copy is gone by then, so our staged
// copy is kept until a document has been saved from it, and "Try again" works
// from it — even though the import itself consumes (deletes) the file it is
// handed (auto-crop deletes its input once it has a cropped copy).
import { act, fireEvent, render, screen } from '@testing-library/react-native';

const mockFs: Record<string, true> = {};
jest.mock('expo-file-system', () => {
  class MockFile {
    uri: string;
    constructor(...parts: any[]) {
      this.uri = parts.map(p => (p && typeof p === 'object' ? p.uri : p)).join(''); // Paths.cache ends in '/'
    }
    get exists() { return !!mockFs[this.uri]; }
    get name() { return this.uri.split('/').pop() ?? ''; }
    copy(dest: MockFile) {
      if (!mockFs[this.uri]) throw new Error(`copy: ${this.uri} missing`);
      mockFs[dest.uri] = true;
    }
    delete() { delete mockFs[this.uri]; }
  }
  class MockDirectory {
    uri: string;
    constructor(...parts: any[]) {
      const joined = parts.map(p => (p && typeof p === 'object' ? p.uri : p)).join('');
      this.uri = joined.endsWith('/') ? joined : `${joined}/`;
    }
    create() {}
  }
  return { File: MockFile, Directory: MockDirectory, Paths: { cache: { uri: 'file:///cache/' }, document: { uri: 'file:///app/Documents/' } } };
});

const mockReplace = jest.fn();
const mockIncoming = { uri: 'file:///app/Documents/Inbox/Cafe%20receipt.jpg' };
// The route +native-intent makes carries this runtime's secret (lib/incoming-file).
const mockVia = () => {
  const { routeForIncomingUrl } = require('@/lib/incoming-file');
  return new URLSearchParams(routeForIncomingUrl('content://x/y').split('?')[1]).get('via');
};
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ uri: mockIncoming.uri, via: mockVia() }),
  useRouter: () => ({ replace: mockReplace }),
  Stack: { Screen: () => null },
}));

// Each call consumes its input, like auto-crop + saveScan do.
const mockSaveFiles = jest.fn();
jest.mock('@/components/use-import', () => ({ useImportDocuments: () => ({ saveFiles: mockSaveFiles }) }));
jest.mock('@/components/lock-gate', () => ({ LockScreen: () => null, useAppLocked: () => false }));
jest.mock('@/contexts/theme-context', () => ({ useTheme: () => ({ colors: {} }) }));
jest.mock('@/components/primary-button', () => {
  const { Text } = require('react-native');
  return { PrimaryButton: ({ title, onPress }: any) => <Text onPress={onPress}>{title}</Text> };
});
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@/lib/system-ui', () => ({ abandonSystemUI: jest.fn() }));
const mockIndexPdfText = jest.fn(async (..._a: unknown[]) => 'indexed');
jest.mock('@/lib/pdf-text', () => ({ indexPdfText: (...a: unknown[]) => mockIndexPdfText(...a) }));

// "Open in place": the native, security-scoped, coordinated copy (absent in old dev clients).
const mockNative: { copyIncomingFile?: jest.Mock } = {};
jest.mock('@/modules/vision-ocr/src', () => ({
  get VisionOcr() { return mockNative.copyIncomingFile ? mockNative : null; },
}));

import ImportScreen from '../app/import';

const INBOX = 'file:///app/Documents/Inbox/Cafe%20receipt.jpg';
// r7: staged under Caches/incoming/, which the startup sweep clears.
const staged = () => Object.keys(mockFs).filter(u => u.includes('/cache/incoming/incoming-'));
const strayInCacheRoot = () => Object.keys(mockFs).filter(u => /^file:\/\/\/cache\/[^/]+$/.test(u));
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => {
  for (const k of Object.keys(mockFs)) delete mockFs[k];
  mockFs[INBOX] = true;
  mockReplace.mockClear();
  mockSaveFiles.mockReset();
  mockIndexPdfText.mockClear();
  mockIncoming.uri = INBOX;
  delete mockNative.copyIncomingFile;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

test('a failed save keeps the staged copy; Try again imports it and then removes it', async () => {
  mockSaveFiles.mockImplementationOnce(async ([uri]: string[]) => {
    delete mockFs[uri]; // consumed (auto-crop), then the save fails (disk full)
    return null;
  });
  render(<ImportScreen />);
  await flush();

  expect(screen.getByText('Couldn’t import the file')).toBeTruthy();
  expect(mockFs[INBOX]).toBeUndefined(); // iOS's copy is gone…
  expect(staged()).toHaveLength(1); // …but ours survives
  expect(Object.keys(mockFs).filter(u => u.includes('/cache/attempt-'))).toEqual([]); // no stray work copies

  mockSaveFiles.mockImplementationOnce(async ([uri]: string[]) => {
    expect(mockFs[uri]).toBe(true); // a real file to import from
    delete mockFs[uri];
    return 'doc-1';
  });
  fireEvent.press(screen.getByText('Try again'));
  await flush();

  expect(mockSaveFiles).toHaveBeenCalledTimes(2);
  expect(staged()).toEqual([]);
  expect(mockReplace).toHaveBeenCalledWith({ pathname: '/viewer', params: { id: 'doc-1' } });
});

test('Go to Home after a failure removes the staged copy', async () => {
  mockSaveFiles.mockResolvedValueOnce(null);
  render(<ImportScreen />);
  await flush();
  expect(staged()).toHaveLength(1);
  fireEvent.press(screen.getByText('Go to Home'));
  expect(staged()).toEqual([]);
  expect(mockReplace).toHaveBeenCalledWith('/');
});

test('a successful import removes the staged copy and opens the viewer', async () => {
  mockSaveFiles.mockResolvedValueOnce('doc-2');
  render(<ImportScreen />);
  await flush();
  expect(staged()).toEqual([]);
  expect(strayInCacheRoot()).toEqual([]);
  expect(mockReplace).toHaveBeenCalledWith({ pathname: '/viewer', params: { id: 'doc-2' } });
  expect(screen.queryByText('Try again')).toBeNull();
});

test('an imported image is not read as a PDF', async () => {
  mockSaveFiles.mockResolvedValueOnce('doc-3');
  render(<ImportScreen />);
  await flush();
  expect(mockIndexPdfText).not.toHaveBeenCalled();
});

test('an imported PDF has its own text read into the search index', async () => {
  const PDF_INBOX = 'file:///app/Documents/Inbox/Agreement.pdf';
  mockFs[PDF_INBOX] = true;
  mockIncoming.uri = PDF_INBOX;
  mockSaveFiles.mockResolvedValueOnce('doc-4');
  render(<ImportScreen />);
  await flush();
  expect(mockSaveFiles).toHaveBeenCalledWith([expect.any(String)], 'pdf', expect.any(String));
  expect(mockIndexPdfText).toHaveBeenCalledWith('doc-4');
});

describe('open in place (the user’s own file, security-scoped)', () => {
  const ORIGINAL = 'file:///private/var/mobile/Library/Mobile%20Documents/com~apple~CloudDocs/Lease.pdf';

  test('is read through VisionOcr.copyIncomingFile, and the original is never removed', async () => {
    mockFs[ORIGINAL] = true;
    mockIncoming.uri = ORIGINAL;
    mockNative.copyIncomingFile = jest.fn(async (_src: string, dst: string) => { mockFs[dst] = true; return dst; });
    mockSaveFiles.mockResolvedValueOnce('doc-5');
    render(<ImportScreen />);
    await flush();
    expect(mockNative.copyIncomingFile).toHaveBeenCalledWith(ORIGINAL, expect.stringContaining('/cache/incoming/incoming-'));
    expect(mockFs[ORIGINAL]).toBe(true);
    expect(mockReplace).toHaveBeenCalledWith({ pathname: '/viewer', params: { id: 'doc-5' } });
  });

  test('falls back to a plain copy when the native copy fails', async () => {
    mockNative.copyIncomingFile = jest.fn(async () => { throw new Error('coordination failed'); });
    mockSaveFiles.mockResolvedValueOnce('doc-6');
    render(<ImportScreen />);
    await flush();
    expect(mockSaveFiles).toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith({ pathname: '/viewer', params: { id: 'doc-6' } });
  });

  test('a file that can’t be read either way says so, and touches nothing', async () => {
    mockIncoming.uri = ORIGINAL; // not readable by a plain copy (not in mockFs)
    mockNative.copyIncomingFile = jest.fn(async () => { throw new Error('no access'); });
    render(<ImportScreen />);
    await flush();
    expect(screen.getByText('Couldn’t open the file')).toBeTruthy();
    expect(mockSaveFiles).not.toHaveBeenCalled();
  });
});

// r11 #3: only the copy iOS made in THIS app's own Documents/Inbox is removed.
describe('the incoming file is removed only when it is our own Inbox copy', () => {
  test.each([
    ['another app\'s Documents/Inbox', 'file:///var/mobile/Containers/Data/Application/OTHER/Documents/Inbox/Lease.pdf'],
    ['an iCloud Drive folder called Documents/Inbox', 'file:///private/var/mobile/Library/Mobile%20Documents/com~apple~CloudDocs/Documents/Inbox/Lease.pdf'],
    ['a sub-folder of our Inbox', 'file:///app/Documents/Inbox/Nested/Lease.pdf'],
    ['a path that climbs out of our Inbox', 'file:///app/Documents/Inbox/../Lease.pdf'],
  ])('%s is the user\'s original and is never deleted', async (_what, original) => {
    mockFs[original] = true;
    mockIncoming.uri = original;
    mockSaveFiles.mockResolvedValueOnce('doc-9');
    render(<ImportScreen />);
    await flush();
    expect(mockSaveFiles).toHaveBeenCalledTimes(1);
    expect(mockFs[original]).toBe(true);
  });

  test('our own Inbox copy is removed once staged, however its path is spelled', async () => {
    const SPELLED = 'file:///app/Documents/Inbox/Cafe receipt.jpg'; // unescaped
    mockFs[SPELLED] = true;
    mockIncoming.uri = SPELLED;
    mockSaveFiles.mockResolvedValueOnce('doc-10');
    render(<ImportScreen />);
    await flush();
    expect(mockFs[SPELLED]).toBeUndefined();
  });
});

test('a link someone else made (no secret on the route) imports nothing', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const router = require('expo-router');
  const spy = jest.spyOn(router, 'useLocalSearchParams').mockReturnValue({ uri: INBOX, via: 'guess' });
  render(<ImportScreen />);
  await flush();
  expect(mockSaveFiles).not.toHaveBeenCalled();
  expect(staged()).toEqual([]);
  expect(mockFs[INBOX]).toBe(true); // nothing touched
  spy.mockRestore();
});
