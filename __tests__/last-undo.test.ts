// lib/last-undo.ts: the viewer's last Undo stays in its "…" menu until the
// next edit or until the viewer closes (r12 product #5), the toast and the
// menu share one single-use action, and the copy behind it is released only
// once nobody can use it.
import { LastUndo, RELEASE_GRACE_MS, undoAwareToast, undoLabelFor } from '../lib/last-undo';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('labels name the change', () => {
  expect(undoLabelFor('Page 3 deleted')).toBe('Undo delete page 3');
  expect(undoLabelFor('Page cropped')).toBe('Undo crop');
  expect(undoLabelFor('Page 2 replaced')).toBe('Undo retake page 2');
  expect(undoLabelFor('Page 1 rotated')).toBe('Undo rotate page 1');
  expect(undoLabelFor('Blank page added after page 2')).toBe('Undo blank page');
  expect(undoLabelFor('Signed page 1')).toBe('Undo signature');
  expect(undoLabelFor('Watermark added to 3 pages')).toBe('Undo watermark');
  expect(undoLabelFor('Timestamp added')).toBe('Undo timestamp');
  expect(undoLabelFor('Redacted 2 pages')).toBe('Undo redaction');
  expect(undoLabelFor('No shadow applied to all 3 pages')).toBe('Undo apply to all');
  expect(undoLabelFor('Converted to 4 pages')).toBe('Undo convert to pages');
  expect(undoLabelFor('Something new')).toBe('Undo last change');
});

test('the offer stays until used, and runs once whether from the toast or the menu', () => {
  const slot = new LastUndo();
  const run = jest.fn();
  const toastAction = slot.offer('Page 2 deleted', run);
  jest.advanceTimersByTime(10 * 60_000);
  expect(slot.current()?.label).toBe('Undo delete page 2');
  expect(slot.runCurrent()).toBe(true);
  expect(slot.current()).toBeNull();
  toastAction();
  expect(slot.runCurrent()).toBe(false);
  expect(run).toHaveBeenCalledTimes(1);
});

test('the toast button ends the menu offer too', () => {
  const slot = new LastUndo();
  const run = jest.fn();
  const toastAction = slot.offer('Page cropped', run);
  toastAction();
  expect(slot.current()).toBeNull();
  expect(run).toHaveBeenCalledTimes(1);
});

test('a newer offer replaces the older one; the older copy is released after the toast grace', () => {
  const slot = new LastUndo();
  const releaseA = jest.fn();
  const runA = jest.fn();
  const toastA = slot.offer('Signed', runA, releaseA);
  slot.offer('Page 1 deleted', jest.fn());
  expect(slot.current()?.message).toBe('Page 1 deleted');
  // The first toast may still be on screen: its button still works for now.
  expect(releaseA).not.toHaveBeenCalled();
  jest.advanceTimersByTime(RELEASE_GRACE_MS);
  expect(releaseA).toHaveBeenCalledTimes(1);
  toastA();
  expect(runA).not.toHaveBeenCalled();
});

test('drop (the next edit) hides the row at once; a toast press within the grace still works and releases nothing', () => {
  const slot = new LastUndo();
  const release = jest.fn();
  const run = jest.fn();
  const toastAction = slot.offer('Watermark added', run, release);
  const seen = jest.fn();
  slot.subscribe(seen);
  slot.drop();
  expect(slot.current()).toBeNull();
  expect(seen).toHaveBeenCalled();
  toastAction();
  expect(run).toHaveBeenCalledTimes(1);
  jest.runAllTimers();
  expect(release).not.toHaveBeenCalled();
});

test('dispose (the viewer closes) releases the current and any dropped copies now', () => {
  const slot = new LastUndo();
  const r1 = jest.fn();
  const r2 = jest.fn();
  slot.offer('Signed', jest.fn(), r1);
  slot.offer('Redacted', jest.fn(), r2);
  slot.dispose();
  expect(r1).toHaveBeenCalledTimes(1);
  expect(r2).toHaveBeenCalledTimes(1);
  jest.runAllTimers();
  expect(r1).toHaveBeenCalledTimes(1);
  // Offers made after that are dead on arrival.
  const r3 = jest.fn();
  const run3 = jest.fn();
  slot.offer('Signed', run3, r3)();
  expect(r3).toHaveBeenCalledTimes(1);
  expect(run3).not.toHaveBeenCalled();
});

test('undoAwareToast: Undo toasts are long, held, and offered in the menu; others pass through', () => {
  const shown: any[] = [];
  const base = { show: (m: string, o?: any) => shown.push([m, o]) };
  const slot = new LastUndo();
  const release = jest.fn();
  const hold = jest.fn(() => release);
  const toast = undoAwareToast(base, slot);
  const onPress = jest.fn();
  toast.show('Page 2 deleted', { action: { label: 'Undo', onPress }, hold });
  expect(hold).toHaveBeenCalledTimes(1);
  expect(shown[0][1].long).toBe(true);
  expect(slot.current()?.label).toBe('Undo delete page 2');
  toast.show('Saved', { action: { label: 'Open', onPress: jest.fn() } });
  expect(shown[1][1].long).toBeUndefined();
  expect(slot.current()?.label).toBe('Undo delete page 2');
  shown[0][1].action.onPress();
  expect(onPress).toHaveBeenCalledTimes(1);
  slot.dispose();
  expect(release).not.toHaveBeenCalled();
});

test('undoAwareToast holds a copy the toast does not know about (a PDF edit stash)', () => {
  const slot = new LastUndo();
  const release = jest.fn();
  const toast = undoAwareToast({ show: () => {} }, slot, () => release);
  toast.show('Page 1 rotated', { action: { label: 'Undo', onPress: jest.fn() } });
  slot.dispose();
  expect(release).toHaveBeenCalledTimes(1);
});

test('activate after dispose (an effect run twice in development) takes offers again', () => {
  const slot = new LastUndo();
  slot.dispose();
  slot.activate();
  const run = jest.fn();
  slot.offer('Page cropped', run);
  expect(slot.current()?.label).toBe('Undo crop');
  slot.runCurrent();
  expect(run).toHaveBeenCalledTimes(1);
});

test('the snapshot is stable between changes and follows the offer', () => {
  const slot = new LastUndo();
  expect(slot.getSnapshot()).toBeNull();
  slot.offer('Page 2 deleted', jest.fn());
  const a = slot.getSnapshot();
  expect(a?.label).toBe('Undo delete page 2');
  expect(slot.getSnapshot()).toBe(a);
  slot.drop();
  expect(slot.getSnapshot()).toBeNull();
});

test('merge Undo gets its own menu label (r13)', () => {
  expect(undoLabelFor('Added 3 pages from “Lease”')).toBe('Undo merge');
  expect(undoLabelFor('Added 1 page to “Invoice”')).toBe('Undo merge');
  expect(undoLabelFor('Merged into a new PDF')).toBe('Undo merge');
  expect(undoLabelFor('Merged 2 documents. The originals are kept.')).toBe('Undo merge');
});
