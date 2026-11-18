// app/tools/whiteboard.tsx
// Scan (or import) whiteboard photos and save them with the Whiteboard filter
// (glare and the grey cast of the board removed, marker colours kept), which is
// baked into the pixels by the scan pipeline. Camera pages keep their photo so
// they can be re-cropped later.
import { useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { useScan } from '@/contexts/scan-context';
import { PrimaryButton } from '@/components/primary-button';
import { ToolIntro, ToolScreen } from '@/components/tool-ui';
import { alertScanError, deleteTempFiles, pickPhotos, scanPagesWithCamera } from '@/lib/tool-scan';
import type { ScanPageInput } from '@/lib/page-source';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { noteNewDocument } from '@/lib/new-doc-note';

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
      let pages: ScanPageInput[] | null;
      try {
        pages = source === 'camera'
          ? await scanPagesWithCamera({ title: 'Whiteboard', guidance: 'Fit the whole board in the frame' })
          : await pickPhotos(true);
      } catch (err) {
        alertScanError(err);
        return;
      }
      if (!pages?.length) return;
      if (source === 'photos') picked = pages as string[];
      const id = await saveAndOpen({ pages, defaultFilter: 'whiteboard' });
      if (id) noteNewDocument(id);
      if (id) navigateWhenUnlocked(() => router.replace({ pathname: '/viewer', params: { id } }));
    } finally {
      deleteTempFiles(picked);
      busyRef.current = false;
      setBusy(null);
    }
  };

  return (
    <ToolScreen
      title="Whiteboard"
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
        icon="easel-outline"
        title="Scan a whiteboard"
        text="Marker writing stays crisp and the board comes out clean and bright."
        points={[
          { icon: 'scan-outline', text: 'Stand square to the board so its edges are detected.' },
          { icon: 'sparkles-outline', text: 'Glare and faint ghosts of old writing are removed; marker colors come out bold.' },
          { icon: 'color-filter-outline', text: 'Change the filter for one page, or all of them, later in the viewer.' },
        ]}
      />
    </ToolScreen>
  );
}
