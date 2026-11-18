// app/tools/timestamp.tsx
// Print the scan date (or today's date) on every page of the document itself
// (drawn into the pages, so they stay searchable and re-filterable; the viewer
// offers Undo — lib/page-stamp.ts), or of a copy. The date starts in the
// bottom-right corner and is dragged anywhere on the page preview
// (components/placement-frame.tsx LabelPlacer); it settles on the corners,
// the edges' middles and the centre, and always keeps clear of the page edge.
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import {
  FooterActions,
  NoDocumentsScreen,
  OptionList,
  PagePreview,
  Segmented,
  ToolNote,
  ToolProgress,
  ToolScreen,
  useImageAspect,
  useToolDocuments,
} from '@/components/tool-ui';
import { ToolDocPicker, useConvertiblePdfs, useToolDoc, type PickerConvert } from '@/components/tool-doc';
import { FilterBaker } from '@/components/filter-baker';
import { LabelPlacer } from '@/components/placement-frame';
import { reportStampFailure, usePageStamper, useStampFinish } from '@/components/page-stamper';
import { copyName, stampCopy, stampPages, targetPages } from '@/lib/page-stamp';
import { notifySuccess } from '@/lib/haptics';
import {
  CORNER_INSET,
  TIMESTAMP_FONT_FRACTION,
  formatStamp,
  type TimestampFormat,
} from '@/lib/stamp';
import { cornerAnchor, type Anchor } from '@/lib/placement';
import { Ink, Spacing } from '@/lib/theme';

type When = 'scanned' | 'now';

/** Where a new timestamp goes: the bottom-right corner, as before. */
const START: Anchor = cornerAnchor('bottom-right');

export default function TimestampScreen() {
  const { width: screenW, height: screenH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { docs, loaded, reload } = useToolDocuments();
  // Imported PDFs: listed in the picker with Convert, never a dead end.
  const { pdfs, loaded: pdfsLoaded, reload: reloadPdfs } = useConvertiblePdfs();
  const [when, setWhen] = useState<When>('scanned');
  const [format, setFormat] = useState<TimestampFormat>('datetime');
  const [anchor, setAnchor] = useState<Anchor>(START);
  // A finger is moving the date: the screen doesn't scroll.
  const [placing, setPlacing] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [now] = useState(() => Date.now());

  // Never a default: stamping the wrong document is worse than one more tap.
  const { doc, docId, setDocId, fixed, fromViewer } = useToolDoc(docs);
  const stamper = usePageStamper();
  const finish = useStampFinish(fromViewer);
  // From the Tools tab with a single document: there is nothing to choose.
  useEffect(() => {
    if (loaded && !fixed && !docId && docs.length === 1) setDocId(docs[0].id);
  }, [loaded, fixed, docId, docs, setDocId]);
  const aspect = useImageAspect(doc?.pages[0]);
  const stamp = formatStamp(when === 'scanned' && doc ? doc.createdAt : now, format);

  /** Stamps every page of the document itself (Undo in the viewer), or of a copy. */
  const apply = async (mode: 'in-place' | 'copy') => {
    if (!doc || progress) return;
    const text = formatStamp(when === 'scanned' ? doc.createdAt : Date.now(), format);
    // `corner` is the nearest one, for anything that reads only that.
    const corner = `${anchor.y < 0.5 ? 'top' : 'bottom'}-${anchor.x < 0.5 ? 'left' : 'right'}` as const;
    const spec = { kind: 'timestamp' as const, text, corner, anchor };
    const render = (pageUri: string, origUri: string | null) => stamper.stamp(pageUri, origUri, spec);
    const pages = targetPages(doc.pages.length, 0, true);
    const onProgress = (done: number, total: number) => setProgress({ current: done, total });
    setProgress({ current: 0, total: pages.length });
    try {
      if (mode === 'copy') {
        const copy = await stampCopy(doc, copyName(doc.name, 'timestamped'), pages, render, onProgress, stamper.signal);
        notifySuccess();
        finish({ docId: copy.id, message: 'Timestamped copy saved. The original is unchanged.', openCopy: true });
      } else {
        const { undo } = await stampPages(doc.id, pages, render, { onProgress, signal: stamper.signal });
        notifySuccess();
        finish({
          docId: doc.id,
          message: pages.length > 1 ? `Timestamp added to ${pages.length} pages` : 'Timestamp added',
          undo,
          undoneMessage: 'Timestamp removed',
        });
      }
    } catch (err) {
      // Says only what is true: cancelled (closed), partly done, or unchanged.
      reportStampFailure(err, 'Couldn’t add the timestamp', 'Timestamp removed');
    } finally {
      setProgress(null);
    }
  };

  // Picking an imported PDF converts it to pages (with Undo), then chooses it.
  const convert: PickerConvert = {
    pdfs,
    verb: 'timestamp',
    onConverted: d => {
      reload();
      reloadPdfs();
      setDocId(d.id);
    },
    onUndone: id => {
      reload();
      reloadPdfs();
      if (docId === id) setDocId(null);
    },
  };

  if (loaded && pdfsLoaded && docs.length === 0 && pdfs.length === 0) {
    return (
      <NoDocumentsScreen
        toolTitle="Timestamp"
        icon="time-outline"
        subtitle="Timestamp prints the date on every page of a scan. Scan or import a document first."
      />
    );
  }

  // Large enough to drag the date with a finger; never taller than about
  // 40% of the screen, so the date choice stays close below it.
  const maxPreviewW = screenW - Spacing.gutter * 2 - Spacing.sm * 2;
  const maxPreviewH = Math.max(220, (screenH - insets.top - insets.bottom) * 0.4);
  const previewW = Math.floor(Math.min(maxPreviewW, maxPreviewH / aspect));
  const previewH = previewW * aspect;
  const fontSize = TIMESTAMP_FONT_FRACTION * previewW;

  return (
    <ToolScreen
      title="Timestamp"
      busy={!!progress}
      scrollEnabled={!placing}
      footer={
        <>
          {progress ? (
            <ToolProgress
              label={progress.total > 1 ? `Stamping page ${Math.min(progress.current + 1, progress.total)} of ${progress.total}…` : 'Stamping…'}
              current={progress.current}
              total={progress.total}
            />
          ) : null}
          <FooterActions
            secondary={
              <PrimaryButton title="Save as a copy" variant="secondary" onPress={() => apply('copy')} disabled={!doc || !!progress} />
            }
            primary={<PrimaryButton title="Add timestamp" onPress={() => apply('in-place')} disabled={!doc} loading={!!progress} />}
          />
        </>
      }
    >
      {/* Presented over the viewer: a baker underneath would never run (see FilterBaker). */}
      {fromViewer ? <FilterBaker /> : null}
      {stamper.host}
      <ToolDocPicker
        docs={docs}
        doc={doc}
        fixed={fixed}
        disabled={!!progress}
        onPick={d => setDocId(d.id)}
        autoOpen={loaded && !fromViewer}
        convert={convert}
      />

      {/* Live preview: the first page (a sample page until one is chosen)
          with the stamp exactly where the pages will get it. Drag it to move it. */}
      <View style={styles.previewWrap}>
        {doc ? (
          <LabelPlacer
            uri={`${doc.pages[0]}?v=${doc.updatedAt}`}
            width={previewW}
            height={previewH}
            inset={CORNER_INSET * previewW}
            anchor={anchor}
            onChange={setAnchor}
            onInteracting={setPlacing}
            label="Date"
          >
            <View
              style={{
                paddingVertical: fontSize * 0.35,
                paddingHorizontal: fontSize * 0.6,
                borderRadius: fontSize * 0.3,
                backgroundColor: Ink.stampBg,
              }}
            >
              <Text style={{ fontSize, lineHeight: fontSize * 1.15, fontWeight: '500', color: Ink.stampText }} numberOfLines={1}>
                {stamp}
              </Text>
            </View>
          </LabelPlacer>
        ) : (
          <PagePreview uri={null} aspect={aspect} width={previewW} />
        )}
      </View>
      <ToolNote>
        {doc ? 'Drag the date to move it. It settles on the corners and the middle of each edge.' : 'Choose a document to place the date on its pages.'}
      </ToolNote>

      <SectionLabel>Date</SectionLabel>
      <OptionList
        options={[
          // Both rows always carry a detail line, so they are the same height.
          { value: 'scanned' as When, label: 'Date scanned', detail: doc ? formatStamp(doc.createdAt, format) : 'From the document you choose' },
          { value: 'now' as When, label: 'Current date', detail: formatStamp(now, format) },
        ]}
        value={when}
        onChange={setWhen}
      />

      <SectionLabel>Format</SectionLabel>
      <Segmented
        options={[
          { value: 'datetime' as TimestampFormat, label: 'Date and time' },
          { value: 'date' as TimestampFormat, label: 'Date only' },
        ]}
        value={format}
        onChange={setFormat}
      />

      <ToolNote>The date becomes part of every page, and you can undo it right after. To keep this document as it is, save a timestamped copy instead.</ToolNote>
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  previewWrap: { marginTop: Spacing.lg },
});
