// types/document.ts
export type PageFilter = 'original' | 'grayscale' | 'bw' | 'enhanced';

export type PageAdjustment = {
  brightness: number; // -100 to 100, 0 = no change
  contrast: number;   // -100 to 100, 0 = no change
  saturation: number; // -100 to 100, 0 = no change
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
};
