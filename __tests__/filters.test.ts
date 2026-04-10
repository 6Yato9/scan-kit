import { filterStyle, filterCss } from '../lib/filters';

describe('filterStyle', () => {
  it('returns undefined for original', () => {
    expect(filterStyle('original')).toBeUndefined();
  });
  it('returns undefined when filter is undefined', () => {
    expect(filterStyle(undefined)).toBeUndefined();
  });
  it('returns grayscale(1) for grayscale', () => {
    expect(filterStyle('grayscale')).toBe('grayscale(1)');
  });
  it('returns grayscale(1) contrast(2) for bw', () => {
    expect(filterStyle('bw')).toBe('grayscale(1) contrast(2)');
  });
  it('returns contrast(1.3) saturate(1.3) for enhanced', () => {
    expect(filterStyle('enhanced')).toBe('contrast(1.3) saturate(1.3)');
  });
});

describe('filterCss', () => {
  it('returns none for original', () => {
    expect(filterCss('original')).toBe('none');
  });
  it('returns none when undefined', () => {
    expect(filterCss(undefined)).toBe('none');
  });
  it('returns grayscale(100%) for grayscale', () => {
    expect(filterCss('grayscale')).toBe('grayscale(100%)');
  });
  it('returns grayscale + contrast for bw', () => {
    expect(filterCss('bw')).toBe('grayscale(100%) contrast(200%)');
  });
  it('returns contrast + saturate for enhanced', () => {
    expect(filterCss('enhanced')).toBe('contrast(130%) saturate(130%)');
  });
});
