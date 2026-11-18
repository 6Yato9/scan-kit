// lib/format.ts
// Shared date/time formatting so every screen, name and stamp shows dates the
// same way — and the way the user's device does. Every helper formats with the
// device locale (`undefined` → the system's), which also carries the user's
// 12/24-hour preference. Tests pass an explicit locale to stay deterministic.

/** "Nov 18, 2026" (en-US), "18 Nov 2026" (en-GB), "18 nov. 2026" (fr) … */
export function formatDate(ts: number | Date, locale?: string): string {
  return new Date(ts).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** True when `locale` (default: the device's) uses a 24-hour clock. */
function uses24h(locale?: string): boolean {
  try {
    const o = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions();
    if (o.hourCycle) return o.hourCycle === 'h23' || o.hourCycle === 'h24';
    return o.hour12 === false;
  } catch {
    return false;
  }
}

/** "12:35 AM" or "00:35", following the device's clock setting. */
export function formatTime(ts: number | Date, locale?: string): string {
  // A 24-hour clock reads "00:35", never "0:35".
  const hour = uses24h(locale) ? '2-digit' : 'numeric';
  return new Date(ts).toLocaleTimeString(locale, { hour, minute: '2-digit' });
}

/** "Nov 18, 2026, 12:35 AM". */
export function formatDateTime(ts: number | Date, locale?: string): string {
  return `${formatDate(ts, locale)}, ${formatTime(ts, locale)}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Today, 2:05 PM", "Yesterday", or "Nov 17, 2026". */
export function formatDocDate(ts: number, now: Date = new Date(), locale?: string): string {
  const d = new Date(ts);
  if (sameDay(d, now)) return `Today, ${formatTime(d, locale)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Yesterday';
  return formatDate(d, locale);
}

/** "1 page", "3 pages", or "PDF" for an imported PDF. */
export function formatPageCount(doc: { pages: string[]; pdfUri?: string }): string {
  if (doc.pdfUri) return 'PDF';
  const n = doc.pages.length;
  return `${n} page${n === 1 ? '' : 's'}`;
}
