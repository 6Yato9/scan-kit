// types/document.ts
export type Document = {
  id: string;
  name: string;
  pages: string[];    // local file:// URIs, persisted JPEGs
  createdAt: number;  // ms timestamp
  updatedAt: number;
};
