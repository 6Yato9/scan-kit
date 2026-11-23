import { READABLE_WIDTH, Spacing, readableInset } from '@/lib/theme';

describe('readableInset', () => {
  it('is the normal gutter on phones', () => {
    expect(readableInset(375)).toBe(Spacing.gutter);
    expect(readableInset(440)).toBe(Spacing.gutter);
  });

  it('centres a READABLE_WIDTH column on a wide screen', () => {
    const w = 1180; // iPad Air landscape
    const inset = readableInset(w);
    expect(w - 2 * inset).toBe(READABLE_WIDTH);
  });

  it('never goes below the gutter it is given', () => {
    expect(readableInset(READABLE_WIDTH + 10, 24)).toBe(24);
  });
});
