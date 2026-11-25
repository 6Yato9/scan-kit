// lib/review-prompt.ts
// Asking for an App Store / Google Play rating, now and then, at a good moment.
//
// The prompt is always the system's own (SKStoreReviewController on iOS, the
// Play In-App Review sheet on Android, via expo-store-review): no home-made
// "Do you like Scan Kit?" screen in front of it, which App Review rejects
// (guideline 5.6.1), and the system decides whether it really shows (Apple
// shows it at most 3 times a year; TestFlight and development builds never).
//
// When: right after something went well — a new document was saved (a scan,
// imported photos or a file) or an export finished (shared, saved to Photos,
// printed). Those are "wins"; recordWin() counts them. maybeAskForReview() is
// called at the same moments, a little later, and asks only when ALL of:
//   - the app was first opened at least MIN_DAYS_INSTALLED days ago (never on
//     the first day, never during onboarding);
//   - at least MIN_WINS wins since the last ask (so it follows real use);
//   - the last ask was at least MIN_DAYS_BETWEEN days ago;
//   - this app version hasn't asked yet;
//   - fewer than MAX_PER_YEAR asks in the past year;
//   - App Lock isn't covering the screen (it waits until unlocked).
// After an ask the win count starts again from zero.
//
// Settings › About › "Rate Scan Kit" opens the store's review page directly,
// for anyone who wants to rate without waiting.
//
// Everything is stored in one AsyncStorage key; a missing or unreadable value
// starts fresh. Nothing leaves the device.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as StoreReview from 'expo-store-review';
import Constants from 'expo-constants';
import { Linking, Platform } from 'react-native';
import { isAppLocked } from './nav-guard';

const KEY = '@scan_kit_review';
const DAY_MS = 24 * 60 * 60 * 1000;

export const REVIEW_RULES = {
  MIN_WINS: 3,
  MIN_DAYS_INSTALLED: 3,
  MIN_DAYS_BETWEEN: 90,
  MAX_PER_YEAR: 3,
} as const;

/** App Store id (App Store Connect → App Information → Apple ID) and Play package. */
const APP_STORE_ID = '6838487674';
const PLAY_PACKAGE = 'com.zerohorizon.scan';

export type ReviewState = {
  /** First time the app recorded anything (≈ install). */
  firstSeenAt: number;
  /** Wins since the last ask. */
  wins: number;
  /** When the system prompt was last requested, if ever. */
  lastAskedAt: number | null;
  /** App versions that have asked already. */
  askedVersions: string[];
  /** Times of every ask (pruned to the past year). */
  askTimes: number[];
};

export function freshState(now: number): ReviewState {
  return { firstSeenAt: now, wins: 0, lastAskedAt: null, askedVersions: [], askTimes: [] };
}

/** A stored value, made safe: anything malformed falls back to a fresh state. Pure. */
export function parseState(raw: string | null, now: number): ReviewState {
  if (!raw) return freshState(now);
  try {
    const v = JSON.parse(raw) as Partial<ReviewState>;
    const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
    return {
      firstSeenAt: num(v.firstSeenAt, now),
      wins: Math.max(0, Math.floor(num(v.wins, 0))),
      lastAskedAt: typeof v.lastAskedAt === 'number' && Number.isFinite(v.lastAskedAt) ? v.lastAskedAt : null,
      askedVersions: Array.isArray(v.askedVersions) ? v.askedVersions.filter((x): x is string => typeof x === 'string') : [],
      askTimes: Array.isArray(v.askTimes) ? v.askTimes.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : [],
    };
  } catch {
    return freshState(now);
  }
}

/** Whether now is a good time to ask. Pure. */
export function shouldAsk(s: ReviewState, now: number, version: string): boolean {
  const r = REVIEW_RULES;
  if (s.wins < r.MIN_WINS) return false;
  if (now - s.firstSeenAt < r.MIN_DAYS_INSTALLED * DAY_MS) return false;
  if (s.lastAskedAt !== null && now - s.lastAskedAt < r.MIN_DAYS_BETWEEN * DAY_MS) return false;
  if (s.askedVersions.includes(version)) return false;
  const pastYear = s.askTimes.filter(t => now - t < 365 * DAY_MS);
  if (pastYear.length >= r.MAX_PER_YEAR) return false;
  return true;
}

/** The state after asking. Pure. */
export function afterAsk(s: ReviewState, now: number, version: string): ReviewState {
  return {
    ...s,
    wins: 0,
    lastAskedAt: now,
    askedVersions: s.askedVersions.includes(version) ? s.askedVersions : [...s.askedVersions, version],
    askTimes: [...s.askTimes.filter(t => now - t < 365 * DAY_MS), now],
  };
}

function appVersion(): string {
  return Constants.expoConfig?.version ?? '0';
}

async function load(now: number): Promise<ReviewState> {
  try {
    return parseState(await AsyncStorage.getItem(KEY), now);
  } catch {
    return freshState(now);
  }
}

async function store(s: ReviewState): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Not worth bothering anyone about.
  }
}

// Calls are chained so two wins at once can't overwrite each other's count.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

/** Notes the first launch, so "installed N days ago" can be told. Call once at startup. */
export function noteAppOpened(): Promise<void> {
  return serial(async () => {
    const now = Date.now();
    const raw = await AsyncStorage.getItem(KEY).catch(() => null);
    if (!raw) await store(freshState(now));
  });
}

/** Something went well: a new document saved, an export finished. */
export function recordWin(): Promise<void> {
  return serial(async () => {
    const s = await load(Date.now());
    await store({ ...s, wins: s.wins + 1 });
  });
}

/**
 * Asks for a rating if the rules above allow it, after `delayMs` (so it never
 * lands on top of a closing sheet or a toast). `stillHere` is checked when the
 * delay is over: false (the user moved on, e.g. to the camera) skips this
 * moment and the next win tries again. App Lock skips it too. Never throws.
 */
export function maybeAskForReview(delayMs = 1200, stillHere: () => boolean = () => true): void {
  setTimeout(() => {
    serial(async () => {
      const now = Date.now();
      const version = appVersion();
      const s = await load(now);
      if (!shouldAsk(s, now, version)) return;
      if (isAppLocked() || !stillHere()) return;
      if (!(await StoreReview.isAvailableAsync().catch(() => false))) return;
      await store(afterAsk(s, Date.now(), version));
      await StoreReview.requestReview();
    }).catch(() => {});
  }, delayMs);
}

/** The store page where a review can be written. */
export function writeReviewUrl(): string {
  return Platform.OS === 'android'
    ? `market://details?id=${PLAY_PACKAGE}&showAllReviews=true`
    : `itms-apps://apps.apple.com/app/id${APP_STORE_ID}?action=write-review`;
}

/** Settings › About › Rate Scan Kit. Falls back to the web page when the store app can't open. */
export async function openStoreReviewPage(): Promise<boolean> {
  try {
    await Linking.openURL(writeReviewUrl());
    return true;
  } catch {
    const web = Platform.OS === 'android'
      ? `https://play.google.com/store/apps/details?id=${PLAY_PACKAGE}`
      : `https://apps.apple.com/app/id${APP_STORE_ID}?action=write-review`;
    try {
      await Linking.openURL(web);
      return true;
    } catch {
      return false;
    }
  }
}
