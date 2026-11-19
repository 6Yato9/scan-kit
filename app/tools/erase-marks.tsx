// app/tools/erase-marks.tsx
// Whitens light pencil and pen marks by baking a high-contrast black-and-white
// filter into every page's pixels (lib/bake.ts). Bakes run from each page's
// pristine .orig copy, so the viewer's Undo can put every page back exactly as
// it was, its own earlier filter and adjustments included.
//
// Round 16: a strength (remembered in lib/tool-prefs.ts). On the Black &
// white filter Brightness moves the threshold (brighter = fewer dark pixels,
// so fainter marks go) and Contrast sets how hard edges are (lib/filters.ts);
// Standard is the +30 / +30 this tool always used.
import { useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { useRouter } from 'expo-router';
import { PrimaryButton } from '@/components/primary-button';
import {
  NoDocumentsScreen,
  OptionList,
  ToolIntro,
  ToolNote,
  ToolProgress,
  ToolScreen,
  pageCountLabel,
  useToolDocuments,
} from '@/components/tool-ui';
import { ToolDocPicker, useToolDoc } from '@/components/tool-doc';
import { SectionLabel } from '@/components/section-label';

import { eraseAdjustment, parseEraseStrength, type EraseStrength } from '@/lib/erase-strength';
import { readToolPrefs, TOOL_PREF_KEYS, writeToolPrefs } from '@/lib/tool-prefs';
import { FilterBaker } from '@/components/filter-baker';
import { bakePage, invalidateDocPreviews } from '@/lib/bake';
import { notifyError, notifySuccess } from '@/lib/haptics';
import type { Document, PageAdjustment, PageFilter } from '@/types/document';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { postViewerNotice } from '@/lib/viewer-notice';

const ERASE_FILTER: PageFilter = 'bw';

const STRENGTH_OPTIONS: { value: EraseStrength; label: string; detail: string }[] = [
  { value: 'light', label: 'Light', detail: 'Keeps faint print. Lifts only the lightest marks.' },
  { value: 'standard', label: 'Standard', detail: 'Pencil, highlighter and shadows go; text stays.' },
  { value: 'strong', label: 'Strong', detail: 'Also lifts darker marks. Thin or faint text may fade.' },
];

/** Puts every page back as it was before Erase marks (see run). */
async function undoErase(docId: string, before: { filter: PageFilter; adjustment: PageAdjustment | undefined }[]) {
  const results = await Promise.allSettled(before.map((b, i) => bakePage(docId, i, b.filter, b.adjustment)));
  invalidateDocPreviews(docId);
  if (results.some(r => r.status === 'rejected')) {
    notifyError();
    Alert.alert('Couldn’t undo on every page', 'Open Filters on a page that still looks black and white, and choose its filter again.');
    return;
  }
  postViewerNotice({ docId, message: 'Pages restored' });
}

export default function EraseMarksScreen() {
  const router = useRouter();
  const { docs, loaded } = useToolDocuments();
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [strength, setStrengthState] = useState<EraseStrength>('standard');
  useEffect(() => {
    let live = true;
    readToolPrefs(TOOL_PREF_KEYS.eraseMarks, parseEraseStrength).then(s => { if (live) setStrengthState(s); });
    return () => { live = false; };
  }, []);
  const setStrength = (s: EraseStrength) => {
    setStrengthState(s);
    writeToolPrefs(TOOL_PREF_KEYS.eraseMarks, { strength: s }).catch(() => {});
  };

  const { doc: selected, setDocId: setSelectedId, fixed, fromViewer } = useToolDoc(docs);
  const running = progress !== null;

  const run = async (doc: Document) => {
    const total = doc.pages.length;
    setProgress({ current: 0, total });
    // All pages are requested at once: the bake queue still runs them one at a
    // time, but each is tracked from the start, so an edit made meanwhile
    // re-targets the rest instead of baking stale page numbers.
    let done = 0;
    const results = await Promise.allSettled(
      doc.pages.map((_, i) =>
        bakePage(doc.id, i, ERASE_FILTER, eraseAdjustment(strength)).finally(() => {
          done++;
          setProgress({ current: done, total });
        }),
      ),
    );
    const failed = results.filter(r => r.status === 'rejected' || r.value === false).length;
    invalidateDocPreviews(doc.id);
    setProgress(null);

    if (failed === total) {
      notifyError();
      Alert.alert('Couldn’t clean up this document', 'No pages were changed. Try again.');
      return;
    }
    notifySuccess();
    // The viewer shows the toast, with Undo: it covers the app-wide toast host.
    // Undo re-bakes every page from its pristine .orig with the filter and
    // adjustments it had before, so earlier edits come back too (choosing
    // Original in Filters would have wiped those).
    const before = doc.pages.map((_, i) => ({ filter: doc.filters?.[i] ?? 'original', adjustment: doc.adjustments?.[i] }));
    postViewerNotice({
      docId: doc.id,
      message: failed ? `Cleaned ${total - failed} of ${total} pages` : 'Marks erased',
      action: { label: 'Undo', onPress: () => { void undoErase(doc.id, before); } },
    });
    // Opened from the viewer, go back to it rather than stacking a second one.
    navigateWhenUnlocked(() => {
      if (fromViewer) router.dismissTo({ pathname: '/viewer', params: { id: doc.id } });
      else router.replace({ pathname: '/viewer', params: { id: doc.id } });
    });
  };

  const handleApply = () => {
    if (!selected || running) return;
    run(selected);
  };

  if (loaded && docs.length === 0) {
    return (
      <NoDocumentsScreen
        toolTitle="Erase marks"
        icon="color-wand-outline"
        subtitle="Erase marks cleans up scanned pages. Scan or import a document first."
      />
    );
  }

  return (
    <ToolScreen
      title="Erase marks"
      footer={
        <>
          {progress ? (
            <ToolProgress
              label={`Cleaning page ${Math.min(progress.current + 1, progress.total)} of ${progress.total}…`}
              current={progress.current}
              total={progress.total}
            />
          ) : null}
          <PrimaryButton
            title={selected ? `Erase marks on ${pageCountLabel(selected.pages.length)}` : 'Erase marks'}
            onPress={handleApply}
            disabled={!selected}
            loading={running}
          />
        </>
      }
    >
      {/* Presented over the viewer: a baker underneath would never run (see FilterBaker). */}
      {fromViewer ? <FilterBaker /> : null}
      <ToolIntro
        icon="color-wand-outline"
        title="Remove light marks"
        text="Turns pages into crisp black and white and lifts faint pencil, highlighter and shadow marks."
      />
      <ToolDocPicker
        docs={docs}
        doc={selected}
        fixed={fixed}
        disabled={running}
        onPick={d => setSelectedId(d.id)}
      />
      <View pointerEvents={running ? 'none' : 'auto'}>
        <SectionLabel>Strength</SectionLabel>
        <OptionList options={STRENGTH_OPTIONS} value={strength} onChange={setStrength} />
      </View>
      <ToolNote>
        {'This changes the document itself, replacing any filters its pages have. You can undo it right\u00A0after.'}
      </ToolNote>
    </ToolScreen>
  );
}
