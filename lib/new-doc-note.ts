// lib/new-doc-note.ts
// What the viewer should say when it first shows a document that was just
// created (a scan, imported photos or a file): "Saved as “Receipt”" with
// Rename, or — when auto-crop found no page edges in an imported photo —
// "No page edges found. Kept the whole photo." with Crop. Whoever creates the document
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

/**
 * The toast for a page whose edges weren't found: names the page in a longer
 * document. Says what was done (the photo was kept whole), not that something
 * failed — the page may simply be fine as it is; Crop is offered beside it.
 */
export function uncroppedMessage(uncropped: number[], pageCount: number): string {
  if (uncropped.length > 1) return `No page edges found on ${uncropped.length} pages. Kept them whole.`;
  if (pageCount > 1 && uncropped.length === 1) return `No page edges found on page ${uncropped[0] + 1}. Kept it whole.`;
  return 'No page edges found. Kept the whole photo.';
}

/** Long side ÷ short side of the paper sizes a flat page image comes in: A4/A-series, US Letter, US Legal. */
const PAPER_ASPECTS = [Math.SQRT2, 11 / 8.5, 14 / 8.5];
/** How close (relative) an image's shape must be to a paper size. Camera photos (4:3 = 1.333) are 3% off Letter. */
const PAPER_TOLERANCE = 0.015;

/**
 * True when an image is shaped exactly like a sheet of paper: a page that is
 * already flat and cropped (an exported page, a scan from another app, a
 * rendered PDF page). Auto-crop finds no edges in it because the page IS the
 * whole image, so there is nothing to warn about. Camera photos (4:3, 3:2,
 * 16:9) and screenshots are never this shape.
 */
export function looksLikeFlatPage(width: number, height: number): boolean {
  if (!(width > 0 && height > 0)) return false;
  const ratio = Math.max(width, height) / Math.min(width, height);
  return PAPER_ASPECTS.some(a => Math.abs(ratio - a) / a <= PAPER_TOLERANCE);
}

export function resetNewDocNotesForTests(): void {
  notes.clear();
}
