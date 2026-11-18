// app/tools/compress.tsx
// "Free up space": shrinks a scanned document's stored page images in place
// (lib/compress.ts) and reports the size before and after. Named for what it
// does to the device, not the file, so it can't be mistaken for Export's
// harmless "Smaller PDF" (which only shrinks the copy being shared) — this one
// changes the document itself, for good. Imported PDFs are not supported — their
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
  { value: 'small', label: 'Smallest', detail: 'Frees the most space. Fine print may soften.' },
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
      show(r.after < r.before ? `Freed ${formatBytes(r.before - r.after)}` : 'Already as small as it gets');
      reload();
    } catch {
      notifyError();
      Alert.alert('Couldn’t shrink this document', 'Some pages may not have been shrunk. Try again.');
      reload();
    } finally {
      setProgress(null);
    }
  };

  const handleCompress = () => {
    if (!doc || running) return;
    Alert.alert(
      'Shrink this document for good?',
      `The pages of “${doc.name}” will be saved again at a smaller size, replacing the current ones. This can’t be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Shrink', style: 'destructive', onPress: run },
      ],
    );
  };

  if (loaded && docs.length === 0) {
    return (
      <NoDocumentsScreen
        toolTitle="Free up space"
        icon="contract-outline"
        subtitle="Free up space shrinks the pages of scanned documents. Scan or import a document first."
      />
    );
  }

  const done = result && result.docId === docId ? result : null;

  return (
    <ToolScreen
      title="Free up space"
      footer={
        <>
          {progress ? (
            <ToolProgress
              label={`Shrinking page ${Math.min(progress.current + 1, progress.total)} of ${progress.total}…`}
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
              title={doc ? `Shrink pages (${formatBytes(currentSize)} now)` : 'Shrink pages'}
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
        title="Shrink a document for good"
        text="Saves its pages again at a smaller size, replacing them, to free up space on this device."
      />
      <ToolDocPicker
        docs={docs}
        doc={doc}
        fixed={fixed}
        disabled={running}
        note="Imported PDFs can’t be shrunk here, so they aren’t listed."
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
        This replaces the stored pages and can’t be undone. To send a smaller file and keep the pages as they are,
        share the document and choose Smaller PDF instead.
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
