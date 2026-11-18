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
  return { File: MockFile, Paths: { cache: { uri: 'file:///cache/' } } };
});

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ uri: 'file:///app/Documents/Inbox/Cafe%20receipt.jpg' }),
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

import ImportScreen from '../app/import';

const INBOX = 'file:///app/Documents/Inbox/Cafe%20receipt.jpg';
const staged = () => Object.keys(mockFs).filter(u => u.includes('/cache/incoming-'));
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => {
  for (const k of Object.keys(mockFs)) delete mockFs[k];
  mockFs[INBOX] = true;
  mockReplace.mockClear();
  mockSaveFiles.mockReset();
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
  expect(mockReplace).toHaveBeenCalledWith({ pathname: '/viewer', params: { id: 'doc-2' } });
  expect(screen.queryByText('Try again')).toBeNull();
});
