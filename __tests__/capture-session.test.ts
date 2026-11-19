// lib/capture-session.ts: the bridge between callers that await a scan and
// the camera route, plus the geometry of captured pages.
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

import {
  CARD_ASPECT,
  CLAIM_TIMEOUT_MS,
  cameraPausedMessage,
  cameraStatus,
  captureSubject,
  cardSide,
  claimCaptureSession,
  endCaptureSession,
  initialGeometry,
  isCaptureSessionOpen,
  openCaptureSession,
  quadArea,
  quadPoint,
  resetCaptureSessionsForTests,
  setCaptureResult,
  splitSpread,
  toSourceInput,
  type CapturedPage,
} from '../lib/capture-session';
import { geometryOfInput } from '../lib/page-source';
import { resetNavGuardForTests, setNavLockState } from '../lib/nav-guard';
import { FULL_QUAD, rotateGeometry, warpOutputSize } from '../lib/quad';

jest.mock('../lib/page-source', () => {
  const quad = jest.requireActual('../lib/quad');
  return {
    // Same as the real one (which needs native modules to import).
    geometryOfInput: (p: { quad: number[] | null; rotation?: number }) =>
      quad.rotateGeometry({ quad: p.quad ?? [...quad.FULL_QUAD], rotation: 0 }, p.rotation ?? 0),
  };
});

const page = (key: string): CapturedPage => ({
  key,
  sourceUri: `file:///c/scanner-src/${key}.jpg`,
  width: 3000,
  height: 4000,
  geometry: { quad: [...FULL_QUAD], rotation: 0 },
  detected: false,
  previewUri: null,
});

beforeEach(() => {
  jest.useFakeTimers();
  resetCaptureSessionsForTests();
  resetNavGuardForTests();
});
afterEach(() => jest.useRealTimers());

describe('sessions', () => {
  test('presents the camera, resolves with the saved pages once the screen has gone', async () => {
    const present = jest.fn();
    const done = openCaptureSession({ maxPages: 1, doneLabel: 'Replace' }, present);
    expect(present).toHaveBeenCalledTimes(1);
    const id = present.mock.calls[0][0];
    expect(isCaptureSessionOpen()).toBe(true);
    expect(claimCaptureSession(id)).toEqual({ maxPages: 1, doneLabel: 'Replace' });
    setCaptureResult(id, [page('a')]);
    expect(endCaptureSession(id)?.map(p => p.key)).toEqual(['a']);
    await expect(done).resolves.toEqual([page('a')]);
    expect(isCaptureSessionOpen()).toBe(false);
  });

  test('closing without saving resolves null', async () => {
    const present = jest.fn();
    const done = openCaptureSession({}, present);
    const id = present.mock.calls[0][0];
    claimCaptureSession(id);
    expect(endCaptureSession(id)).toBeNull();
    await expect(done).resolves.toBeNull();
  });

  test('one session at a time; a second request resolves null at once', async () => {
    const present = jest.fn();
    openCaptureSession({}, present);
    await expect(openCaptureSession({}, present)).resolves.toBeNull();
    expect(present).toHaveBeenCalledTimes(1);
  });

  test('a screen that never claims the session gives up after the timeout', async () => {
    const done = openCaptureSession({}, jest.fn());
    jest.advanceTimersByTime(CLAIM_TIMEOUT_MS + 1);
    await expect(done).resolves.toBeNull();
    expect(isCaptureSessionOpen()).toBe(false);
  });

  test('unknown or stale ids are refused', () => {
    const present = jest.fn();
    openCaptureSession({}, present);
    expect(claimCaptureSession('nope')).toBeNull();
    expect(claimCaptureSession(undefined)).toBeNull();
    expect(endCaptureSession('nope')).toBeNull();
    expect(isCaptureSessionOpen()).toBe(true);
  });

  test('while the app is locked the camera is presented only after unlocking', async () => {
    setNavLockState({ locked: true });
    const present = jest.fn();
    openCaptureSession({}, present);
    expect(present).not.toHaveBeenCalled();
    setNavLockState({ locked: false });
    jest.advanceTimersByTime(1000);
    expect(present).toHaveBeenCalledTimes(1);
  });
});

describe('geometry', () => {
  const q = [0.1, 0.12, 0.88, 0.1, 0.9, 0.85, 0.08, 0.9];

  test('initialGeometry keeps a detected outline and falls back to the whole photo', () => {
    expect(initialGeometry(q)).toEqual({ geometry: { quad: q, rotation: 0 }, detected: true });
    expect(initialGeometry(null)).toEqual({ geometry: { quad: FULL_QUAD, rotation: 0 }, detected: false });
    // Counter-clockwise (mirrored) is not a page outline.
    expect(initialGeometry([0, 0, 0, 1, 1, 1, 1, 0]).detected).toBe(false);
  });

  test('toSourceInput round-trips through the save path for every turn', () => {
    for (const deg of [0, 90, 180, 270]) {
      const g = rotateGeometry({ quad: q, rotation: 0 }, deg);
      const input = toSourceInput('file:///x.jpg', g);
      expect(input.rotation).toBe(deg);
      expect(input.quad).toEqual(q);
      expect(geometryOfInput(input)).toEqual(g);
    }
  });

  test('quadPoint maps the unit square onto the quad', () => {
    const p = quadPoint(q, 0, 0);
    expect(p.x).toBeCloseTo(0.1);
    expect(p.y).toBeCloseTo(0.12);
    const r = quadPoint(q, 1, 1);
    expect(r.x).toBeCloseTo(0.9);
    expect(r.y).toBeCloseTo(0.85);
    // A rectangle: plain interpolation.
    const m = quadPoint([0.2, 0.2, 0.8, 0.2, 0.8, 0.6, 0.2, 0.6], 0.5, 1);
    expect(m.x).toBeCloseTo(0.5);
    expect(m.y).toBeCloseTo(0.6);
  });

  test('quadPoint follows perspective: the middle of a receding page is nearer its far edge', () => {
    // Top edge far away (short), bottom edge close (long): the page's true
    // vertical middle lies above the halfway point on the photo.
    const trapezoid = [0.35, 0.1, 0.65, 0.1, 0.95, 0.9, 0.05, 0.9];
    expect(quadPoint(trapezoid, 0.5, 0.5).y).toBeLessThan(0.5);
  });

  test('splitSpread cuts a landscape page in two and leaves a portrait page alone', () => {
    const spread = { quad: [0.05, 0.3, 0.95, 0.3, 0.95, 0.7, 0.05, 0.7], rotation: 0 as const };
    const halves = splitSpread(spread, 3000, 4000);
    expect(halves).toHaveLength(2);
    expect(halves[0].quad).toEqual([0.05, 0.3, 0.5, 0.3, 0.5, 0.7, 0.05, 0.7].map(n => expect.closeTo(n, 6)));
    expect(halves[1].quad).toEqual([0.5, 0.3, 0.95, 0.3, 0.95, 0.7, 0.5, 0.7].map(n => expect.closeTo(n, 6)));
    for (const h of halves) {
      const out = warpOutputSize(h.quad, 3000, 4000);
      expect(out.height).toBeGreaterThan(out.width);
    }
    expect(splitSpread({ quad: q, rotation: 0 }, 3000, 4000)).toHaveLength(1);
  });

  test('splitSpread works in the turned frame', () => {
    // A tall strip of the photo, turned a quarter: a landscape page.
    const g = rotateGeometry({ quad: [0.3, 0.05, 0.7, 0.05, 0.7, 0.95, 0.3, 0.95], rotation: 0 }, 90);
    const halves = splitSpread(g, 3000, 4000);
    expect(halves).toHaveLength(2);
    expect(halves.every(h => h.rotation === 90)).toBe(true);
  });

  test('quadArea', () => {
    expect(quadArea(FULL_QUAD)).toBeCloseTo(1);
    expect(quadArea([0.25, 0.25, 0.75, 0.25, 0.75, 0.75, 0.25, 0.75])).toBeCloseTo(0.25);
  });
});

describe('cameraStatus', () => {
  const base = { quad: null, stability: 0, autoCapture: true, capturing: false, justCaptured: null };
  const page = [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9];

  test('says what the camera needs', () => {
    expect(cameraStatus(base)).toBe('Looking for a page');
    expect(cameraStatus({ ...base, guidance: 'Fit the open book in the frame' })).toBe('Fit the open book in the frame');
    expect(cameraStatus({ ...base, quad: [0.4, 0.4, 0.6, 0.4, 0.6, 0.6, 0.4, 0.6] })).toBe('Move closer');
    expect(cameraStatus({ ...base, quad: page })).toBe('Hold still');
    expect(cameraStatus({ ...base, quad: page, autoCapture: false })).toBe('Page found – tap the shutter');
    expect(cameraStatus({ ...base, quad: page, capturing: true })).toBe('Capturing…');
    expect(cameraStatus({ ...base, quad: page, justCaptured: 2 })).toBe('Page 2 captured – show the next one');
    expect(cameraStatus({ ...base, quad: page, justCaptured: 2, autoCapture: false })).toBe('Page 2 captured');
  });

  test('one phrase each, never a closing period', () => {
    const inputs = [
      base,
      { ...base, quad: page },
      { ...base, quad: page, autoCapture: false },
      { ...base, quad: page, justCaptured: 3 },
      { ...base, quad: page, justCaptured: 1, subject: 'card' as const, side: 'back' as const },
      { ...base, paused: true },
    ];
    for (const i of inputs) expect(cameraStatus(i)).not.toMatch(/\.$/);
  });

  test('names the subject: a card is not a page', () => {
    expect(cameraStatus({ ...base, subject: 'card' })).toBe('Looking for a card');
    expect(cameraStatus({ ...base, subject: 'card', guidance: 'Fit the whole card in the frame' })).toBe('Fit the whole card in the frame');
    expect(cameraStatus({ ...base, quad: page, autoCapture: false, subject: 'card' })).toBe('Card found – tap the shutter');
    expect(cameraStatus({ ...base, quad: page, justCaptured: 1, subject: 'card' })).toBe('Card captured');
    expect(cameraStatus({ ...base, quad: page, autoCapture: false, subject: 'board' })).toBe('Board found – tap the shutter');
  });

  test('a two-sided card asks for the front, then the back', () => {
    expect(cameraStatus({ ...base, subject: 'card', side: 'front', guidance: 'Fit the front of the card in the frame' }))
      .toBe('Fit the front of the card in the frame');
    expect(cameraStatus({ ...base, quad: page, justCaptured: 1, subject: 'card', side: 'back' })).toBe('Front captured – turn the card over');
    expect(cameraStatus({ ...base, subject: 'card', side: 'back' })).toBe('Fit the back of the card in the frame');
  });

  test('a paused camera says so before anything else', () => {
    expect(cameraStatus({ ...base, quad: page, capturing: true, paused: true })).toBe('Camera paused');
  });
});

describe('captureSubject / cardSide', () => {
  test('infers the subject from the tools’ titles and guidance', () => {
    expect(captureSubject(null)).toBe('page');
    expect(captureSubject({})).toBe('page');
    expect(captureSubject({ title: 'Business card', maxPages: 1, guidance: 'Fit the whole card in the frame' })).toBe('card');
    expect(captureSubject({ title: 'ID card', maxPages: 2 })).toBe('card');
    expect(captureSubject({ title: 'Back of card', maxPages: 1 })).toBe('card');
    expect(captureSubject({ title: 'Whiteboard', guidance: 'Fit the whole board in the frame' })).toBe('board');
    expect(captureSubject({ title: 'Book mode', guidance: 'Fit the open book in the frame' })).toBe('book');
    expect(captureSubject({ title: 'Retake page 2', maxPages: 1 })).toBe('page');
    expect(captureSubject({ title: 'Cardiff lease', subject: 'page' })).toBe('page');
    expect(captureSubject({ title: 'Scorecards' })).toBe('page');
  });

  test('only the two-capture card session has sides', () => {
    const id = { title: 'ID card', maxPages: 2 };
    expect(cardSide(id, 0)).toBe('front');
    expect(cardSide(id, 1)).toBe('back');
    expect(cardSide(id, 2, 0)).toBe('front'); // retaking the front
    expect(cardSide(id, 2, 1)).toBe('back');
    expect(cardSide({ title: 'Business card', maxPages: 1 }, 0)).toBeUndefined();
    expect(cardSide({ title: 'Book mode' }, 0)).toBeUndefined();
    expect(cardSide({ title: 'Passport', maxPages: 2, twoSided: true, subject: 'card' }, 1)).toBe('back');
    expect(cardSide({ title: 'ID card', maxPages: 2, twoSided: false }, 0)).toBeUndefined();
  });

  test('the card guide has ID-1 proportions', () => {
    expect(CARD_ASPECT).toBeCloseTo(1.585, 3);
  });
});

describe('cameraPausedMessage', () => {
  test('explains each reason, with a fallback', () => {
    expect(cameraPausedMessage('multitasking').title).toBe('Camera unavailable in Split View');
    expect(cameraPausedMessage('multitasking').text).toMatch(/full screen/);
    expect(cameraPausedMessage('in-use').title).toBe('Camera in use');
    expect(cameraPausedMessage('pressure').text).toMatch(/too warm/);
    expect(cameraPausedMessage(undefined)).toEqual(cameraPausedMessage('other'));
    for (const r of ['in-use', 'multitasking', 'pressure', 'other']) {
      const m = cameraPausedMessage(r);
      expect(m.text).toMatch(/\.$/); // body copy is full sentences
      expect(m.title).not.toMatch(/\.$/);
    }
  });
});

describe('new page after the review', () => {
  test('maxCornerDelta measures the farthest corner move', async () => {
    const { maxCornerDelta, NEW_PAGE_DELTA } = jest.requireActual('../lib/capture-session');
    const a = [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9];
    expect(maxCornerDelta(a, a)).toBe(0);
    const moved = [...a];
    moved[4] = 0.95; // bottom-right x
    expect(maxCornerDelta(a, moved)).toBeCloseTo(0.05);
    expect(maxCornerDelta(a, moved)).toBeLessThan(NEW_PAGE_DELTA);
    expect(maxCornerDelta(a, [0.3, 0.3, 0.9, 0.3, 0.9, 0.9, 0.3, 0.9])).toBeGreaterThan(NEW_PAGE_DELTA);
  });
});
