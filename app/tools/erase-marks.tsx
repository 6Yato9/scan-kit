// app/tools/erase-marks.tsx
// Whitens light pencil and pen marks by baking a high-contrast black-and-white
// filter into every page's pixels (lib/bake.ts). Bakes run from each page's
// pristine .orig copy, so the viewer's "Original" filter can still undo it.
import { useState } from 'react';
import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import {
  DocGroup,
  DocRow,
  NoDocumentsScreen,
  ToolIntro,
  ToolNote,
  ToolProgress,
  ToolScreen,
  pageCountLabel,
  useToolDocuments,
} from '@/components/tool-ui';
import { ToolDocHeader, useToolDoc } from '@/components/tool-doc';
import { FilterBaker } from '@/components/filter-baker';
import { bakePage, invalidateDocPreviews } from '@/lib/bake';
import { notifyError, notifySuccess } from '@/lib/haptics';
import type { Document, PageAdjustment, PageFilter } from '@/types/document';

const ERASE_FILTER: PageFilter = 'bw';
const ERASE_ADJUSTMENT: PageAdjustment = { brightness: 30, contrast: 30, saturation: 0 };

export default function EraseMarksScreen() {
  const router = useRouter();
  const { docs, loaded } = useToolDocuments();
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);

  const { doc: selected, docId: selectedId, setDocId: setSelectedId, fixed, fromViewer } = useToolDoc(docs);
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
        bakePage(doc.id, i, ERASE_FILTER, { ...ERASE_ADJUSTMENT }).finally(() => {
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
    const notice = failed ? `Cleaned ${total - failed} of ${total} pages` : 'Marks erased';
    // The viewer shows the toast: it covers the app-wide toast host. Opened from
    // the viewer, go back to it rather than stacking a second one.
    if (fromViewer) router.dismissTo({ pathname: '/viewer', params: { id: doc.id, notice } });
    else router.replace({ pathname: '/viewer', params: { id: doc.id, notice } });
  };

  const handleApply = () => {
    if (!selected || running) return;
    const hasEdits =
      selected.filters?.some(f => f && f !== 'original') ||
      selected.adjustments?.some(a => a && (a.brightness !== 0 || a.contrast !== 0 || a.saturation !== 0));
    if (hasEdits) {
      Alert.alert(
        'Replace current filters?',
        'This document already has filters or adjustments. Erase marks will replace them on every page.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Replace', onPress: () => run(selected) },
        ],
      );
      return;
    }
    run(selected);
  };

  if (loaded && docs.length === 0) {
    return (
      <NoDocumentsScreen
        toolTitle="Erase marks"
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
        compact
        icon="color-wand-outline"
        title="Remove light marks"
        text="Turns pages into crisp black and white and lifts faint pencil, highlighter and shadow marks."
      />
      {fixed && selected ? (
        <ToolDocHeader doc={selected} />
      ) : (
        <>
          <SectionLabel>Document</SectionLabel>
          <DocGroup>
            {docs.map(doc => (
              <DocRow
                key={doc.id}
                doc={doc}
                selected={doc.id === selectedId}
                onPress={() => !running && setSelectedId(doc.id)}
              />
            ))}
          </DocGroup>
        </>
      )}
      <ToolNote>
        Changes the document itself. To undo, open it, tap Filters and choose Original. Apply to all undoes every page at once.
      </ToolNote>
    </ToolScreen>
  );
}
