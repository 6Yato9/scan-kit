// components/use-import.ts
// Importing photos and files as new documents, shared by Home's quick actions,
// Files' "+" menu and empty state, and "Open in Scan Kit" (app/import.tsx).
// Photos go through auto-crop (find the page on the desk and straighten it)
// like the in-app scanner; PDFs are stored as they are. The new document opens
// in the viewer.
import { useCallback, useRef } from 'react';
import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { autoCropDocument } from '@/lib/document-detect';
import { deleteDisposableTemps } from '@/lib/files';
import { noteNewDocument } from '@/lib/new-doc-note';
import { VisionOcr } from '@/modules/vision-ocr/src';
import { useScan } from '@/contexts/scan-context';
import { documentNameFor, importKindOf, type ImportKind } from '@/lib/incoming-file';
import { patchDocument } from '@/lib/storage';
import { withSystemUI } from '@/lib/system-ui';
import { navigateWhenUnlocked } from '@/lib/nav-guard';

export { importKindOf } from '@/lib/incoming-file';
export type { ImportKind } from '@/lib/incoming-file';

/**
 * Auto-crops imported photos in order, one at a time (bounded memory), like
 * lib/document-detect's autoCropDocuments, but also reports which pages had
 * no page outline (kept as photographed), so the viewer can say so and offer
 * Crop instead of silently showing a photo of a desk.
 */
async function autoCropWithMisses(uris: string[], quality: number): Promise<{ pages: string[]; uncropped: number[] }> {
  const pages: string[] = [];
  const uncropped: number[] = [];
  // Without page detection (not iOS, an older build) nothing was looked for,
  // so nothing was "not found".
  const canDetect = typeof VisionOcr?.detectDocument === 'function';
  for (let i = 0; i < uris.length; i++) {
    const result = await autoCropDocument(uris[i], quality);
    pages.push(result.uri);
    if (canDetect && !result.detected) uncropped.push(i);
    // The picker's cache copy, replaced by its cropped copy: nothing reads it again.
    if (result.uri.split('?')[0] !== uris[i].split('?')[0]) deleteDisposableTemps([uris[i]]);
  }
  return { pages, uncropped };
}

export function useImportDocuments() {
  const { saveAndOpen } = useScan();
  const router = useRouter();
  const busy = useRef(false);

  // Called after a picker and an auto-crop: the app may have been locked
  // meanwhile, and the viewer must not open above the lock (lib/nav-guard).
  const open = useCallback((id: string | null, replace = false) => {
    if (!id) return;
    navigateWhenUnlocked(() => {
      if (replace) router.replace({ pathname: '/viewer', params: { id } });
      else router.push({ pathname: '/viewer', params: { id } });
    });
  }, [router]);

  /**
   * Saves local files as one new document and returns its id (null on failure,
   * after telling the user). Images become pages; a single PDF is kept as a PDF.
   */
  const saveFiles = useCallback(async (uris: string[], kind: ImportKind, name?: string | null): Promise<string | null> => {
    let id: string | null;
    let uncropped: number[] = [];
    if (kind === 'pdf') {
      id = await saveAndOpen({ pdfUri: uris[0] });
    } else {
      // Near-lossless here: saveScan compresses once more, at the user's scan quality.
      const cropped = await autoCropWithMisses(uris, 0.95);
      uncropped = cropped.uncropped;
      id = await saveAndOpen({ pages: cropped.pages });
    }
    // The viewer greets it: "Saved as …" with Rename, or Crop for a page whose
    // edges weren't found (lib/new-doc-note).
    if (id) noteNewDocument(id, { uncropped });
    // A file keeps its own name ("Invoice.pdf" → "Invoice") instead of "Scan <date>".
    if (id && name) await patchDocument(id, { name }).catch(() => {});
    return id;
  }, [saveAndOpen]);

  const importImages = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      // Tracked so the app lock doesn't present over the picker (lib/system-ui).
      const result = await withSystemUI(
        () => ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsMultipleSelection: true,
          orderedSelection: true,
          // Compressed once, at the user's scan quality, when stored.
          quality: 1,
        }),
        (): ImagePicker.ImagePickerResult => ({ canceled: true, assets: null }),
      );
      if (result.canceled || !result.assets.length) return;
      open(await saveFiles(result.assets.map(a => a.uri), 'image'));
    } catch (err) {
      console.error('Import images failed', err);
      Alert.alert('Couldn’t import photos', 'Check that Scan Kit can access your photos, then try again.');
    } finally {
      busy.current = false;
    }
  }, [open, saveFiles]);

  const importFile = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const result = await withSystemUI(
        () => DocumentPicker.getDocumentAsync({
          type: ['application/pdf', 'image/*'],
          copyToCacheDirectory: true,
        }),
        (): DocumentPicker.DocumentPickerResult => ({ canceled: true, assets: null }),
      );
      if (result.canceled || !result.assets.length) return;
      const asset = result.assets[0];
      const kind = importKindOf(asset.name || asset.uri, asset.mimeType) ?? 'image';
      open(await saveFiles([asset.uri], kind, documentNameFor(asset.name || asset.uri)));
    } catch (err) {
      console.error('Import file failed', err);
      Alert.alert('Couldn’t import the file', 'Choose a PDF or an image and try again.');
    } finally {
      busy.current = false;
    }
  }, [open, saveFiles]);

  return { importImages, importFile, saveFiles, open };
}
