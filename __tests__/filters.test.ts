import { combinedFilterRN } from '../lib/filters';

describe('combinedFilterRN (React Native filter array)', () => {
  it('returns undefined for original', () => {
    expect(combinedFilterRN('original')).toBeUndefined();
  });
  it('returns undefined when filter is undefined and no adjustment', () => {
    expect(combinedFilterRN(undefined)).toBeUndefined();
  });
  it('returns [{grayscale:1}] for grayscale', () => {
    expect(combinedFilterRN('grayscale')).toEqual([{ grayscale: 1 }]);
  });
  it('returns grayscale + contrast for bw', () => {
    expect(combinedFilterRN('bw')).toEqual([{ grayscale: 1 }, { contrast: 2 }]);
  });
  it('returns contrast + saturate for enhanced', () => {
    expect(combinedFilterRN('enhanced')).toEqual([{ contrast: 1.3 }, { saturate: 1.3 }]);
  });
  it('appends adjustment multipliers after the filter', () => {
    expect(combinedFilterRN('grayscale', { brightness: 20, contrast: 0, saturation: 0 }))
      .toEqual([{ grayscale: 1 }, { brightness: 1.2 }]);
  });
  it('ignores non-finite adjustment values', () => {
    expect(combinedFilterRN('original', { brightness: NaN, contrast: 0, saturation: 0 } as any))
      .toBeUndefined();
  });
});
