// app/tools/compress.tsx
// Shrinks a scanned document's page images in place (lib/compress.ts) and
// reports the size before and after. Imported PDFs are not supported — their
// pages aren't images this app can re-encode — so they aren't listed.
import { useMemo, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import { useToast } from '@/components/toast';
import {
  NoDocumentsScreen,
  OptionList,
  ToolIntro,
  ToolNote,
  ToolProgress,
  ToolScreen,
  formatBytes,
  useToolDocuments,
} from '@/components/tool-ui';
import { ToolDocPicker, useToolDoc } from '@/components/tool-doc';
import { FilterBaker } from '@/components/filter-baker';
import { compressDocument, documentSize, type CompressLevel, type CompressResult } from '@/lib/compress';
import { invalidateDocPreviews } from '@/lib/bake';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { Radius, Spacing, Type } from '@/lib/theme';

const LEVELS: { value: CompressLevel; label: string; detail: string }[] = [
  { value: 'small', label: 'Smallest file', detail: 'Good for email. Fine print may soften.' },
  { value: 'balanced', label: 'Balanced', detail: 'Clear text at a much smaller size.' },
  { value: 'sharp', label: 'Sharp', detail: 'Near-original detail, smaller saving.' },
];

export default function CompressScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { show } = useToast();
  const { docs, loaded, reload } = useToolDocuments();
  const [level, setLevel] = useState<CompressLevel>('balanced');
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [result, setResult] = useState<(CompressResult & { docId: string }) | null>(null);

  const { doc, docId, setDocId, fixed, fromViewer } = useToolDoc(docs);
  const currentSize = useMemo(() => (doc ? documentSize(doc) : 0), [doc]);
  const running = progress !== null;

  const run = async () => {
    if (!doc) return;
    setResult(null);
    setProgress({ current: 0, total: doc.pages.length });
    try {
      const r = await compressDocument(doc, level, (done, total) => setProgress({ current: done, total }));
      invalidateDocPreviews(doc.id);
      setResult({ ...r, docId: doc.id });
      notifySuccess();
      show(r.after < r.before ? `Saved ${formatBytes(r.before - r.after)}` : 'Already as small as it gets');
      reload();
    } catch {
      notifyError();
      Alert.alert('Couldn’t compress this document', 'Some pages may not have been compressed. Try again.');
      reload();
    } finally {
      setProgress(null);
    }
  };

  const handleCompress = () => {
    if (!doc || running) return;
    Alert.alert(
      'Compress this document?',
      `The page images in “${doc.name}” will be replaced with smaller versions. This can’t be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Compress', onPress: run },
      ],
    );
  };

  if (loaded && docs.length === 0) {
    return (
      <NoDocumentsScreen
        toolTitle="Compress"
        icon="contract-outline"
        subtitle="Compress makes scanned documents smaller. Scan or import a document first."
      />
    );
  }

  const done = result && result.docId === docId ? result : null;

  return (
    <ToolScreen
      title="Compress"
      footer={
        <>
          {progress ? (
            <ToolProgress
              label={`Compressing page ${Math.min(progress.current + 1, progress.total)} of ${progress.total}…`}
              current={progress.current}
              total={progress.total}
            />
          ) : null}
          {done ? (
            fromViewer ? (
              // Opened from the viewer: it is right underneath and reloads on focus.
              <PrimaryButton title="Done" onPress={() => router.back()} />
            ) : (
              <PrimaryButton
                title="Open document"
                icon="open-outline"
                onPress={() => router.replace({ pathname: '/viewer', params: { id: done.docId } })}
              />
            )
          ) : (
            <PrimaryButton
              title={doc ? `Compress document (${formatBytes(currentSize)})` : 'Choose a document'}
              onPress={handleCompress}
              disabled={!doc}
              loading={running}
            />
          )}
        </>
      }
    >
      {/* Presented over the viewer: a baker underneath would never run (see FilterBaker). */}
      {fromViewer ? <FilterBaker /> : null}
      <ToolIntro
        icon="contract-outline"
        title="Make a document smaller"
        text="Saves its pages again at a lower size to free up space on this device."
      />
      <ToolDocPicker
        docs={docs}
        doc={doc}
        fixed={fixed}
        disabled={running}
        note="Imported PDFs can’t be compressed, so they aren’t listed."
        onPick={d => {
          setDocId(d.id);
          setResult(null);
        }}
      />

      {done ? (
        <View style={[styles.result, { backgroundColor: colors.card }]}>
          <View style={styles.resultCol}>
            <Text style={[Type.footnote, { color: colors.muted }]}>Before</Text>
            <Text style={[Type.title, { color: colors.text }]}>{formatBytes(done.before)}</Text>
          </View>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <View style={styles.resultCol}>
            <Text style={[Type.footnote, { color: colors.muted }]}>After</Text>
            <Text style={[Type.title, { color: colors.accent }]}>{formatBytes(done.after)}</Text>
          </View>
        </View>
      ) : null}

      <SectionLabel>Size</SectionLabel>
      <OptionList options={LEVELS} value={level} onChange={v => { setLevel(v); setResult(null); }} />
      <ToolNote>
        This replaces the page images and can’t be undone. To send a smaller file and keep the pages as they are, share
        the document and choose Smaller PDF.
      </ToolNote>
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  result: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.md,
    paddingVertical: Spacing.lg,
    marginTop: Spacing.lg,
  },
  resultCol: { flex: 1, alignItems: 'center', gap: Spacing.xs },
  divider: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
});
