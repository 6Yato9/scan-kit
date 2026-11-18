// app/tools/timestamp.tsx
// Print the scan date (or today's date) in a corner of every page and save
// the result as a new PDF.
import { useState } from 'react';
import { Alert, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';
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
import { generatePdf } from '@/lib/pdf';
import { copyPdfToStorage, deleteDocumentFiles } from '@/lib/files';
import { deleteQuietly } from '@/lib/share';
import { getDocSettings, saveDocument } from '@/lib/storage';
import { notifyError, notifySuccess } from '@/lib/haptics';
import {
  CORNER_INSET,
  TIMESTAMP_FONT_FRACTION,
  formatStamp,
  timestampOverlay,
  type Corner,
  type TimestampFormat,
} from '@/lib/stamp';
import { Ink, Spacing } from '@/lib/theme';
import { navigateWhenUnlocked } from '@/lib/nav-guard';

type When = 'scanned' | 'now';

const CORNERS: { value: Corner; label: string }[] = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-right', label: 'Top right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-right', label: 'Bottom right' },
];

export default function TimestampScreen() {
  const router = useRouter();
  const { width: screenW } = useWindowDimensions();
  const { docs, loaded } = useToolDocuments();
  const [when, setWhen] = useState<When>('scanned');
  const [format, setFormat] = useState<TimestampFormat>('datetime');
  const [corner, setCorner] = useState<Corner>('bottom-right');
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [now] = useState(() => Date.now());

  // Never a default: stamping the wrong document is worse than one more tap.
  const { doc, setDocId, fixed, fromViewer } = useToolDoc(docs);
  const aspect = useImageAspect(doc?.pages[0]);
  const stamp = formatStamp(when === 'scanned' && doc ? doc.createdAt : now, format);

  const apply = async () => {
    if (!doc || progress) return;
    const id = Crypto.randomUUID();
    let temp: string | null = null;
    const text = formatStamp(when === 'scanned' ? doc.createdAt : Date.now(), format);
    setProgress({ current: 0, total: doc.pages.length });
    try {
      const { pdfPageSize } = await getDocSettings();
      temp = await generatePdf(doc.pages, {
        pageSize: pdfPageSize,
        overlayHtml: (_i, size) => timestampOverlay(text, corner, size.width),
        onProgress: done => setProgress({ current: done, total: doc.pages.length }),
      });
      const stored = copyPdfToStorage(temp, id);
      const ts = Date.now();
      await saveDocument({
        id,
        name: `${doc.name} (timestamped)`,
        pages: [],
        pdfUri: stored,
        folder: doc.folder,
        createdAt: ts,
        updatedAt: ts,
      });
      notifySuccess();
      // The viewer shows the toast: it covers the app-wide toast host.
      navigateWhenUnlocked(() => router.replace({ pathname: '/viewer', params: { id, notice: 'Timestamped copy saved. The original is unchanged.' } }));
    } catch {
      try { deleteDocumentFiles(id); } catch {}
      notifyError();
      Alert.alert('Couldn’t add the timestamp', 'The PDF couldn’t be created. Try again, or try with fewer pages.');
    } finally {
      deleteQuietly(temp);
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
              label={`Stamping page ${Math.min(progress.current + 1, progress.total)} of ${progress.total}…`}
              current={progress.current}
              total={progress.total}
            />
          ) : null}
          <PrimaryButton title={doc ? 'Save timestamped copy' : 'Choose a document'} onPress={apply} disabled={!doc} loading={!!progress} />
        </>
      }
    >
      {/* Presented over the viewer: a baker underneath would never run (see FilterBaker). */}
      {fromViewer ? <FilterBaker /> : null}
      <ToolDocPicker docs={docs} doc={doc} fixed={fixed} disabled={!!progress} onPick={d => setDocId(d.id)} />

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

      <ToolNote>A new PDF is saved with the date on every page. The original document is kept.</ToolNote>
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  previewWrap: { marginTop: Spacing.lg },
});
