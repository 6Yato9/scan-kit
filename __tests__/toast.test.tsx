import { Pressable, Text } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ToastProvider, useToast } from '../components/toast';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../contexts/theme-context', () => ({
  useTheme: () => ({ colors: { text: '#000', bg: '#fff', chrome: '#000', chromeText: '#fff', shadow: '#000' } }),
}));

function Trigger({ onUndo }: { onUndo: () => void }) {
  const toast = useToast();
  return (
    <Pressable onPress={() => toast.show('Page 2 deleted', { action: { label: 'Undo', onPress: onUndo } })}>
      <Text>Delete</Text>
    </Pressable>
  );
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('the toast action runs at most once, even when tapped again during the fade', () => {
  const onUndo = jest.fn();
  render(<ToastProvider><Trigger onUndo={onUndo} /></ToastProvider>);
  fireEvent.press(screen.getByText('Delete'));
  const undo = screen.getByRole('button', { name: 'Undo' });
  fireEvent.press(undo);
  // Still mounted while it fades out: a second tap must do nothing.
  fireEvent.press(undo);
  expect(onUndo).toHaveBeenCalledTimes(1);
  act(() => { jest.runAllTimers(); });
});

test('a new toast gets a fresh action', () => {
  const onUndo = jest.fn();
  render(<ToastProvider><Trigger onUndo={onUndo} /></ToastProvider>);
  fireEvent.press(screen.getByText('Delete'));
  fireEvent.press(screen.getByRole('button', { name: 'Undo' }));
  fireEvent.press(screen.getByText('Delete'));
  fireEvent.press(screen.getByRole('button', { name: 'Undo' }));
  expect(onUndo).toHaveBeenCalledTimes(2);
  act(() => { jest.runAllTimers(); });
});

test('an action toast stays up for 6 s, a plain one for under 2 s', () => {
  function Plain() {
    const toast = useToast();
    return <Pressable onPress={() => toast.show('Saved')}><Text>Save</Text></Pressable>;
  }
  render(<ToastProvider><Trigger onUndo={() => {}} /><Plain /></ToastProvider>);
  fireEvent.press(screen.getByText('Delete'));
  act(() => { jest.advanceTimersByTime(5500); });
  expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
  act(() => { jest.advanceTimersByTime(1000 + 300); });
  expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();

  fireEvent.press(screen.getByText('Save'));
  expect(screen.getByText('Saved')).toBeTruthy();
  act(() => { jest.advanceTimersByTime(1800 + 300); });
  expect(screen.queryByText('Saved')).toBeNull();
});
