// app/tools/book.tsx
// Photograph open book spreads; each spread is split down the middle into its
// left and right page and saved as one document (all captures, in order).
// With Scan Kit's camera each half keeps the photo, split down the page's
// true middle in perspective (lib/capture-session.ts splitSpread), so either
// page can be re-cropped later.
import { useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { useScan } from '@/contexts/scan-context';
import { PrimaryButton } from '@/components/primary-button';
import { ToolIntro, ToolScreen } from '@/components/tool-ui';
import { splitSpreads } from '@/lib/book-split';
import { notifyError } from '@/lib/haptics';
import { alertScanError, deleteTempFiles, pickPhotos, scanPagesWithCamera } from '@/lib/tool-scan';
import { geometryOfInput, isSourceInput, type ScanPageInput } from '@/lib/page-source';
import { getImageSize } from '@/lib/image-size';
import { splitSpread, toSourceInput } from '@/lib/capture-session';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { noteNewDocument } from '@/lib/new-doc-note';

export default function BookScreen() {
  const { saveAndOpen } = useScan();
  const router = useRouter();
  const [busy, setBusy] = useState<'camera' | 'photos' | null>(null);
  const busyRef = useRef(false);

  const run = async (source: 'camera' | 'photos') => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(source);
    let temps: string[] = [];
    try {
      let shots: ScanPageInput[] | null;
      try {
        // No auto-crop: page detection would pick one page out of a two-page spread.
        shots = source === 'camera'
          ? await scanPagesWithCamera({ title: 'Book mode', guidance: 'Fit the open book in the frame' })
          : await pickPhotos(true, { autoCrop: false });
      } catch (err) {
        alertScanError(err);
        return;
      }
      if (!shots?.length) return;
      if (source === 'photos') temps.push(...(shots as string[]));

      let pages: ScanPageInput[];
      try {
        pages = [];
        for (const shot of shots) {
          if (isSourceInput(shot)) {
            // A photo and its reviewed crop: split the crop, keep the photo.
            const size = await getImageSize(shot.sourceUri);
            const halves = size ? splitSpread(geometryOfInput(shot), size.width, size.height) : [geometryOfInput(shot)];
            pages.push(...halves.map(g => toSourceInput(shot.sourceUri, g)));
          } else {
            const split = await splitSpreads([shot]);
            pages.push(...split.pages);
            temps = temps.concat(split.temps);
          }
        }
      } catch {
        notifyError();
        Alert.alert('Couldn’t split the pages', 'The photo couldn’t be processed. Try again with a clearer shot.');
        return;
      }
      // saveAndOpen copies the pages into storage before it resolves.
      const id = await saveAndOpen({ pages });
      if (id) noteNewDocument(id);
      if (id) navigateWhenUnlocked(() => router.replace({ pathname: '/viewer', params: { id } }));
    } finally {
      deleteTempFiles(temps);
      busyRef.current = false;
      setBusy(null);
    }
  };

  return (
    <ToolScreen
      title="Book mode"
      footer={
        <>
          <PrimaryButton
            title="Scan spreads"
            icon="camera-outline"
            onPress={() => run('camera')}
            disabled={busy !== null}
            loading={busy === 'camera'}
          />
          <PrimaryButton
            title="Import photos"
            icon="images-outline"
            variant="secondary"
            onPress={() => run('photos')}
            disabled={busy !== null}
            loading={busy === 'photos'}
          />
        </>
      }
    >
      <ToolIntro
        icon="book-outline"
        title="Scan a book"
        text="Capture an open book one spread at a time. Each spread becomes two pages."
        points={[
          { icon: 'phone-portrait-outline', text: 'Hold the phone level above the open book, with both pages in view.' },
          { icon: 'cut-outline', text: 'Each spread is split down the middle into a left and a right page.' },
          { icon: 'documents-outline', text: 'All spreads are saved, in order, as one document.' },
        ]}
      />
    </ToolScreen>
  );
}
