// lib/android-leave.ts: when App Lock locks on Android (components/lock-gate.tsx).
import { decideOnReturn, decideOnStop, HANDOFF_MAX_AWAY_MS } from '../lib/android-leave';

const base = { locked: false, authenticating: false, pickerOpen: false, handOffPending: false };

test('leaving the app (nothing handed off) locks', () => {
  expect(decideOnStop(base)).toBe('lock');
});

test('a picker or a marked hand-off (share, print, web page) does not lock', () => {
  expect(decideOnStop({ ...base, pickerOpen: true })).toBe('handoff');
  expect(decideOnStop({ ...base, handOffPending: true })).toBe('handoff');
});

test('our own unlock prompt taking the screen (API 26-29) is ignored', () => {
  expect(decideOnStop({ ...base, authenticating: true })).toBe('none');
  expect(decideOnStop({ ...base, locked: true, authenticating: true })).toBe('none');
});

test('leaving while already locked asks again on return, whatever is open', () => {
  expect(decideOnStop({ ...base, locked: true })).toBe('reprompt');
  expect(decideOnStop({ ...base, locked: true, pickerOpen: true })).toBe('reprompt');
});

test('a hand-off locks on return only once it lasted too long', () => {
  expect(decideOnReturn(null, 1e9)).toBe('stay');
  expect(decideOnReturn(1000, 1000 + HANDOFF_MAX_AWAY_MS)).toBe('stay');
  expect(decideOnReturn(1000, 1001 + HANDOFF_MAX_AWAY_MS)).toBe('lock');
});
