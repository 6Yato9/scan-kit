import {
  chosenIndices,
  createdName,
  moveItem,
  normTurn,
  planPdf,
  progressTotal,
  removeItem,
  resultKind,
  turnItem,
  unusedSources,
  type CreateItem,
  type ImageItem,
  type PdfItem,
  type ScanItem,
} from '../lib/create-pdf';

const img = (key: string, turn: 0 | 90 | 180 | 270 = 0): ImageItem => ({
  key,
  kind: 'image',
  origin: 'photo',
  page: `file:///c/${key}.jpg`,
  source: null,
  geometry: null,
  uncropped: false,
  temps: [],
  label: 'Photo',
  turn,
});
const scan = (key: string, index: number): ScanItem => ({
  key,
  kind: 'scan',
  docId: 'd1',
  docName: 'Lease',
  index,
  uri: `file:///d/d1/page-${index}.jpg`,
  identity: '1-1',
  label: `Lease, page ${index + 1}`,
  turn: 0,
});
const pdf = (key: string, source: string, index: number, turn: 0 | 90 | 180 | 270 = 0): PdfItem => ({
  key,
  kind: 'pdf',
  pdf: source,
  index,
  thumb: null,
  label: `${source} ${index + 1}`,
  turn,
});

describe('create-pdf list edits', () => {
  it('turns a page by quarters and wraps', () => {
    const items: CreateItem[] = [img('a'), img('b')];
    let next = turnItem(items, 'b');
    expect(next.map(i => i.turn)).toEqual([0, 90]);
    next = turnItem(turnItem(turnItem(next, 'b'), 'b'), 'b');
    expect(next[1].turn).toBe(0);
    expect(normTurn(-90)).toBe(270);
    expect(normTurn(450)).toBe(90);
  });

  it('moves items and clamps', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, -5)).toEqual(['c', 'a', 'b']);
    const same = ['a', 'b'];
    expect(moveItem(same, 1, 1)).toBe(same);
    expect(moveItem(same, 5, 0)).toBe(same);
  });

  it('removes one item and reports it', () => {
    const items: CreateItem[] = [img('a'), img('b')];
    const { items: next, removed } = removeItem(items, 'a');
    expect(next.map(i => i.key)).toEqual(['b']);
    expect(removed?.key).toBe('a');
    expect(removeItem(items, 'zz').removed).toBeNull();
  });

  it('finds sources no page uses', () => {
    const sources = [{ id: 'p1', uri: 'x', name: 'A', pageCount: 2 }, { id: 'p2', uri: 'y', name: 'B', pageCount: 1 }];
    expect(unusedSources([pdf('k', 'p1', 0)], sources).map(s => s.id)).toEqual(['p2']);
  });

  it('decides the stored form from the sources', () => {
    expect(resultKind([img('a'), scan('s', 0)])).toBe('scan');
    expect(resultKind([img('a'), pdf('p', 'p1', 0)])).toBe('pdf');
    expect(progressTotal([img('a'), scan('s', 0)])).toBe(3);
    expect(progressTotal([img('a'), pdf('p', 'p1', 0), pdf('q', 'p1', 1)])).toBe(4);
  });

  it('names the document from what was typed, else the automatic name', () => {
    expect(createdName('  Tax   return ', 'Scan Nov 19')).toEqual({ name: 'Tax return', isDefault: false });
    expect(createdName('   ', 'Scan Nov 19')).toEqual({ name: 'Scan Nov 19', isDefault: true });
    expect(createdName('x'.repeat(200), 'f').name).toHaveLength(120);
  });

  it('lists chosen pages in page order', () => {
    expect(chosenIndices(new Set([4, 0, 2]), 5)).toEqual([0, 2, 4]);
    expect(chosenIndices(new Set([9]), 3)).toEqual([]);
  });
});

describe('planPdf', () => {
  const sources = [
    { id: 'A', pageCount: 3 },
    { id: 'B', pageCount: 2 },
  ];

  it('is the combined file itself when every page comes once, in order, unturned', () => {
    const plan = planPdf([pdf('1', 'A', 0), pdf('2', 'A', 1), pdf('3', 'A', 2)], sources);
    expect(plan.parts).toEqual([{ kind: 'pdf', source: 'A', instance: 0 }]);
    expect(plan.sources).toEqual([0, 1, 2]);
    expect(plan.identity).toBe(true);
    expect(plan.combinedCount).toBe(3);
  });

  it('picks a subset of a PDF and puts images last in the combined file', () => {
    // photo, A p3, scan, B p1 (turned), A p1
    const items: CreateItem[] = [img('p'), pdf('a3', 'A', 2), scan('s', 0), pdf('b1', 'B', 0, 90), pdf('a1', 'A', 0)];
    const plan = planPdf(items, sources);
    // combined: A(3) B(2) images(2)
    expect(plan.parts).toEqual([
      { kind: 'pdf', source: 'A', instance: 0 },
      { kind: 'pdf', source: 'B', instance: 0 },
      { kind: 'images' },
    ]);
    expect(plan.imageKeys).toEqual(['p', 's']);
    expect(plan.combinedCount).toBe(7);
    expect(plan.sources).toEqual([5, 2, 6, 3, 0]);
    expect(plan.rotations).toEqual([0, 0, 0, 90, 0]);
    expect(plan.identity).toBe(false);
  });

  it('adds a source again when one of its pages is used twice (each input page at most once)', () => {
    const items: CreateItem[] = [pdf('x', 'B', 1), pdf('y', 'B', 1), pdf('z', 'B', 0)];
    const plan = planPdf(items, sources);
    expect(plan.parts).toEqual([
      { kind: 'pdf', source: 'B', instance: 0 },
      { kind: 'pdf', source: 'B', instance: 1 },
    ]);
    // instance 0: pages 0,1 at 0..1; instance 1 at 2..3. x→B0p1, y→B1p1, z→B0p0
    expect(plan.sources).toEqual([1, 3, 0]);
    expect(new Set(plan.sources).size).toBe(plan.sources.length);
    expect(plan.identity).toBe(false);
  });

  it('never repeats a combined page across a mixed list', () => {
    const items: CreateItem[] = [];
    for (let k = 0; k < 20; k++) items.push(k % 3 === 0 ? img(`i${k}`) : pdf(`p${k}`, k % 2 ? 'A' : 'B', k % (k % 2 ? 3 : 2)));
    const plan = planPdf(items, sources);
    expect(plan.sources).toHaveLength(items.length);
    expect(new Set(plan.sources).size).toBe(items.length);
    expect(Math.max(...plan.sources)).toBeLessThan(plan.combinedCount);
  });

  it('refuses unknown sources and pages', () => {
    expect(() => planPdf([pdf('x', 'C', 0)], sources)).toThrow('unknown source');
    expect(() => planPdf([pdf('x', 'A', 3)], sources)).toThrow('no page');
    expect(() => planPdf([], sources)).toThrow('no pages');
  });
});
