// app/tools/timestamp.tsx
// Print the scan date (or today's date) in a corner of every page and save
// the result as a new PDF.
import { useState } from 'react';
import { Alert, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import { useToast } from '@/components/toast';
import {
  DocRow,
  NoDocuments,
  OptionList,
  PagePreview,
  Segmented,
  ToolNote,
  ToolProgress,
  ToolScreen,
  useImageAspect,
  useToolDocuments,
} from '@/components/tool-ui';
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
import { Spacing } from '@/lib/theme';

type When = 'scanned' | 'now';

const CORNERS: { value: Corner; label: string }[] = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-right', label: 'Top right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-right', label: 'Bottom right' },
];

export default function TimestampScreen() {
  const router = useRouter();
  const { show } = useToast();
  const { width: screenW } = useWindowDimensions();
  const { docs, loaded } = useToolDocuments();
  const [docId, setDocId] = useState<string | null>(null);
  const [when, setWhen] = useState<When>('scanned');
  const [format, setFormat] = useState<TimestampFormat>('datetime');
  const [corner, setCorner] = useState<Corner>('bottom-right');
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [now] = useState(() => Date.now());

  const doc = docs.find(d => d.id === docId) ?? docs[0] ?? null;
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
      show('Timestamped PDF saved');
      router.replace({ pathname: '/viewer', params: { id } });
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
      <ToolScreen title="Timestamp">
        <NoDocuments subtitle="Timestamp prints the date on every page of a scan. Scan or import a document first." />
      </ToolScreen>
    );
  }

  const previewW = Math.min(screenW * 0.62, 260);

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
          <PrimaryButton title="Save timestamped PDF" onPress={apply} disabled={!doc} loading={!!progress} />
        </>
      }
    >
      {doc ? (
        <View style={styles.previewWrap}>
          <PagePreview uri={`${doc.pages[0]}?v=${doc.updatedAt}`} aspect={aspect} width={previewW}>
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
                    backgroundColor: 'rgba(255,255,255,0.85)',
                  }}
                >
                  <Text style={{ fontSize, fontWeight: '500', color: '#222' }} numberOfLines={1}>
                    {stamp}
                  </Text>
                </View>
              );
            }}
          </PagePreview>
        </View>
      ) : null}

      <SectionLabel>Date</SectionLabel>
      <OptionList
        options={[
          { value: 'scanned' as When, label: 'Date scanned', detail: doc ? formatStamp(doc.createdAt, format) : undefined },
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

      <SectionLabel>Document</SectionLabel>
      {docs.map(d => (
        <DocRow key={d.id} doc={d} selected={d.id === doc?.id} onPress={() => !progress && setDocId(d.id)} />
      ))}
      <ToolNote>A new PDF is saved with the date on every page. The original document is kept.</ToolNote>
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  previewWrap: { marginTop: Spacing.lg },
});
