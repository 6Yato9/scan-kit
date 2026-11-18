// lib/status-bar-style.ts
// Which status bar style a route needs. Kept free of React so it can be tested.

// Routes whose chrome is always dark (the viewer and its crop modal, annotate,
// the QR camera): the status bar is light there whatever the theme.
const CHROME_ROUTES = ['/viewer', '/annotate', '/tools/qr'];

/** 'light' = white clock and battery, 'dark' = black. */
export function statusBarStyleFor(pathname: string, isDark: boolean): 'light' | 'dark' {
  const chrome = CHROME_ROUTES.some(r => pathname === r || pathname.startsWith(`${r}/`));
  return chrome || isDark ? 'light' : 'dark';
}
