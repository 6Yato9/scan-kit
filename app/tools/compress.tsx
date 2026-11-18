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
  DocRow,
  NoDocuments,
  OptionList,
  ToolNote,
  ToolProgress,
  ToolScreen,
  formatBytes,
  useToolDocuments,
} from '@/components/tool-ui';
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
  const [docId, setDocId] = useState<string | null>(null);
  const [level, setLevel] = useState<CompressLevel>('balanced');
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [result, setResult] = useState<(CompressResult & { docId: string }) | null>(null);

  const doc = docs.find(d => d.id === docId) ?? null;
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
      <ToolScreen title="Compress">
        <NoDocuments subtitle="Compress makes scanned documents smaller. Scan or import a document first." />
      </ToolScreen>
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
            <PrimaryButton
              title="Open document"
              icon="open-outline"
              onPress={() => router.replace({ pathname: '/viewer', params: { id: done.docId } })}
            />
          ) : (
            <PrimaryButton
              title={doc ? `Compress document (${formatBytes(currentSize)})` : "Select a document"}
              onPress={handleCompress}
              disabled={!doc}
              loading={running}
            />
          )}
        </>
      }
    >
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

      <SectionLabel>Document</SectionLabel>
      {docs.map(d => (
        <DocRow
          key={d.id}
          doc={d}
          selected={d.id === docId}
          onPress={() => {
            if (running) return;
            setDocId(d.id);
            setResult(null);
          }}
        />
      ))}
      <ToolNote>Works on scanned and imported photos. Imported PDF files can’t be compressed.</ToolNote>
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
