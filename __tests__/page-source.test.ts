// Re-croppable pages (lib/page-source.ts): sources, their stamp, re-crop, and
// that pages without a source are left exactly as they are.
const mockFs = new Map<string, string>();

jest.mock('expo-file-system', () => {
  const part = (p: any) => (p && typeof p === 'object' ? p.uri : String(p));
  class MockFile {
    uri: string;
    constructor(dir: any, name?: string) {
      this.uri = name ? `${part(dir).replace(/\/+$/, '')}/${name}` : part(dir);
    }
    get exists() { return mockFs.has(this.uri); }
    get size() { return mockFs.has(this.uri) ? mockFs.get(this.uri)!.length : null; }
    get md5() { return mockFs.has(this.uri) ? `md5:${mockFs.get(this.uri)}` : null; }
    textSync() { return mockFs.get(this.uri) ?? ''; }
    write(t: string) { mockFs.set(this.uri, t); }
    create() { mockFs.set(this.uri, ''); }
    delete() {
      if (!mockFs.has(this.uri)) throw new Error(`delete: ${this.uri} missing`);
      mockFs.delete(this.uri);
    }
    copy(dest: MockFile) {
      if (!mockFs.has(this.uri)) throw new Error(`copy: ${this.uri} missing`);
      mockFs.set(dest.uri, mockFs.get(this.uri)!);
    }
    move(dest: MockFile) {
      if (!mockFs.has(this.uri)) throw new Error(`move: ${this.uri} missing`);
      if (mockFs.has(dest.uri)) throw new Error(`move: ${dest.uri} exists`);
      mockFs.set(dest.uri, mockFs.get(this.uri)!);
      mockFs.delete(this.uri);
      this.uri = dest.uri; // like expo-file-system: the instance follows the file
    }
  }
  class MockDirectory {
    uri: string;
    constructor(...parts: any[]) { this.uri = parts.map(part).join('/').replace(/\/+/g, '/').replace('file:/', 'file:///'); }
    create() {}
    get exists() { return true; }
  }
  return { File: MockFile, Directory: MockDirectory, Paths: { cache: { uri: 'file:///cache' }, document: { uri: 'file:///docs' } } };
});

jest.mock('../lib/storage-layout', () => {
  const { Directory } = jest.requireMock('expo-file-system');
  return { resolveDocDir: (id: string) => new Directory('file:///support', id), docDir: (id: string) => new Directory('file:///support', id) };
});
jest.mock('../lib/image-size', () => ({
  MAX_PAGE_EDGE: 4000,
  cappedSize: () => null,
  getImageSize: jest.fn(async () => ({ width: 1000, height: 1400 })),
}));
jest.mock('expo-image-manipulator', () => ({ manipulateAsync: jest.fn(), SaveFormat: { JPEG: 'jpeg' } }));

// Native functions: the "pixels" are strings describing what made them.
const mockNative = {
  detectQuad: jest.fn(async (_uri: string): Promise<number[] | null> => [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9]),
  warpQuad: jest.fn(async (src: string, quad: number[], out: string) => {
    mockFs.set(out, `warp(${mockFs.get(src)}|${quad.join(',')})`);
    return { uri: out, width: 100, height: 100 };
  }),
  normalizeImage: jest.fn(async (src: string, out: string) => {
    mockFs.set(out, `norm(${mockFs.get(src)})`);
    return { uri: out, width: 100, height: 100 };
  }),
};
jest.mock('../modules/vision-ocr/src', () => ({ get VisionOcr() { return mockNative; } }));

import {
  cropTargetFor,
  detectQuad,
  discardPrepared,
  geometryOfInput,
  installPreparedSource,
  noteRotation,
  prepareSourcePage,
  readPageSource,
  recropPage,
  removePageSource,
  writeSourceMeta,
} from '../lib/page-source';
import { FULL_QUAD, rotateGeometry } from '../lib/quad';

const D = 'file:///support/doc';
const f = (name: string) => `${D}/${name}`;
const snapshot = () => new Map(mockFs);

beforeEach(() => {
  mockFs.clear();
  jest.clearAllMocks();
});

/** A page made from a photo, as saveScan stores it. */
async function seedSourcePage(quad = [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9]) {
  mockFs.set('file:///cache/ImagePicker/photo.jpg', 'PHOTO');
  const prepared = await prepareSourcePage({ sourceUri: 'file:///cache/ImagePicker/photo.jpg', quad }, 0.75, true);
  mockFs.set(f('page-0.jpg'), mockFs.get(prepared.page)!);
  installPreparedSource(prepared, 'doc', 0);
  discardPrepared(prepared);
  return prepared;
}

describe('saving a page with its source', () => {
  test('the page is the warp of the normalised photo; the photo and geometry are kept', async () => {
    await seedSourcePage();
    expect(mockFs.get(f('page-0.src.jpg'))).toBe('norm(PHOTO)');
    expect(mockFs.get(f('page-0.jpg'))).toBe('warp(norm(PHOTO)|0.1,0.1,0.9,0.1,0.9,0.9,0.1,0.9)');
    const src = readPageSource('doc', 0);
    expect(src?.geometry).toEqual({ quad: [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9], rotation: 0 });
    // Temp output is the caller's to discard; the source was MOVED, not copied.
    expect([...mockFs.keys()].filter(k => k.startsWith('file:///cache/page-source/src'))).toEqual([]);
  });

  test('without "Keep original photos" no source is stored', async () => {
    mockFs.set('file:///cache/p.jpg', 'PHOTO');
    const prepared = await prepareSourcePage({ sourceUri: 'file:///cache/p.jpg', quad: null }, 0.75, false);
    mockFs.set(f('page-0.jpg'), mockFs.get(prepared.page)!);
    installPreparedSource(prepared, 'doc', 0);
    expect(prepared.source).toBeNull();
    expect(mockFs.has(f('page-0.src.jpg'))).toBe(false);
    expect(readPageSource('doc', 0)).toBeNull();
  });

  test('no outline, or an unusable one, means the whole photo', () => {
    expect(geometryOfInput({ sourceUri: 'x', quad: null }).quad).toEqual(FULL_QUAD);
    expect(geometryOfInput({ sourceUri: 'x', quad: [0, 0, 1, 1, 1, 0, 0, 1] }).quad).toEqual(FULL_QUAD); // crossed
    expect(geometryOfInput({ sourceUri: 'x', quad: [0, 0, 1, 0, 1, 1, 0, 1], rotation: 90 })).toEqual(rotateGeometry({ quad: [...FULL_QUAD], rotation: 0 }, 90));
  });

  test('detectQuad rejects junk from the native side', async () => {
    mockNative.detectQuad.mockResolvedValueOnce([0, 0, 1]);
    expect(await detectQuad('file:///x.jpg')).toBeNull();
    mockNative.detectQuad.mockRejectedValueOnce(new Error('ERR_IMAGE_READ'));
    expect(await detectQuad('file:///x.jpg')).toBeNull();
  });
});

describe('the stamp: a source is trusted only while it produced the page', () => {
  test('a filter bake (page changes, .orig made from the unfiltered page) keeps it valid', async () => {
    await seedSourcePage();
    // bake: ensureOriginal copies the page to .orig, then the page gets the filter.
    mockFs.set(f('page-0.orig.jpg'), mockFs.get(f('page-0.jpg'))!);
    mockFs.set(f('page-0.jpg'), 'ENHANCED');
    expect(readPageSource('doc', 0)).not.toBeNull();
  });

  test('Markup/Sign drawing on the unfiltered image makes the page source-less (the drawing is never re-cropped away)', async () => {
    await seedSourcePage();
    mockFs.set(f('page-0.orig.jpg'), mockFs.get(f('page-0.jpg'))!);
    mockFs.set(f('page-0.orig.jpg'), 'INKED');
    expect(readPageSource('doc', 0)).toBeNull();
    const t = cropTargetFor('doc', 0);
    expect(t.hasSource).toBe(false);
    expect(t.uri).toBe(f('page-0.orig.jpg'));
    expect(t.geometry.quad).toEqual(FULL_QUAD);
  });

  test('a missing photo or corrupt geometry means no source', async () => {
    await seedSourcePage();
    mockFs.set(f('page-0.src.json'), '{"v":1,"quad":[0,0');
    expect(readPageSource('doc', 0)).toBeNull();
    await seedSourcePage();
    mockFs.delete(f('page-0.src.jpg'));
    expect(readPageSource('doc', 0)).toBeNull();
  });

  test('a turn of the page is recorded in the geometry', async () => {
    await seedSourcePage();
    const before = readPageSource('doc', 0);
    mockFs.set(f('page-0.jpg'), 'TURNED'); // rotatePage rewrote the (unfiltered) page
    expect(readPageSource('doc', 0)).toBeNull();
    noteRotation('doc', 0, before, 90);
    expect(readPageSource('doc', 0)?.geometry).toEqual(rotateGeometry(before!.geometry, 90));
  });
});

describe('re-cropping', () => {
  test('a page with a source is re-cropped from the WHOLE photo (wider than before)', async () => {
    await seedSourcePage();
    const target = cropTargetFor('doc', 0);
    expect(target.hasSource).toBe(true);
    expect(target.uri).toBe(f('page-0.src.jpg'));
    const wider = { quad: [0.02, 0.02, 0.98, 0.02, 0.98, 0.98, 0.02, 0.98], rotation: 0 as const };
    await recropPage('doc', 0, target, wider, { keepSource: true });
    const expected = `warp(norm(PHOTO)|${wider.quad.join(',')})`;
    expect(mockFs.get(f('page-0.orig.jpg'))).toBe(expected);
    expect(mockFs.get(f('page-0.jpg'))).toBe(expected); // unfiltered until the caller re-bakes
    expect(mockFs.get(f('page-0.src.jpg'))).toBe('norm(PHOTO)'); // the photo itself never changes
    expect(readPageSource('doc', 0)?.geometry).toEqual(wider);
    expect([...mockFs.keys()].filter(k => /\.(new|part)\.|cache\/page-source/.test(k))).toEqual([]);
  });

  test('a page without a source: cropped from its unfiltered image, which becomes its source', async () => {
    mockFs.set(f('page-0.jpg'), 'FILTERED');
    mockFs.set(f('page-0.orig.jpg'), 'UNFILTERED');
    const target = cropTargetFor('doc', 0);
    expect(target).toMatchObject({ hasSource: false, uri: f('page-0.orig.jpg'), geometry: { quad: FULL_QUAD, rotation: 0 } });
    const g = { quad: [0, 0, 1, 0, 1, 0.8, 0, 0.8], rotation: 0 as const };
    await recropPage('doc', 0, target, g, { keepSource: true });
    expect(mockFs.get(f('page-0.src.jpg'))).toBe('UNFILTERED');
    expect(mockFs.get(f('page-0.orig.jpg'))).toBe(`warp(UNFILTERED|${g.quad.join(',')})`);
    // Next time the crop can be widened back to everything.
    const again = cropTargetFor('doc', 0);
    expect(again).toMatchObject({ hasSource: true, uri: f('page-0.src.jpg'), geometry: g });
    await recropPage('doc', 0, again, { quad: [...FULL_QUAD], rotation: 0 }, { keepSource: true });
    expect(mockFs.get(f('page-0.orig.jpg'))).toBe(`warp(UNFILTERED|${FULL_QUAD.join(',')})`);
  });

  test('with "Keep original photos" off, a page without a source stays without one', async () => {
    mockFs.set(f('page-0.jpg'), 'P');
    const target = cropTargetFor('doc', 0);
    await recropPage('doc', 0, target, { quad: [0, 0, 1, 0, 1, 0.5, 0, 0.5], rotation: 0 }, { keepSource: false });
    expect(mockFs.has(f('page-0.src.jpg'))).toBe(false);
    expect(mockFs.has(f('page-0.src.json'))).toBe(false);
  });

  test('refuses (changing nothing) when the page changed while the editor was open', async () => {
    await seedSourcePage();
    const target = cropTargetFor('doc', 0);
    mockFs.set(f('page-0.orig.jpg'), 'SIGNED'); // a Sign run landed meanwhile
    const before = snapshot();
    await expect(recropPage('doc', 0, target, { quad: [...FULL_QUAD], rotation: 0 }, { keepSource: true })).rejects.toThrow();
    expect(new Map(mockFs)).toEqual(before);
  });

  test('a filter bake finishing meanwhile (page → .orig, same bytes) is not a change', async () => {
    mockFs.set(f('page-0.jpg'), 'RAW');
    const target = cropTargetFor('doc', 0);
    mockFs.set(f('page-0.orig.jpg'), 'RAW');
    mockFs.set(f('page-0.jpg'), 'ENHANCED');
    await recropPage('doc', 0, target, { quad: [0, 0, 1, 0, 1, 0.9, 0, 0.9], rotation: 0 }, { keepSource: true });
    expect(mockFs.get(f('page-0.src.jpg'))).toBe('RAW');
  });

  test('a failed render changes nothing', async () => {
    await seedSourcePage();
    const target = cropTargetFor('doc', 0);
    const before = snapshot();
    mockNative.warpQuad.mockRejectedValueOnce(new Error('ERR_WARP'));
    await expect(recropPage('doc', 0, target, { quad: [...FULL_QUAD], rotation: 0 }, { keepSource: true })).rejects.toThrow('ERR_WARP');
    expect(new Map(mockFs)).toEqual(before);
  });

  test('the turn is part of the warp: rotation 90 sends the corner list shifted by one', async () => {
    await seedSourcePage();
    const target = cropTargetFor('doc', 0);
    const turned = rotateGeometry(target.geometry, 90);
    await recropPage('doc', 0, target, turned, { keepSource: true });
    expect(mockNative.warpQuad).toHaveBeenLastCalledWith(f('page-0.src.jpg'), turned.quad, expect.any(String), 0.92, 4000);
    expect(turned.quad.slice(0, 2)).toEqual([0.1, 0.9]); // old bottom-left is the new top-left
  });
});

describe('pages without a source are untouched', () => {
  test('reading them writes nothing', () => {
    mockFs.set(f('page-0.jpg'), 'OLD');
    mockFs.set(f('page-0.orig.jpg'), 'OLD-orig');
    const before = snapshot();
    expect(readPageSource('doc', 0)).toBeNull();
    cropTargetFor('doc', 0);
    noteRotation('doc', 0, null, 90);
    removePageSource('doc', 0);
    expect(writeSourceMeta('doc', 0, { quad: [...FULL_QUAD], rotation: 0 })).toBe(false);
    expect(new Map(mockFs)).toEqual(before);
  });
});
