import { combinedFilterRN } from '../lib/filters';

describe('combinedFilterRN (React Native filter array)', () => {
  it('returns undefined for original', () => {
    expect(combinedFilterRN('original')).toBeUndefined();
  });
  it('returns undefined when filter is undefined and no adjustment', () => {
    expect(combinedFilterRN(undefined)).toBeUndefined();
  });
  it('maps grayscale to the flattened document gray', () => {
    expect(combinedFilterRN('grayscale')).toEqual([{ docgray: 1 }]);
  });
  it('maps bw to the adaptive threshold', () => {
    expect(combinedFilterRN('bw')).toEqual([{ docbw: 1 }]);
  });
  it('maps enhanced to magic colour', () => {
    expect(combinedFilterRN('enhanced')).toEqual([{ magic: 1 }]);
  });
  it('appends adjustment multipliers after the filter', () => {
    expect(combinedFilterRN('grayscale', { brightness: 20, contrast: 0, saturation: 0 }))
      .toEqual([{ docgray: 1 }, { brightness: 1.2 }]);
    expect(combinedFilterRN('enhanced', { brightness: 0, contrast: 10, saturation: -20 }))
      .toEqual([{ magic: 1 }, { contrast: 1.1 }, { saturate: 0.8 }]);
  });
  it('folds brightness and contrast into the bw threshold instead of appending no-op primitives', () => {
    expect(combinedFilterRN('bw', { brightness: 40, contrast: -50, saturation: 30 }))
      .toEqual([{ docbw: 1, bias: 0.4, crisp: -0.5 }]);
  });
  it('drops Saturation where there is no colour (Grayscale, Black & white)', () => {
    expect(combinedFilterRN('grayscale', { brightness: 0, contrast: 0, saturation: 40 })).toEqual([{ docgray: 1 }]);
    expect(combinedFilterRN('bw', { brightness: 0, contrast: 0, saturation: 40 })).toEqual([{ docbw: 1 }]);
    expect(combinedFilterRN('original', { brightness: 0, contrast: 0, saturation: 40 })).toEqual([{ saturate: 1.4 }]);
  });
  it('keeps plain adjustments on the original', () => {
    expect(combinedFilterRN('original', { brightness: -10, contrast: 0, saturation: 0 }))
      .toEqual([{ brightness: 0.9 }]);
  });
  it('ignores non-finite adjustment values', () => {
    expect(combinedFilterRN('original', { brightness: NaN, contrast: 0, saturation: 0 } as any))
      .toBeUndefined();
  });
});
