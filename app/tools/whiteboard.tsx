// app/tools/whiteboard.tsx
// Scan (or import) whiteboard photos and save them with the Enhanced filter,
// which is baked into the pixels by the scan pipeline.
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useScan } from '@/contexts/scan-context';
import { PrimaryButton } from '@/components/primary-button';
import { ToolIntro, ToolScreen } from '@/components/tool-ui';
import { alertScanError, deleteTempFiles, pickPhotos, scanWithCamera } from '@/lib/tool-scan';

export default function WhiteboardScreen() {
  const { saveAndOpen } = useScan();
  const router = useRouter();
  const [busy, setBusy] = useState<'camera' | 'photos' | null>(null);
  const busyRef = useRef(false);

  const run = async (source: 'camera' | 'photos') => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(source);
    let picked: string[] = [];
    try {
      let pages: string[] | null;
      try {
        pages = source === 'camera' ? await scanWithCamera() : await pickPhotos(true);
      } catch (err) {
        alertScanError(err);
        return;
      }
      if (!pages?.length) return;
      if (source === 'photos') picked = pages;
      const id = await saveAndOpen({ pages, defaultFilter: 'enhanced' });
      if (id) router.replace({ pathname: '/viewer', params: { id } });
    } finally {
      deleteTempFiles(picked);
      busyRef.current = false;
      setBusy(null);
    }
  };

  return (
    <ToolScreen
      title="Whiteboard"
      scroll={false}
      footer={
        <>
          <PrimaryButton
            title="Scan whiteboard"
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
          icon="easel-outline"
          title="Scan a whiteboard"
          text="Contrast and color are boosted automatically so marker writing stays crisp and the board looks clean."
        />
      </View>
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center' },
});
