// types/document.ts
// Stored per page and in Scan settings: never rename or remove an id, and an
// id must keep producing the same pixels (lib/pixel-kernels.ts). The last five
// were added in R12.
export type PageFilter =
  | 'original' | 'grayscale' | 'bw' | 'enhanced'
  | 'noshadow' | 'photo' | 'fainttext' | 'whiteboard' | 'inksaver';

export type PageAdjustment = {
  brightness: number; // -100 to 100, 0 = no change
  contrast: number;   // -100 to 100, 0 = no change
  saturation: number; // -100 to 100, 0 = no change
  // -100 (soften) to 100 (sharpen), 0 = no change. Added in R12, so absent on
  // every adjustment saved before it: read as 0.
  sharpness?: number;
};

export type Document = {
  id: string;
  name: string;
  pages: string[];       // local file:// URIs, persisted JPEGs
  filters?: PageFilter[]; // per-page display filter; absent = all 'original'
  adjustments?: PageAdjustment[]; // per-page brightness/contrast/saturation
  createdAt: number;     // ms timestamp
  updatedAt: number;
  folder?: string;       // folder name; undefined = no folder
  pdfUri?: string;       // set for imported PDFs; pages will be []
  // Concatenated OCR text across all pages, used for content search. May go stale
  // after page edits (rotate/crop/delete/reorder); refreshed on the next OCR run.
  ocrText?: string;
  // Set while the document is in "Recently deleted" (ms timestamp of the move).
  // Trashed documents keep their files and record but are hidden from every
  // list, search and tool; they are purged for good after 30 days.
  trashedAt?: number;
  // The automatic name the document was created with ("Scan Nov 18, 2026 …").
  // While `name` still equals it, text recognition may replace the name with a
  // title read from the page; a user rename makes them differ and stops that.
  defaultName?: string;
};
