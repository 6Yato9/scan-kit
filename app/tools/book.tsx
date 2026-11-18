// app/tools/book.tsx
// Photograph open book spreads; each spread is split down the middle into its
// left and right page and saved as one document (all captures, in order).
import { useRef, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useScan } from '@/contexts/scan-context';
import { PrimaryButton } from '@/components/primary-button';
import { ToolIntro, ToolScreen } from '@/components/tool-ui';
import { splitSpreads } from '@/lib/book-split';
import { notifyError } from '@/lib/haptics';
import { alertScanError, deleteTempFiles, pickPhotos, scanWithCamera } from '@/lib/tool-scan';

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
      let shots: string[] | null;
      try {
        // No auto-crop: page detection would pick one page out of a two-page spread.
        shots = source === 'camera' ? await scanWithCamera() : await pickPhotos(true, { autoCrop: false });
      } catch (err) {
        alertScanError(err);
        return;
      }
      if (!shots?.length) return;
      if (source === 'photos') temps.push(...shots);

      let pages: string[];
      try {
        const split = await splitSpreads(shots);
        pages = split.pages;
        temps = temps.concat(split.temps);
      } catch {
        notifyError();
        Alert.alert('Couldn’t split the pages', 'The photo couldn’t be processed. Try again with a clearer shot.');
        return;
      }
      // saveAndOpen copies the pages into storage before it resolves.
      const id = await saveAndOpen({ pages });
      if (id) router.replace({ pathname: '/viewer', params: { id } });
    } finally {
      deleteTempFiles(temps);
      busyRef.current = false;
      setBusy(null);
    }
  };

  return (
    <ToolScreen
      title="Book mode"
      scroll={false}
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
            title="Choose photos"
            icon="images-outline"
            variant="secondary"
            onPress={() => run('photos')}
            disabled={busy !== null}
            loading={busy === 'photos'}
          />
        </>
      }
    >
      <View style={styles.center}>
        <ToolIntro
          icon="book-outline"
          title="Scan a book"
          text="Capture an open book, one spread at a time. Each spread is split down the middle into a left and a right page."
        />
      </View>
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center' },
});
