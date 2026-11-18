// lib/page-undo.ts
// Undo for "Delete page" in the viewer. Before a page is deleted its image (and
// its unfiltered .orig shadow, when it has one) is copied to a stash in the
// cache; Undo puts it back at the same position, shadow included, so the page
// is restored exactly as it was. One stash at a time: a new delete replaces it.
// A stash is single-use: a successful restore deletes it, so a second Undo
// can't insert the page twice. Stashes nobody used are removed by the startup
// sweep (lib/files.ts TEMP_DIRS).
import { Directory, File, Paths } from 'expo-file-system';
import { docDir } from './storage-layout';
import { copyPageWithShadow, reorderPages } from './files';

const STASH = 'page-undo';

/** The page order that moves the page appended at `count` back to `index`. */
export function reinsertOrder(count: number, index: number): number[] {
  const at = Math.max(0, Math.min(index, count));
  const order: number[] = [];
  for (let i = 0; i < at; i++) order.push(i);
  order.push(count);
  for (let i = at; i < count; i++) order.push(i);
  return order;
}

/** Inserts `item` at `index` of a per-page list (filters, adjustments). */
export function insertAt<T>(list: T[], index: number, item: T): T[] {
  const at = Math.max(0, Math.min(index, list.length));
  return [...list.slice(0, at), item, ...list.slice(at)];
}

/** Copies page `index` of `docId` (and its shadow) into a fresh stash. Returns the stashed page URI. */
export function stashPage(docId: string, index: number): string {
  const root = new Directory(Paths.cache, STASH);
  try {
    if (root.exists) root.delete();
  } catch {
    // An old stash we can't remove is harmless; the new one gets its own folder.
  }
  const dir = new Directory(Paths.cache, STASH, String(Date.now()));
  dir.create({ intermediates: true, idempotent: true });
  const srcDir = docDir(docId);
  // Named page-0 so copyPageWithShadow finds the .orig next to it.
  const page = new File(dir, 'page-0.jpg');
  new File(srcDir, `page-${index}.jpg`).copy(page);
  const orig = new File(srcDir, `page-${index}.orig.jpg`);
  if (orig.exists) orig.copy(new File(dir, 'page-0.orig.jpg'));
  return page.uri;
}

/**
 * Puts a stashed page back into `docId` at `index`, given the document's current
 * page count. Returns the new page URIs (canonical page-0 … page-n names).
 */
export function restoreStashedPage(docId: string, stashedUri: string, count: number, index: number): string[] {
  if (!new File(stashedUri).exists) throw new Error('page-undo: this page was already restored');
  copyPageWithShadow(stashedUri, docId, count);
  const pages = reorderPages(docId, reinsertOrder(count, index));
  discardStash(stashedUri);
  return pages;
}

/** Deletes the stash folder holding `stashedUri`. Best effort: the startup sweep catches leftovers. */
function discardStash(stashedUri: string): void {
  try {
    const dir = new Directory(stashedUri.split('?')[0].replace(/\/[^/]*$/, ''));
    if (dir.exists) dir.delete();
  } catch {
    // Harmless; see above.
  }
}
