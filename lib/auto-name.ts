// lib/auto-name.ts
export function autoName(date: Date = new Date(), prefix: string = 'Scan'): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const trimmed = prefix.trim() || 'Scan';
  return `${trimmed} ${day}-${month}-${year} ${hours}:${minutes}`;
}
