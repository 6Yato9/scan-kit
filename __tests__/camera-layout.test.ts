// lib/camera-layout.ts: geometry of the full-screen camera.
import {
  CAMERA_EDGE_MIN,
  CAMERA_CONTROLS,
  CAMERA_PILL_ROOM,
  CAMERA_TOP_ROW,
  aspectFillRect,
  cameraChromeLayout,
  centredFrame,
  flyTransform,
  quadScreenRect,
} from '@/lib/camera-layout';

const PHONE = { W: 402, H: 874 };
const PHONE_INSETS = { top: 62, bottom: 34, left: 0, right: 0 };

describe('aspectFillRect', () => {
  it('covers a tall phone with 3:4 frames: full height, sides cropped equally', () => {
    const r = aspectFillRect(3 / 4, PHONE.W, PHONE.H);
    expect(r.h).toBeCloseTo(874);
    expect(r.w).toBeCloseTo(655.5);
    expect(r.y).toBeCloseTo(0);
    expect(r.x).toBeCloseTo((402 - 655.5) / 2);
  });

  it('covers a landscape iPad with 4:3 frames: full width, top and bottom cropped', () => {
    const r = aspectFillRect(4 / 3, 1376, 1032 - 40);
    expect(r.w).toBeCloseTo(1376);
    expect(r.h).toBeCloseTo(1032);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo(-20);
  });

  it('is the view itself when the shapes match', () => {
    expect(aspectFillRect(0.75, 300, 400)).toEqual({ x: 0, y: 0, w: 300, h: 400 });
  });

  it('falls back to the view for a bad aspect', () => {
    expect(aspectFillRect(0, 300, 400)).toEqual({ x: 0, y: 0, w: 300, h: 400 });
    expect(aspectFillRect(NaN, 300, 400)).toEqual({ x: 0, y: 0, w: 300, h: 400 });
  });
});

describe('quadScreenRect', () => {
  it('maps a centred page to the centre of the screen', () => {
    const q = [0.25, 0.2, 0.75, 0.2, 0.75, 0.8, 0.25, 0.8];
    const r = quadScreenRect(q, 3 / 4, PHONE.W, PHONE.H)!;
    const fill = aspectFillRect(3 / 4, PHONE.W, PHONE.H);
    expect(r.x).toBeCloseTo(fill.x + 0.25 * fill.w);
    expect(r.w).toBeCloseTo(0.5 * fill.w);
    expect(r.y).toBeCloseTo(0.2 * 874);
    expect(r.h).toBeCloseTo(0.6 * 874);
    expect(r.x + r.w / 2).toBeCloseTo(201);
  });

  it('clips a page that runs off the cropped sides', () => {
    const q = [0, 0.1, 1, 0.1, 1, 0.9, 0, 0.9];
    const r = quadScreenRect(q, 3 / 4, PHONE.W, PHONE.H)!;
    expect(r.x).toBe(0);
    expect(r.w).toBe(402);
  });

  it('takes the bounding box of a tilted outline', () => {
    const q = [0.3, 0.1, 0.9, 0.2, 0.7, 0.9, 0.1, 0.8];
    const r = quadScreenRect(q, 1, 100, 100, 1)!;
    expect(r).toEqual({ x: 10, y: 10, w: 80, h: 80 });
  });

  it('is null without an outline, for garbage, or when too little is on screen', () => {
    expect(quadScreenRect(null, 0.75, 402, 874)).toBeNull();
    expect(quadScreenRect([1, 2, 3], 0.75, 402, 874)).toBeNull();
    expect(quadScreenRect([0, 0, NaN, 0, 1, 1, 0, 1], 0.75, 402, 874)).toBeNull();
    // Entirely in the strip cropped off the left edge.
    expect(quadScreenRect([0, 0.2, 0.1, 0.2, 0.1, 0.8, 0, 0.8], 3 / 4, 402, 874)).toBeNull();
  });
});

describe('flyTransform', () => {
  it('moves centre to centre and fits inside the target', () => {
    const t = flyTransform({ x: 0, y: 0, w: 400, h: 800 }, { x: 26, y: 760, w: 48, h: 64 });
    expect(t.dx).toBe(50 - 200);
    expect(t.dy).toBe(792 - 400);
    expect(t.scale).toBeCloseTo(0.08); // 64 / 800: the height limits
  });

  it('keeps a degenerate source at scale 1', () => {
    expect(flyTransform({ x: 0, y: 0, w: 0, h: 10 }, { x: 0, y: 0, w: 10, h: 10 }).scale).toBe(1);
  });
});

describe('cameraChromeLayout', () => {
  it('floats the rows inside the safe area of a phone', () => {
    const l = cameraChromeLayout(PHONE.W, PHONE.H, PHONE_INSETS);
    expect(l.topRowY).toBeGreaterThanOrEqual(62);
    expect(l.pillY).toBeGreaterThanOrEqual(l.topRowY + CAMERA_TOP_ROW);
    expect(l.controlsY + CAMERA_CONTROLS).toBe(874 - 34);
    expect(l.middle.y).toBe(l.pillY + CAMERA_PILL_ROOM);
    expect(l.middle.y + l.middle.h).toBe(l.controlsY);
    expect(l.padLeft).toBe(16);
  });

  it('keeps a minimum bottom gap without a home indicator, and adds side insets', () => {
    const l = cameraChromeLayout(1032, 1376, { top: 24, bottom: 0, left: 10, right: 20 });
    expect(l.controlsY).toBe(1376 - CAMERA_EDGE_MIN - CAMERA_CONTROLS);
    expect(cameraChromeLayout(1032, 1376, { top: 0, bottom: 0, left: 0, right: 0 }).topRowY).toBeGreaterThanOrEqual(CAMERA_EDGE_MIN);
    expect(l.padLeft).toBe(26);
    expect(l.padRight).toBe(36);
    expect(l.middle.w).toBe(1032 - 26 - 36);
  });

  it('never yields a negative middle on a tiny window', () => {
    const l = cameraChromeLayout(300, 200, PHONE_INSETS);
    expect(l.middle.h).toBe(0);
  });
});

describe('centredFrame', () => {
  it('fits a card frame by width in a tall area', () => {
    const f = centredFrame({ x: 16, y: 180, w: 370, h: 560 }, 85.6 / 54, 0.85);
    expect(f.w).toBeCloseTo(370 * 0.85);
    expect(f.x + f.w / 2).toBeCloseTo(201);
    expect(f.y + f.h / 2).toBeCloseTo(460);
  });

  it('fits by height in a wide, short area', () => {
    const f = centredFrame({ x: 0, y: 0, w: 1000, h: 200 }, 1.5, 0.8);
    expect(f.h).toBeCloseTo(160);
    expect(f.w).toBeCloseTo(240);
  });
});
