// types/document.ts
export type PageFilter = 'original' | 'grayscale' | 'bw' | 'enhanced';

export type Document = {
  id: string;
  name: string;
  pages: string[];       // local file:// URIs, persisted JPEGs
  filters?: PageFilter[]; // per-page display filter; absent = all 'original'
  createdAt: number;     // ms timestamp
  updatedAt: number;
};
