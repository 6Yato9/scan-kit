// Remembered choices never overwrite a choice made before they arrive
// (lib/remembered-prefs.ts, behind components/use-remembered-prefs.ts, used
// by Split, Compress, Erase marks, Long image, Book mode, Whiteboard, ID card,
// Extract text, the export sheet and Create PDF).
import { RememberedPrefs } from '../lib/remembered-prefs';

type P = { mode: string; every: number; searchable: boolean };
const DEFAULTS: P = { mode: 'at', every: 2, searchable: true };
const STORED: P = { mode: 'ranges', every: 5, searchable: false };

describe('RememberedPrefs', () => {
  test('nothing touched: the stored choices replace the defaults, nothing written back', () => {
    const r = new RememberedPrefs(DEFAULTS);
    const t = r.begin();
    expect(r.arrive(t, STORED)).toEqual({ value: STORED, save: false });
    expect(r.value).toEqual(STORED);
  });

  test('a choice made before they arrive wins, the other stored fields still load, and the merge is written', () => {
    const r = new RememberedPrefs(DEFAULTS);
    const t = r.begin();
    // The user taps "Every N pages" in the first few milliseconds…
    expect(r.change({ mode: 'every' })).toEqual({ value: { ...DEFAULTS, mode: 'every' }, save: false });
    // …and is not written yet: that would store the default `every` over the remembered 5.
    const got = r.arrive(t, STORED);
    expect(got).toEqual({ value: { mode: 'every', every: 5, searchable: false }, save: true });
    expect(r.value.mode).toBe('every');
  });

  test('several early choices all stick; later ones are written at once', () => {
    const r = new RememberedPrefs(DEFAULTS);
    const t = r.begin();
    r.change({ every: 3 });
    r.change({ searchable: true });
    expect(r.arrive(t, STORED)!.value).toEqual({ mode: 'ranges', every: 3, searchable: true });
    expect(r.change({ mode: 'at' })).toEqual({ value: { mode: 'at', every: 3, searchable: true }, save: true });
  });

  test('a late answer from an earlier read is ignored (a sheet closed and opened again)', () => {
    const r = new RememberedPrefs(DEFAULTS);
    const first = r.begin();
    const second = r.begin();
    expect(r.arrive(first, STORED)).toBeNull();
    expect(r.value).toEqual(DEFAULTS);
    r.change({ every: 9 });
    expect(r.arrive(second, STORED)!.value).toEqual({ ...STORED, every: 9 });
    // Arriving twice changes nothing.
    expect(r.arrive(second, DEFAULTS)).toBeNull();
    expect(r.value.every).toBe(9);
  });

  test('reading again (the sheet shown again) loads fresh, keeping only what is chosen during that read', () => {
    const r = new RememberedPrefs(DEFAULTS);
    r.arrive(r.begin(), STORED);
    r.change({ every: 4 });
    const t = r.begin();
    expect(r.arrive(t, { ...STORED, every: 4, mode: 'at' })!.value).toEqual({ mode: 'at', every: 4, searchable: false });
  });
});
