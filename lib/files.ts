// lib/files.ts
import { Directory, File, Paths } from 'expo-file-system';

export async function copyPageToStorage(
  tempUri: string,
  docId: string,
  pageIndex: number
): Promise<string> {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  dir.create({ intermediates: true, idempotent: true });
  const dest = new File(dir, `page-${pageIndex}.jpg`);
  const src = new File(tempUri);
  src.copy(dest);
  return dest.uri;
}

export async function deleteDocumentFiles(docId: string): Promise<void> {
  const dir = new Directory(Paths.document, 'scan-kit', docId);
  if (dir.exists) {
    dir.delete();
  }
}
