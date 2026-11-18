// lib/unique-names.ts
// Unique file names for a batch export (a ZIP's entries, Export all): pure, so
// it can be unit-tested without pulling in the share sheet's native modules.

/**
 * Unique file names: a second "Scan.pdf" becomes "Scan 2.pdf".
 *
 * Names are compared case-insensitively (APFS and the Files app treat
 * "Scan.pdf" and "scan.pdf" as the same file). Every name the user actually
 * chose is reserved up front, so a document really called "Receipt 2" keeps
 * that name and a generated "Receipt N" keeps counting past it:
 * ["Receipt", "Receipt", "Receipt 2"] → ["Receipt", "Receipt 3", "Receipt 2"].
 */
export function uniqueNames(names: string[]): string[] {
  const key = (n: string) => n.toLowerCase();
  const taken = new Set<string>(names.map(key));
  const kept = new Set<string>(); // keys whose first holder has already been placed
  return names.map(n => {
    if (!kept.has(key(n))) {
      kept.add(key(n));
      return n;
    }
    const dot = n.lastIndexOf('.');
    const stem = dot > 0 ? n.slice(0, dot) : n;
    const ext = dot > 0 ? n.slice(dot) : '';
    let candidate = `${stem} 2${ext}`;
    for (let i = 3; taken.has(key(candidate)); i++) candidate = `${stem} ${i}${ext}`;
    taken.add(key(candidate));
    return candidate;
  });
}
