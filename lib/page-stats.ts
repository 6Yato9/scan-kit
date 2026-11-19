// lib/page-stats.ts
// Each page's stored bytes and pixel size: what lib/pdf's size estimates are
// computed from (the export sheet's "about 1.2 MB", Compress's sizes).
import { Image } from 'react-native';
import { File } from 'expo-file-system';
import type { PageStat } from './pdf';

function imageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise(resolve => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), () => resolve({ width: 0, height: 0 }));
  });
}

/** Stored bytes and pixel size of every page (0 for anything unreadable). */
export async function pageStats(pages: string[]): Promise<PageStat[]> {
  return Promise.all(
    pages.map(async p => {
      const uri = p.split('?')[0];
      let bytes = 0;
      try {
        const f = new File(uri);
        bytes = f.exists ? f.size ?? 0 : 0;
      } catch {}
      return { bytes, ...(await imageSize(uri)) };
    }),
  );
}
