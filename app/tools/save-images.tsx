// app/tools/save-images.tsx
// Export a scanned document's pages as JPEG images: a single page is shared as
// the image itself (so "Save Image" puts it in Photos); several pages are
// bundled in a zip named after the document.
import { useState } from 'react';
import { Alert } from 'react-native';
import { Stack } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import JSZip from 'jszip';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import {
  DocRow,
  NoDocuments,
  ToolNote,
  ToolProgress,
  ToolScreen,
  pageCountLabel,
  useToolDocuments,
} from '@/components/tool-ui';
import {
  clearExportCache,
  exportFileName,
  makeExportDir,
  placeExportFile,
  shareFile,
  ShareError,
} from '@/lib/share';
import { notifyError } from '@/lib/haptics';
import type { Document } from '@/types/document';

/** "Invoice - page 03.jpg" style names, zero-padded so they sort correctly. */
export function pageImageName(docName: string, index: number, total: number): string {
  const digits = String(total).length;
  return exportFileName(`${docName} - page ${String(index + 1).padStart(Math.max(2, digits), '0')}`, 'jpg');
}

async function buildExport(doc: Document, onProgress: (done: number) => void): Promise<{ uri: string; zip: boolean }> {
  await clearExportCache();
  const dir = await makeExportDir();
  const total = doc.pages.length;
  if (total === 1) {
    const uri = await placeExportFile(doc.pages[0], dir, pageImageName(doc.name, 0, 1), 'copy');
    onProgress(1);
    return { uri, zip: false };
  }
  const zip = new JSZip();
  for (let i = 0; i < total; i++) {
    const b64 = await FileSystem.readAsStringAsync(doc.pages[i].split('?')[0], { encoding: 'base64' });
    zip.file(pageImageName(doc.name, i, total), b64, { base64: true });
    onProgress(i + 1);
  }
  // JPEGs are already compressed; STORE keeps zipping fast.
  const data = await zip.generateAsync({ type: 'base64', compression: 'STORE' });
  const uri = `${dir}${encodeURIComponent(exportFileName(`${doc.name} images`, 'zip'))}`;
  await FileSystem.writeAsStringAsync(uri, data, { encoding: 'base64' });
  return { uri, zip: true };
}

export default function SaveImagesScreen() {
  const { docs, loaded } = useToolDocuments();
  const [docId, setDocId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const doc = docs.find(d => d.id === docId) ?? null;

  const run = async () => {
    if (!doc || progress) return;
    setProgress({ current: 0, total: doc.pages.length });
    try {
      const out = await buildExport(doc, done => setProgress({ current: done, total: doc.pages.length }));
      setProgress(null);
      await shareFile(
        out.uri,
        out.zip
          ? { mimeType: 'application/zip', UTI: 'public.zip-archive', dialogTitle: doc.name }
          : { mimeType: 'image/jpeg', UTI: 'public.jpeg', dialogTitle: doc.name },
      );
    } catch (err) {
      notifyError();
      Alert.alert(
        'Couldn’t export the images',
        err instanceof ShareError ? err.message : 'A page couldn’t be read. Try again.',
      );
    } finally {
      setProgress(null);
    }
  };

  const header = <Stack.Screen options={{ headerShown: false }} />;

  if (loaded && docs.length === 0) {
    return (
      <>
        {header}
        <ToolScreen title="Save as images">
          <NoDocuments subtitle="Save as images exports scanned pages as JPEG files. Scan or import a document first." />
        </ToolScreen>
      </>
    );
  }

  const multi = !!doc && doc.pages.length > 1;

  return (
    <>
      {header}
      <ToolScreen
        title="Save as images"
        footer={
          <>
            {progress ? (
              <ToolProgress
                label={`Preparing page ${Math.min(progress.current + 1, progress.total)} of ${progress.total}…`}
                current={progress.current}
                total={progress.total}
              />
            ) : null}
            <PrimaryButton
              title={!doc ? 'Select a document' : multi ? `Export ${pageCountLabel(doc.pages.length)} as zip` : 'Export image'}
              icon="share-outline"
              onPress={run}
              disabled={!doc}
              loading={!!progress}
            />
          </>
        }
      >
        <SectionLabel>Document</SectionLabel>
        {docs.map(d => (
          <DocRow key={d.id} doc={d} selected={d.id === docId} onPress={() => !progress && setDocId(d.id)} />
        ))}
        <ToolNote>
          A one-page document is shared as a JPEG you can save to Photos. Longer documents are bundled into a zip of JPEGs.
        </ToolNote>
      </ToolScreen>
    </>
  );
}
