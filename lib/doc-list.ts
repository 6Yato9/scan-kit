// lib/doc-list.ts
// Pure list helpers shared by Home and Files.
import { Document } from '../types/document';
import type { SortKey } from './storage';

export function sortDocuments(docs: Document[], key: SortKey): Document[] {
  switch (key) {
    case 'dateModified':
      return [...docs].sort((a, b) => b.updatedAt - a.updatedAt);
    case 'nameAZ':
      return [...docs].sort((a, b) => a.name.localeCompare(b.name));
    default:
      return [...docs].sort((a, b) => b.createdAt - a.createdAt);
  }
}

/** Case-insensitive match on the name or the recognized text. `q` must be lower-case. */
export function matchesQuery(d: Document, q: string): boolean {
  return d.name.toLowerCase().includes(q) || (d.ocrText?.toLowerCase().includes(q) ?? false);
}
