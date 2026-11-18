// lib/format.ts
// Shared display formatting so every list shows dates and counts the same way.

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Today, 2:05 PM", "Yesterday", or "Nov 17, 2026". */
export function formatDocDate(ts: number, now: Date = new Date()): string {
  const d = new Date(ts);
  if (sameDay(d, now)) {
    return `Today, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "1 page", "3 pages", or "PDF" for an imported PDF. */
export function formatPageCount(doc: { pages: string[]; pdfUri?: string }): string {
  if (doc.pdfUri) return 'PDF';
  const n = doc.pages.length;
  return `${n} page${n === 1 ? '' : 's'}`;
}
