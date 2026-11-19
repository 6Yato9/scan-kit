// app/tools/whiteboard.tsx
// Scan (or import) whiteboard photos and save them with the Whiteboard filter
// (glare and the grey cast of the board removed, marker colours kept), which is
// baked into the pixels by the scan pipeline. Camera pages keep their photo so
// they can be re-cropped later.
//
// Round 16: the look of the saved pages (remembered in lib/tool-prefs.ts):
// marker colours kept (the Whiteboard filter, the default as before), or
// grayscale / black and white for printing and copying. Any page's filter can
// still be changed later in the viewer.
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useScan } from '@/contexts/scan-context';
import { PrimaryButton } from '@/components/primary-button';
import { Segmented, ToolIntro, ToolNote, ToolScreen } from '@/components/tool-ui';
import { MoreOptions } from '@/components/more-options';
import { SectionLabel } from '@/components/section-label';
import { oneOf, readToolPrefs, TOOL_PREF_KEYS, writeToolPrefs } from '@/lib/tool-prefs';
import { useRememberedPrefs } from '@/components/use-remembered-prefs';
import type { PageFilter } from '@/types/document';

import { alertScanError, deleteTempFiles, pickPhotos, scanPagesWithCamera } from '@/lib/tool-scan';
import type { ScanPageInput } from '@/lib/page-source';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { noteNewDocument } from '@/lib/new-doc-note';

type BoardLook = 'color' | 'gray' | 'bw';
const LOOK_FILTER: Record<BoardLook, PageFilter> = { color: 'whiteboard', gray: 'grayscale', bw: 'bw' };
const LOOK_OPTIONS: { value: BoardLook; label: string }[] = [
  { value: 'color', label: 'Color' },
  { value: 'gray', label: 'Grayscale' },
  { value: 'bw', label: 'Black & white' },
];

const DEFAULT_BOARD_PREFS: { look: BoardLook } = { look: 'color' };
const loadBoardPrefs = () =>
  readToolPrefs(TOOL_PREF_KEYS.whiteboard, o => ({ look: oneOf<BoardLook>(['color', 'gray', 'bw'], o.look, 'color') }));
const saveBoardPrefs = (p: { look: BoardLook }) => writeToolPrefs(TOOL_PREF_KEYS.whiteboard, { look: p.look });

export default function WhiteboardScreen() {
  const { saveAndOpen } = useScan();
  const router = useRouter();
  const [busy, setBusy] = useState<'camera' | 'photos' | null>(null);
  const busyRef = useRef(false);
  // Remembered; a choice made before it loads wins (components/use-remembered-prefs.ts).
  const [{ look }, setPrefs, latestPrefs] = useRememberedPrefs(DEFAULT_BOARD_PREFS, loadBoardPrefs, saveBoardPrefs);
  const [moreOpen, setMoreOpen] = useState(false);
  const setLook = (l: BoardLook) => setPrefs({ look: l });

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
      const id = await saveAndOpen({ pages, defaultFilter: LOOK_FILTER[latestPrefs().look] });
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
      <View pointerEvents={busy ? 'none' : 'auto'}>
        <MoreOptions open={moreOpen} onToggle={setMoreOpen} changed={look === 'color' ? 0 : 1}>
          <SectionLabel>Color</SectionLabel>
          <Segmented options={LOOK_OPTIONS} value={look} onChange={setLook} />
          <ToolNote>
            {look === 'color'
              ? 'Marker colors come out bold on a clean white board.'
              : look === 'gray'
                ? 'Shades of gray, on a clean white background. Good for printing.'
                : 'Pure black on white: the crispest copy, and the smallest file.'}
          </ToolNote>
        </MoreOptions>
      </View>
    </ToolScreen>
  );
}
