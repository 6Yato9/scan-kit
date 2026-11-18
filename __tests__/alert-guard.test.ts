import { Alert } from 'react-native';
import { guardAlertButtons, installAlertGuard } from '../lib/alert-guard';

describe('guardAlertButtons', () => {
  test('a button pressed while locked does nothing; after unlocking it works', () => {
    let locked = true;
    const onDelete = jest.fn();
    const [cancel, del] = guardAlertButtons(
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: onDelete }],
      () => locked,
    ) as { text: string; onPress?: () => void }[];
    expect(cancel).toEqual({ text: 'Cancel', style: 'cancel' });
    expect(del.text).toBe('Delete');
    del.onPress!();
    expect(onDelete).not.toHaveBeenCalled();
    locked = false;
    del.onPress!();
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  test('a prompt callback is guarded too, and other values pass through', () => {
    let locked = true;
    const cb = jest.fn();
    const guarded = guardAlertButtons(cb, () => locked) as (v: string) => void;
    guarded('new name');
    expect(cb).not.toHaveBeenCalled();
    locked = false;
    guarded('new name');
    expect(cb).toHaveBeenCalledWith('new name');
    expect(guardAlertButtons(undefined, () => true)).toBeUndefined();
  });
});

describe('installAlertGuard', () => {
  test('patches Alert.alert once and always reads the latest lock state', () => {
    const native = jest.fn();
    (Alert as unknown as { alert: unknown }).alert = native;
    let a = true;
    installAlertGuard(() => a);
    // A second install (e.g. a reloaded module) only swaps the lock reader.
    let b = true;
    installAlertGuard(() => b);
    const onOk = jest.fn();
    Alert.alert('Title', 'Message', [{ text: 'OK', onPress: onOk }]);
    expect(native).toHaveBeenCalledTimes(1);
    const buttons = native.mock.calls[0][2] as { onPress: () => void }[];
    a = false; // the replaced reader no longer counts
    buttons[0].onPress();
    expect(onOk).not.toHaveBeenCalled();
    b = false;
    buttons[0].onPress();
    expect(onOk).toHaveBeenCalledTimes(1);
  });
});
