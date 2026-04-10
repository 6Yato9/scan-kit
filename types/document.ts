// types/document.ts
export type PageFilter = 'original' | 'grayscale' | 'bw' | 'enhanced';

export type Document = {
  id: string;
  name: string;
  pages: string[];       // local file:// URIs, persisted JPEGs
  filters?: PageFilter[]; // per-page display filter; absent = all 'original'
  createdAt: number;     // ms timestamp
  updatedAt: number;
  folder?: string;       // folder name; undefined = no folder
  pdfUri?: string;       // set for imported PDFs; pages will be []
};
