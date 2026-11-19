// components/use-remembered-prefs.ts: a tap made before the remembered
// choices load is never reverted by them, and they are re-read when a sheet is
// shown again.
import { Pressable, Text } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useRememberedPrefs } from '../components/use-remembered-prefs';

type P = { mode: string; every: number };
const DEFAULTS: P = { mode: 'at', every: 2 };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function Screen({ load, save, active }: { load: () => Promise<P>; save: (p: P) => void; active?: boolean }) {
  const [p, update, latest] = useRememberedPrefs(DEFAULTS, load, save, { active });
  return (
    <>
      <Text testID="value">{`${p.mode}/${p.every}`}</Text>
      <Pressable testID="every" onPress={() => update({ mode: 'every' })} />
      <Pressable testID="latest" onPress={() => save({ ...latest(), mode: `latest:${latest().mode}` })} />
    </>
  );
}

test('a choice made before the stored ones arrive wins; the rest still load; the merge is saved', async () => {
  const d = deferred<P>();
  const save = jest.fn();
  render(<Screen load={() => d.promise} save={save} />);
  expect(screen.getByTestId('value').props.children).toBe('at/2');
  fireEvent.press(screen.getByTestId('every'));
  expect(screen.getByTestId('value').props.children).toBe('every/2');
  // Not written yet: that would store the default `every` over the remembered one.
  expect(save).not.toHaveBeenCalled();
  await act(async () => { d.resolve({ mode: 'ranges', every: 7 }); });
  expect(screen.getByTestId('value').props.children).toBe('every/7');
  expect(save).toHaveBeenCalledWith({ mode: 'every', every: 7 });
});

test('untouched: the stored choices show, nothing is written; later choices are written at once', async () => {
  const save = jest.fn();
  render(<Screen load={async () => ({ mode: 'ranges', every: 4 })} save={save} />);
  await act(async () => {});
  expect(screen.getByTestId('value').props.children).toBe('ranges/4');
  expect(save).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId('every'));
  expect(save).toHaveBeenLastCalledWith({ mode: 'every', every: 4 });
  // latest() is the newest choice, without waiting for a render.
  fireEvent.press(screen.getByTestId('latest'));
  expect(save).toHaveBeenLastCalledWith({ mode: 'latest:every', every: 4 });
});

test('inactive (a hidden sheet): not read; read again each time it is shown', async () => {
  const load = jest.fn(async () => ({ mode: 'ranges', every: 3 }));
  const save = jest.fn();
  const { rerender } = render(<Screen load={load} save={save} active={false} />);
  await act(async () => {});
  expect(load).not.toHaveBeenCalled();
  rerender(<Screen load={load} save={save} active />);
  await act(async () => {});
  expect(load).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('value').props.children).toBe('ranges/3');
  rerender(<Screen load={load} save={save} active={false} />);
  rerender(<Screen load={load} save={save} active />);
  await act(async () => {});
  expect(load).toHaveBeenCalledTimes(2);
});
