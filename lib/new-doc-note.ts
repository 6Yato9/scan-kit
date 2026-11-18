// lib/new-doc-note.ts
// What the viewer should say when it first shows a document that was just
// created (a scan, imported photos or a file): "Saved as “Receipt”" with
// Rename, or — when auto-crop found no page edges in an imported photo —
// "Couldn’t find the page edges" with Crop. Whoever creates the document
// notes it here; the viewer takes the note (once) when it shows that document.
//
// Read-only for the scan/import pipeline: a plain in-memory map, nothing
// persisted. A note nobody takes within NOTE_TTL_MS is dropped, so a document
// opened much later never greets the user with a stale message.

export type NewDocNote = {
  /** Zero-based pages where auto-crop found no page outline (kept as photographed). */
  uncropped: number[];
};

const NOTE_TTL_MS = 60_000;
const notes = new Map<string, NewDocNote & { at: number }>();

/** Records that `docId` was just created. Later calls for the same id merge their uncropped pages. */
export function noteNewDocument(docId: string, note: Partial<NewDocNote> = {}, now = Date.now()): void {
  if (!docId) return;
  const prev = notes.get(docId);
  const uncropped = [...new Set([...(prev?.uncropped ?? []), ...(note.uncropped ?? [])])].sort((a, b) => a - b);
  notes.set(docId, { uncropped, at: now });
}

/** The note for `docId`, consumed: a second call returns null. */
export function takeNewDocumentNote(docId: string, now = Date.now()): NewDocNote | null {
  const note = notes.get(docId);
  if (!note) return null;
  notes.delete(docId);
  if (now - note.at > NOTE_TTL_MS) return null;
  return { uncropped: note.uncropped };
}

/** The toast for a page whose edges weren't found: names the page in a longer document. */
export function uncroppedMessage(uncropped: number[], pageCount: number): string {
  if (uncropped.length > 1) return `Couldn’t find the edges of ${uncropped.length} pages`;
  if (pageCount > 1 && uncropped.length === 1) return `Couldn’t find the edges of page ${uncropped[0] + 1}`;
  return 'Couldn’t find the page edges';
}

export function resetNewDocNotesForTests(): void {
  notes.clear();
}
