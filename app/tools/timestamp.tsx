// app/tools/timestamp.tsx
// Print the scan date (or today's date) in a corner of every page of the
// document itself (drawn into the pages, so they stay searchable and
// re-filterable; the viewer offers Undo — lib/page-stamp.ts), or of a copy.
import { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import {
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
import { ToolDocPicker, useToolDoc } from '@/components/tool-doc';
import { FilterBaker } from '@/components/filter-baker';
import { usePageStamper, useStampFinish } from '@/components/page-stamper';
import { copyName, PDF_NOT_LISTED_NOTE, stampCopy, stampPages, StampError, targetPages } from '@/lib/page-stamp';
import { notifyError, notifySuccess } from '@/lib/haptics';
import {
  CORNER_INSET,
  TIMESTAMP_FONT_FRACTION,
  formatStamp,
  type Corner,
  type TimestampFormat,
} from '@/lib/stamp';
import { Ink, Spacing } from '@/lib/theme';

type When = 'scanned' | 'now';

const CORNERS: { value: Corner; label: string }[] = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-right', label: 'Top right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-right', label: 'Bottom right' },
];

export default function TimestampScreen() {
  const { width: screenW } = useWindowDimensions();
  const { docs, loaded } = useToolDocuments();
  const [when, setWhen] = useState<When>('scanned');
  const [format, setFormat] = useState<TimestampFormat>('datetime');
  const [corner, setCorner] = useState<Corner>('bottom-right');
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [now] = useState(() => Date.now());

  // Never a default: stamping the wrong document is worse than one more tap.
  const { doc, setDocId, fixed, fromViewer } = useToolDoc(docs);
  const stamper = usePageStamper();
  const finish = useStampFinish(fromViewer);
  // From the Tools tab with a single document: there is nothing to choose.
  useEffect(() => {
    if (loaded && !fixed && !doc && docs.length === 1) setDocId(docs[0].id);
  }, [loaded, fixed, doc, docs, setDocId]);
  const aspect = useImageAspect(doc?.pages[0]);
  const stamp = formatStamp(when === 'scanned' && doc ? doc.createdAt : now, format);

  /** Stamps every page of the document itself (Undo in the viewer), or of a copy. */
  const apply = async (mode: 'in-place' | 'copy') => {
    if (!doc || progress) return;
    const text = formatStamp(when === 'scanned' ? doc.createdAt : Date.now(), format);
    const spec = { kind: 'timestamp' as const, text, corner };
    const render = (pageUri: string, origUri: string | null) => stamper.stamp(pageUri, origUri, spec);
    const pages = targetPages(doc.pages.length, 0, true);
    const onProgress = (done: number, total: number) => setProgress({ current: done, total });
    setProgress({ current: 0, total: pages.length });
    try {
      if (mode === 'copy') {
        const copy = await stampCopy(doc, copyName(doc.name, 'timestamped'), pages, render, onProgress);
        notifySuccess();
        finish({ docId: copy.id, message: 'Timestamped copy saved. The original is unchanged.', openCopy: true });
      } else {
        const { undo } = await stampPages(doc.id, pages, render, { onProgress });
        notifySuccess();
        finish({
          docId: doc.id,
          message: pages.length > 1 ? `Timestamp added to ${pages.length} pages` : 'Timestamp added',
          undo,
          undoneMessage: 'Timestamp removed',
        });
      }
    } catch (err) {
      notifyError();
      if (!(err instanceof StampError)) console.error('Timestamp failed', err);
      Alert.alert(
        'Couldn’t add the timestamp',
        err instanceof StampError ? err.message : 'Your document is unchanged. Try again.',
      );
    } finally {
      setProgress(null);
    }
  };

  if (loaded && docs.length === 0) {
    return (
      <NoDocumentsScreen
        toolTitle="Timestamp"
        icon="time-outline"
        subtitle="Timestamp prints the date on every page of a scan. Scan or import a document first."
      />
    );
  }

  // Small enough that the date choice stays above the fold.
  const previewW = Math.min(screenW * 0.5, 220);

  return (
    <ToolScreen
      title="Timestamp"
      footer={
        <>
          {progress ? (
            <ToolProgress
              label={progress.total > 1 ? `Stamping page ${Math.min(progress.current + 1, progress.total)} of ${progress.total}…` : 'Stamping…'}
              current={progress.current}
              total={progress.total}
            />
          ) : null}
          <PrimaryButton title="Add timestamp" onPress={() => apply('in-place')} disabled={!doc} loading={!!progress} />
          {doc && !progress ? (
            <PrimaryButton title="Save as a copy" variant="secondary" onPress={() => apply('copy')} style={styles.secondary} />
          ) : null}
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
        note={PDF_NOT_LISTED_NOTE}
      />

      {/* Live preview: the first page (a sample page until one is chosen) with
          the stamp where the PDF will get it. */}
      <View style={styles.previewWrap}>
        <PagePreview uri={doc ? `${doc.pages[0]}?v=${doc.updatedAt}` : null} aspect={aspect} width={previewW}>
          {({ width }) => {
            const fontSize = TIMESTAMP_FONT_FRACTION * width;
            const inset = CORNER_INSET * width;
            const [v, h] = corner.split('-') as ['top' | 'bottom', 'left' | 'right'];
            return (
              <View
                style={{
                  position: 'absolute',
                  [v]: inset,
                  [h]: inset,
                  paddingVertical: fontSize * 0.35,
                  paddingHorizontal: fontSize * 0.6,
                  borderRadius: fontSize * 0.3,
                  backgroundColor: Ink.stampBg,
                }}
              >
                <Text style={{ fontSize, fontWeight: '500', color: Ink.stampText }} numberOfLines={1}>
                  {stamp}
                </Text>
              </View>
            );
          }}
        </PagePreview>
      </View>

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

      <SectionLabel>Position</SectionLabel>
      <OptionList options={CORNERS} value={corner} onChange={setCorner} />

      <ToolNote>The date becomes part of every page, and you can undo it right after. To keep this document as it is, save a timestamped copy instead.</ToolNote>
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  previewWrap: { marginTop: Spacing.lg },
  secondary: { marginTop: Spacing.sm },
});
