// The viewer's Crop wiring (lib/recrop.ts): re-bake after a crop, and Undo.
let mockPending = new Map<string, Set<number>>();
const mockListeners = new Set<(id: string) => void>();
const mockBake = jest.fn(async (_id: string, _i: number, _f: string, _a: unknown, _o: unknown) => true);
jest.mock('../lib/bake', () => ({
  bakePage: (id: string, i: number, f: string, a: unknown, o: unknown) => mockBake(id, i, f, a, o),
  pendingBakesFor: (id: string) => new Map([...(mockPending.get(id) ?? [])].map(i => [i, {}])),
  subscribeBakeChanges: (fn: (id: string) => void) => { mockListeners.add(fn); return () => mockListeners.delete(fn); },
}));
let mockLayout = 0;
jest.mock('../lib/files', () => ({ pageLayoutGeneration: () => mockLayout }));
const mockTarget = jest.fn();
const mockRecrop = jest.fn(async (id: string, i: number) => `file:///docs/${id}/page-${i}.jpg`);
jest.mock('../lib/page-source', () => ({
  cropTargetFor: (...a: unknown[]) => mockTarget(...a),
  recropPage: (id: string, i: number) => mockRecrop(id, i),
}));

import { cropUndoFor, CropUndoError, rebakeAfterCrop, recropPatch, undoTargetFor } from '../lib/recrop';
import { FULL_QUAD } from '../lib/quad';

const doc = (extra: object = {}) => ({ id: 'd', name: 'D', pages: ['p0', 'p1'], createdAt: 1, updatedAt: 1, ...extra });
const target = (hasSource: boolean, quad = [...FULL_QUAD]) => ({ uri: 'u', hasSource, bytes: 10, md5: null, geometry: { quad, rotation: 0 as const } });

beforeEach(() => {
  jest.clearAllMocks();
  mockPending = new Map();
  mockLayout = 0;
});

test('recropPatch replaces only the cropped page\'s URI', async () => {
  const patch = await recropPatch(doc() as any, 1, target(true), { quad: [...FULL_QUAD], rotation: 0 }, true);
  expect(patch).toEqual({ pages: ['p0', 'file:///docs/d/page-1.jpg'] });
  await expect(recropPatch(doc() as any, 5, target(true), { quad: [...FULL_QUAD], rotation: 0 }, true)).rejects.toThrow();
});

describe('rebakeAfterCrop', () => {
  test('bakes the page\'s recorded look back in', async () => {
    await rebakeAfterCrop(doc({ filters: ['original', 'bw'], adjustments: [undefined, { brightness: 10, contrast: 0, saturation: 0 }] }) as any, 1);
    expect(mockBake).toHaveBeenCalledWith('d', 1, 'bw', { brightness: 10, contrast: 0, saturation: 0 }, { priority: 'high' });
  });

  test('nothing to bake for an Original page with default adjustments', async () => {
    await rebakeAfterCrop(doc() as any, 0);
    expect(mockBake).not.toHaveBeenCalled();
  });

  test('a bake already pending for the page redoes itself: only waited for', async () => {
    mockPending.set('d', new Set([0]));
    const p = rebakeAfterCrop(doc({ filters: ['enhanced', 'original'] }) as any, 0);
    mockPending.set('d', new Set());
    mockListeners.forEach(l => l('d'));
    await p;
    expect(mockBake).not.toHaveBeenCalled();
  });

  test('never rejects', async () => {
    mockBake.mockRejectedValueOnce(new Error('bake failed'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(rebakeAfterCrop(doc({ filters: ['bw', 'bw'] }) as any, 0)).resolves.toBeUndefined();
  });
});

describe('Undo', () => {
  const after = { quad: [0, 0, 1, 0, 1, 0.5, 0, 0.5], rotation: 0 as const };

  test('offered when the page keeps a source; holds the previous corners', () => {
    expect(cropUndoFor('d', 0, target(true, [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9]), after, false)?.geometry.quad).toEqual([0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9]);
    expect(cropUndoFor('d', 0, target(false), after, true)?.geometry.quad).toEqual(FULL_QUAD);
  });

  test('not offered without a source to re-crop, or when nothing changed', () => {
    expect(cropUndoFor('d', 0, target(false), after, false)).toBeNull();
    expect(cropUndoFor('d', 0, target(true, after.quad), after, true)).toBeNull();
  });

  test('refused once the pages moved, or the page lost its source', () => {
    const u = cropUndoFor('d', 0, target(true), after, true)!;
    mockTarget.mockReturnValueOnce(target(true));
    expect(undoTargetFor(u).hasSource).toBe(true);
    mockTarget.mockReturnValueOnce(target(false));
    expect(() => undoTargetFor(u)).toThrow(CropUndoError);
    mockLayout = 1;
    expect(() => undoTargetFor(u)).toThrow(/moved or deleted/);
  });
});
