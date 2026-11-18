// __tests__/r11-ui.test.tsx
// Round 11 UI: the dash-glue fallback for grid titles, and where toasts sit
// (a screen's claimed spot, the viewer's spot above its toolbar) with the
// action always tinted.
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { glueStrandsFirstLine } from '../components/word-clamp-text';
import { ToastProvider, useToast, useToastAnchor } from '../components/toast';
import { Colors } from '../lib/theme';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('../contexts/theme-context', () => ({
  useTheme: () => ({ isDark: false, colors: { text: '#000', bg: '#fff', chromeAccent: '#4ec6e0', shadow: '#000' } }),
}));

describe('glueStrandsFirstLine', () => {
  test('a glued dash that leaves one word alone on line 1 is let go', () => {
    expect(glueStrandsFirstLine(['Meeting ', 'Notes - Project Atlas'])).toBe(true);
  });
  test('the normal case keeps the glue', () => {
    expect(glueStrandsFirstLine(['Northwind Traders – ', 'Project Atlas'])).toBe(false);
    expect(glueStrandsFirstLine(['Invoice 4471 - ', 'Project Atlas'])).toBe(false);
    expect(glueStrandsFirstLine(['Warranty Card'])).toBe(false);
    // One word on line 1 for another reason (a long word), no dash behind it.
    expect(glueStrandsFirstLine(['Supercalifragilistic ', 'receipt'])).toBe(false);
  });
});

function Trigger({ claim }: { claim?: number }) {
  const toast = useToast();
  const claimAnchor = useToastAnchor();
  useEffect(() => (claim == null ? undefined : claimAnchor(claim)), [claim, claimAnchor]);
  return (
    <Pressable onPress={() => toast.show('Page 2 deleted', { action: { label: 'Undo', onPress: () => {} } })}>
      <Text>Delete</Text>
    </Pressable>
  );
}

const bottomOf = () => {
  // The toast's absolutely positioned wrapper is the Undo text's 4th ancestor or so: find the one with `bottom`.
  let node: any = screen.getByText('Page 2 deleted');
  while (node && StyleSheet.flatten(node.props.style)?.bottom === undefined) node = node.parent;
  return StyleSheet.flatten(node.props.style).bottom;
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => { act(() => { jest.runAllTimers(); }); jest.useRealTimers(); });

test('by default the toast clears the tab bar', () => {
  render(<ToastProvider><Trigger /></ToastProvider>);
  fireEvent.press(screen.getByText('Delete'));
  expect(bottomOf()).toBe(34 + 140);
});

test('a screen with its own bottom bar puts the toast just above it', () => {
  render(<ToastProvider><Trigger claim={110} /></ToastProvider>);
  fireEvent.press(screen.getByText('Delete'));
  expect(bottomOf()).toBe(110);
});

test('the viewer pins it above its toolbar, whatever a screen claimed', () => {
  render(<ToastProvider onChrome bottom={200}><Trigger claim={110} /></ToastProvider>);
  fireEvent.press(screen.getByText('Delete'));
  expect(bottomOf()).toBe(200);
});

test('the action is tinted with the accent that reads on the inverse pill', () => {
  render(<ToastProvider><Trigger /></ToastProvider>);
  fireEvent.press(screen.getByText('Delete'));
  const color = StyleSheet.flatten(screen.getByText('Undo').props.style).color;
  expect(color).toBe(Colors.dark.accent);
});
