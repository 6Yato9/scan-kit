// lib/view-pref.ts
// Files tab layout preference: a grid of page thumbnails or a compact list.
import AsyncStorage from '@react-native-async-storage/async-storage';

export type FilesLayout = 'grid' | 'list';

const KEY = '@scan_kit_files_layout';

export async function getFilesLayout(): Promise<FilesLayout> {
  try {
    return (await AsyncStorage.getItem(KEY)) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

export async function saveFilesLayout(layout: FilesLayout): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, layout);
  } catch {
    // A preference that didn't stick is not worth an error.
  }
}
