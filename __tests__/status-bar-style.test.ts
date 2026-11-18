import { statusBarStyleFor } from '@/lib/status-bar-style';

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
