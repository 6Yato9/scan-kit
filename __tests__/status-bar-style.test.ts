import { reassertCalls, statusBarStyleFor } from '@/lib/status-bar-style';

describe('statusBarStyleFor', () => {
  it('follows the theme on ordinary screens', () => {
    expect(statusBarStyleFor('/', false)).toBe('dark');
    expect(statusBarStyleFor('/', true)).toBe('light');
    expect(statusBarStyleFor('/settings/about', false)).toBe('dark');
    expect(statusBarStyleFor('/tools/merge', true)).toBe('light');
  });

  it('is always light on the always-dark screens', () => {
    for (const r of ['/viewer', '/annotate', '/tools/qr']) {
      expect(statusBarStyleFor(r, false)).toBe('light');
      expect(statusBarStyleFor(r, true)).toBe('light');
    }
  });

  it('does not treat look-alike routes as chrome', () => {
    expect(statusBarStyleFor('/viewers', false)).toBe('dark');
    expect(statusBarStyleFor('/tools/qrcode', false)).toBe('dark');
  });
});

describe('a tool opened from the viewer', () => {
  // The viewer draws no <StatusBar> of its own (it would outlive its focus and
  // keep the bar white over the tool), so the root style alone decides.
  it('gets the theme style, not the viewer’s light one', () => {
    expect(statusBarStyleFor('/tools/watermark', false)).toBe('dark');
    expect(statusBarStyleFor('/tools/sign', false)).toBe('dark');
    expect(statusBarStyleFor('/tools/timestamp', true)).toBe('light');
  });
});

describe('reassertCalls (r7: tool modals showed the opposite clock colour)', () => {
  const visibleOpposite = (calls: string[], style: 'light' | 'dark') =>
    calls.some(c => c === (style === 'light' ? 'dark-content' : 'light-content'));

  it('routine re-asserts never pass through a style that draws differently', () => {
    for (const style of ['light', 'dark'] as const) {
      for (const systemDark of [false, true]) {
        const calls = reassertCalls(style, systemDark, false);
        expect(visibleOpposite(calls, style)).toBe(false);
        expect(calls[calls.length - 1]).toBe(style === 'light' ? 'light-content' : 'dark-content');
      }
    }
  });

  it('dark content on a light system redraws invisibly through default', () => {
    expect(reassertCalls('dark', false, false)).toEqual(['default', 'dark-content']);
    expect(reassertCalls('dark', false, true)).toEqual(['default', 'dark-content']);
  });

  it('flips through the opposite only when a stale draw is likely', () => {
    expect(reassertCalls('light', false, true)).toEqual(['dark-content', 'light-content']);
    expect(reassertCalls('light', true, true)).toEqual(['dark-content', 'light-content']);
    expect(reassertCalls('dark', true, true)).toEqual(['light-content', 'dark-content']);
    expect(reassertCalls('light', true, false)).toEqual(['light-content']);
  });
});
