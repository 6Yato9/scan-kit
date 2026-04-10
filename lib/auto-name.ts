// lib/auto-name.ts
export function autoName(date: Date = new Date()): string {
  const formatted = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `Scan ${formatted}`;
}
