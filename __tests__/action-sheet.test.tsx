// components/action-sheet.tsx: ActionSheetIOS on iOS (unchanged), the app's
// own sheet on Android, where the native dialog dropped every option past
// the third.
import { ActionSheetIOS, Platform } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import {
  ActionSheet,
  ActionSheetHost,
  actionSheetCancelLabel,
  actionSheetDismissIndex,
  actionSheetRows,
} from '../components/action-sheet';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../components/lock-gate', () => ({ useAppLocked: () => false }));
jest.mock('../contexts/theme-context', () => {
  const { Colors } = jest.requireActual('../lib/theme');
  return {
    useTheme: () => ({ colors: Colors.light, isDark: false }),
    DarkThemeScope: ({ children }: { children: React.ReactNode }) => children,
  };
});

const FIVE = {
  title: 'Page 2',
  options: ['Rotate', 'Duplicate', 'Move', 'Extract', 'Delete', 'Cancel'],
  cancelButtonIndex: 5,
  destructiveButtonIndex: 4,
  disabledButtonIndices: [3],
};

describe('actionSheetRows', () => {
  it('lists every option but Cancel, in order, with its index', () => {
    const rows = actionSheetRows(FIVE);
    expect(rows.map(r => r.label)).toEqual(['Rotate', 'Duplicate', 'Move', 'Extract', 'Delete']);
    expect(rows.map(r => r.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('marks destructive (one index or several) and disabled options', () => {
    const rows = actionSheetRows(FIVE);
    expect(rows.filter(r => r.destructive).map(r => r.label)).toEqual(['Delete']);
    expect(rows.filter(r => r.disabled).map(r => r.label)).toEqual(['Extract']);
    const many = actionSheetRows({ options: ['A', 'B', 'C'], destructiveButtonIndex: [0, 2] });
    expect(many.map(r => r.destructive)).toEqual([true, false, true]);
  });

  it('keeps the index of options after a Cancel placed first', () => {
    const rows = actionSheetRows({ options: ['Cancel', 'Keep', 'Delete'], cancelButtonIndex: 0 });
    expect(rows.map(r => [r.label, r.index])).toEqual([['Keep', 1], ['Delete', 2]]);
  });

  it('carries optional icons, and none where not given', () => {
    const rows = actionSheetRows({ options: ['Call', 'Copy', 'Cancel'], cancelButtonIndex: 2, icons: ['call-outline'] });
    expect(rows.map(r => r.icon)).toEqual(['call-outline', undefined]);
  });
});

describe('cancel', () => {
  it('names the Cancel button, or none', () => {
    expect(actionSheetCancelLabel(FIVE)).toBe('Cancel');
    expect(actionSheetCancelLabel({ options: ['A'] })).toBeNull();
  });

  it('dismissing answers the cancel index, as ActionSheetIOS does (-1 without one)', () => {
    expect(actionSheetDismissIndex(FIVE)).toBe(5);
    expect(actionSheetDismissIndex({ options: ['A'] })).toBe(-1);
  });
});

describe('showActionSheetWithOptions', () => {
  const realOS = Platform.OS;
  afterEach(() => {
    Platform.OS = realOS;
    jest.restoreAllMocks();
  });

  it('on iOS hands the same options to ActionSheetIOS (no icons) and renders nothing', () => {
    Platform.OS = 'ios';
    const native = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    const cb = jest.fn();
    ActionSheet.showActionSheetWithOptions({ ...FIVE, icons: ['refresh-outline'] }, cb);
    expect(native).toHaveBeenCalledWith(FIVE, cb);
    render(<ActionSheetHost />);
    expect(screen.queryByText('Rotate')).toBeNull();
  });

  it('on Android shows every option and answers the chosen index once the sheet has gone', () => {
    jest.useFakeTimers();
    Platform.OS = 'android';
    const native = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    const cb = jest.fn();
    render(<ActionSheetHost />);
    act(() => {
      ActionSheet.showActionSheetWithOptions(FIVE, cb);
    });
    act(() => {
      jest.runAllTimers();
    });
    expect(native).not.toHaveBeenCalled();
    for (const label of ['Page 2', 'Rotate', 'Duplicate', 'Move', 'Extract', 'Delete', 'Cancel']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    fireEvent.press(screen.getByText('Move'));
    expect(cb).not.toHaveBeenCalled(); // not before the close animation
    act(() => {
      jest.runAllTimers();
    });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(2);
    expect(screen.queryByText('Rotate')).toBeNull();
    jest.useRealTimers();
  });

  it('on Android, Cancel answers the cancel index and queued sheets follow in turn', () => {
    jest.useFakeTimers();
    Platform.OS = 'android';
    const first = jest.fn();
    const second = jest.fn();
    render(<ActionSheetHost />);
    act(() => {
      ActionSheet.showActionSheetWithOptions({ options: ['One', 'Cancel'], cancelButtonIndex: 1 }, first);
      ActionSheet.showActionSheetWithOptions({ options: ['Two', 'Cancel'], cancelButtonIndex: 1 }, second);
    });
    act(() => {
      jest.runAllTimers();
    });
    expect(screen.queryByText('Two')).toBeNull();
    fireEvent.press(screen.getByText('Cancel'));
    act(() => {
      jest.runAllTimers();
    });
    expect(first).toHaveBeenCalledWith(1);
    expect(screen.getByText('Two')).toBeTruthy();
    fireEvent.press(screen.getByText('Two'));
    act(() => {
      jest.runAllTimers();
    });
    expect(second).toHaveBeenCalledWith(0);
    jest.useRealTimers();
  });
});
