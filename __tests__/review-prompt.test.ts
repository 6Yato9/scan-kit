import { afterAsk, freshState, parseState, REVIEW_RULES, shouldAsk, type ReviewState } from '../lib/review-prompt';

jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(), setItem: jest.fn() }));
jest.mock('../lib/nav-guard', () => ({ isAppLocked: () => false }));
jest.mock('expo-store-review', () => ({ isAvailableAsync: jest.fn(), requestReview: jest.fn() }));
jest.mock('expo-constants', () => ({ expoConfig: { version: '1.0.0' } }));

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1);

function ready(over: Partial<ReviewState> = {}): ReviewState {
  return { ...freshState(T0), wins: REVIEW_RULES.MIN_WINS, ...over };
}
const later = T0 + REVIEW_RULES.MIN_DAYS_INSTALLED * DAY;

describe('shouldAsk', () => {
  it('asks once there are enough wins and the app is a few days old', () => {
    expect(shouldAsk(ready(), later, '1.0.0')).toBe(true);
  });

  it('never in the first days', () => {
    expect(shouldAsk(ready(), later - 1, '1.0.0')).toBe(false);
  });

  it('needs enough wins', () => {
    expect(shouldAsk(ready({ wins: REVIEW_RULES.MIN_WINS - 1 }), later, '1.0.0')).toBe(false);
  });

  it('waits between asks', () => {
    const s = ready({ lastAskedAt: later - (REVIEW_RULES.MIN_DAYS_BETWEEN - 1) * DAY });
    expect(shouldAsk(s, later, '1.1.0')).toBe(false);
    expect(shouldAsk(s, later + 2 * DAY, '1.1.0')).toBe(true);
  });

  it('asks at most once per app version', () => {
    expect(shouldAsk(ready({ askedVersions: ['1.0.0'] }), later, '1.0.0')).toBe(false);
    expect(shouldAsk(ready({ askedVersions: ['1.0.0'] }), later, '1.1.0')).toBe(true);
  });

  it('caps asks per year', () => {
    const times = [later - 300 * DAY, later - 200 * DAY, later - 100 * DAY];
    expect(shouldAsk(ready({ askTimes: times }), later, '2.0.0')).toBe(false);
    // The oldest falls out of the year.
    expect(shouldAsk(ready({ askTimes: times }), later + 70 * DAY, '2.0.0')).toBe(true);
  });
});

describe('afterAsk', () => {
  it('starts the win count again and remembers the ask', () => {
    const s = afterAsk(ready({ wins: 7 }), later, '1.0.0');
    expect(s.wins).toBe(0);
    expect(s.lastAskedAt).toBe(later);
    expect(s.askedVersions).toEqual(['1.0.0']);
    expect(s.askTimes).toEqual([later]);
    expect(shouldAsk({ ...s, wins: 10 }, later + DAY, '1.0.0')).toBe(false);
  });

  it('drops ask times older than a year', () => {
    const s = afterAsk(ready({ askTimes: [later - 400 * DAY] }), later, '1.0.0');
    expect(s.askTimes).toEqual([later]);
  });
});

describe('parseState', () => {
  it('starts fresh with nothing stored or something unreadable', () => {
    expect(parseState(null, T0)).toEqual(freshState(T0));
    expect(parseState('{nope', T0)).toEqual(freshState(T0));
  });

  it('keeps good fields and repairs bad ones', () => {
    const s = parseState(JSON.stringify({ firstSeenAt: 5, wins: -3, lastAskedAt: 'x', askedVersions: ['1', 2], askTimes: [1, 'a'] }), T0);
    expect(s).toEqual({ firstSeenAt: 5, wins: 0, lastAskedAt: null, askedVersions: ['1'], askTimes: [1] });
  });
});
