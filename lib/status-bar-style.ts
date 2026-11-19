// lib/status-bar-style.ts
// Which status bar style a route needs, and how to re-assert it. Kept free of
// React so it can be tested.

// Routes whose chrome is always dark (the viewer and its crop modal, annotate,
// the QR camera, the document camera, Fill & sign): the status bar is light there whatever the theme.
const CHROME_ROUTES = ['/viewer', '/annotate', '/tools/qr', '/camera', '/pdf-fill'];

/** 'light' = white clock and battery, 'dark' = black. */
export function statusBarStyleFor(pathname: string, isDark: boolean): 'light' | 'dark' {
  const chrome = CHROME_ROUTES.some(r => pathname === r || pathname.startsWith(`${r}/`));
  return chrome || isDark ? 'light' : 'dark';
}

/** Values React Native's StatusBar.setBarStyle accepts. */
export type NativeBarStyle = 'light-content' | 'dark-content' | 'default';

/**
 * The StatusBar.setBarStyle calls (in order) that re-assert `style`.
 *
 * Setting the style UIKit already has is a no-op, so a style UIKit drew stale
 * (after a system picker, or one set mid appearance change) can only be redrawn
 * by changing to some other style first. The two calls reach UIKit separately,
 * and whatever lies between them is DRAWN — measured on iOS 26 with rapid
 * re-asserts, the opposite style showed in about half of the screenshots. A
 * periodic "flip to the opposite" therefore leaves the wrong clock colour on
 * screen for a moment every time, which is what the tool modals showed
 * (white clock on a light screen).
 *
 * - Dark content on a light system: go through 'default', which draws dark
 *   content too, so the redraw is invisible. Always safe.
 * - Anything else has no invisible intermediate ('default' doesn't reliably
 *   follow the appearance), so the opposite is used only when a stale draw is
 *   actually likely (`redraw`: theme / appearance change, back from the
 *   background or a system picker) — moments when the screen is changing
 *   anyway. Routine re-asserts send just the target.
 */
export function reassertCalls(style: 'light' | 'dark', systemDark: boolean, redraw: boolean): NativeBarStyle[] {
  const target: NativeBarStyle = style === 'light' ? 'light-content' : 'dark-content';
  if (style === 'dark' && !systemDark) return ['default', target];
  if (redraw) return [style === 'light' ? 'dark-content' : 'light-content', target];
  return [target];
}
