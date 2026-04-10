// lib/files.ts
import * as FileSystem from 'expo-file-system';

export async function copyPageToStorage(
  tempUri: string,
  docId: string,
  pageIndex: number
): Promise<string> {
  const dir = `${FileSystem.documentDirectory}scan-kit/${docId}/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const dest = `${dir}page-${pageIndex}.jpg`;
  await FileSystem.copyAsync({ from: tempUri, to: dest });
  return dest;
}

export async function deleteDocumentFiles(docId: string): Promise<void> {
  const dir = `${FileSystem.documentDirectory}scan-kit/${docId}/`;
  const info = await FileSystem.getInfoAsync(dir);
  if (info.exists) {
    await FileSystem.deleteAsync(dir, { idempotent: true });
  }
}
