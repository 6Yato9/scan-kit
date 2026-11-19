// app/tools/compress.tsx
// Compress, two ways, chosen at the top:
// - Smaller PDF (the Tools tab's Compress): makes a small PDF copy of a
//   scanned document to send (lower resolution and stronger JPEG compression,
//   still searchable) and shares it. The document itself is not touched — the
//   same file as Export › Smaller PDF.
// - Free up space (Settings › Storage opens this one): shrinks a scanned
//   document's stored page images in place (lib/compress.ts) and reports the
//   size before and after. It changes the document for good, so it asks first.
// Imported PDFs are not listed: their pages aren't images this app re-encodes.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import { useToast } from '@/components/toast';
import {
  NoDocumentsScreen,
  OptionList,
  Segmented,
  ToolNote,
  ToolProgress,
  ToolScreen,
  formatBytes,
  useToolDocuments,
} from '@/components/tool-ui';
import { ToolDocPicker, useToolDoc } from '@/components/tool-doc';
import { FilterBaker } from '@/components/filter-baker';
import { compressDocument, documentSize, fileSize, type CompressLevel, type CompressResult } from '@/lib/compress';
import { invalidateDocPreviews } from '@/lib/bake';
import { generatePdf, PdfCancelledError } from '@/lib/pdf';
import { ocrAvailable } from '@/lib/ocr';
import { getDocSettings } from '@/lib/storage';
import { deleteQuietly, exportFileName, makeExportDir, placeExportFile, shareFile, ShareError } from '@/lib/share';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { Radius, Spacing, Type } from '@/lib/theme';

type Mode = 'pdf' | 'space';

const MODES: { value: Mode; label: string }[] = [
  { value: 'pdf', label: 'Smaller PDF' },
  { value: 'space', label: 'Free up space' },
];

const LEVELS: { value: CompressLevel; label: string; detail: string }[] = [
  { value: 'small', label: 'Smallest', detail: 'Frees the most space. Fine print may soften.' },
  { value: 'balanced', label: 'Balanced', detail: 'Clear text at a much smaller size.' },
  { value: 'sharp', label: 'Sharp', detail: 'Near-original detail, smaller saving.' },
];

type MadePdf = { docId: string; uri: string; dir: string; bytes: number; name: string };

export default function CompressScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { show } = useToast();
  const params = useLocalSearchParams<{ mode?: string }>();
  const [mode, setMode] = useState<Mode>(params.mode === 'pdf' ? 'pdf' : 'space');
  const { docs, loaded, reload } = useToolDocuments();
  const [level, setLevel] = useState<CompressLevel>('balanced');
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [result, setResult] = useState<(CompressResult & { docId: string }) | null>(null);
  const [made, setMade] = useState<MadePdf | null>(null);
  const [making, setMaking] = useState<{ done: number; total: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { doc, docId, setDocId, fixed, fromViewer } = useToolDoc(docs);
  const currentSize = useMemo(() => (doc ? documentSize(doc) : 0), [doc]);
  const running = progress !== null || making !== null;
  // Leaving mid-way stops the PDF being made (the exports folder is swept at launch).
  useEffect(() => () => abortRef.current?.abort(), []);

  // ── Free up space ──────────────────────────────────────────────────────────

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

  // ── Smaller PDF ────────────────────────────────────────────────────────────

  const makePdf = async () => {
    if (!doc || running) return;
    if (made) deleteQuietly(made.dir).catch(() => {});
    setMade(null);
    const controller = new AbortController();
    abortRef.current = controller;
    setMaking({ done: 0, total: doc.pages.length });
    let raw: string | null = null;
    try {
      const settings = await getDocSettings().catch(() => null);
      raw = await generatePdf(doc.pages, {
        pageSize: settings?.pdfPageSize ?? 'Auto',
        quality: 'small',
        searchable: ocrAvailable(),
        signal: controller.signal,
        onProgress: (done, total) => setMaking({ done: Math.min(done, total), total }),
      });
      const dir = await makeExportDir();
      const uri = await placeExportFile(raw, dir, exportFileName(doc.name, 'pdf'), 'move');
      raw = null;
      setMade({ docId: doc.id, uri, dir, bytes: fileSize(uri), name: doc.name });
      notifySuccess();
    } catch (err) {
      if (err instanceof PdfCancelledError || controller.signal.aborted) return;
      notifyError();
      Alert.alert('Couldn’t make a smaller PDF', 'Your document is unchanged. Try again, or extract fewer pages first.');
    } finally {
      if (raw) deleteQuietly(raw).catch(() => {});
      if (abortRef.current === controller) abortRef.current = null;
      setMaking(null);
    }
  };

  const sharePdf = async () => {
    if (!made) return;
    try {
      await shareFile(made.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: made.name });
    } catch (err) {
      Alert.alert('Couldn’t share the PDF', err instanceof ShareError ? err.message : 'Try again.');
    }
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
  const pdf = made && made.docId === docId ? made : null;

  const footer =
    mode === 'pdf' ? (
      <>
        {making ? (
          <ToolProgress
            label={`Preparing page ${Math.min(making.done + 1, making.total)} of ${making.total}…`}
            current={making.done}
            total={making.total}
          />
        ) : null}
        {pdf ? (
          <PrimaryButton title="Share smaller PDF" icon="share-outline" onPress={sharePdf} />
        ) : (
          <PrimaryButton title="Make smaller PDF" onPress={makePdf} disabled={!doc} loading={!!making} />
        )}
      </>
    ) : (
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
            loading={progress !== null}
          />
        )}
      </>
    );

  return (
    <ToolScreen title="Compress" busy={progress !== null} footer={footer}>
      {/* Presented over the viewer: a baker underneath would never run (see FilterBaker). */}
      {fromViewer ? <FilterBaker /> : null}
      <View style={styles.modes} pointerEvents={running ? 'none' : 'auto'}>
        <Segmented options={MODES} value={mode} onChange={setMode} />
      </View>
      <Text style={[Type.footnote, styles.lead, { color: colors.muted }]}>
        {mode === 'pdf'
          ? 'A small PDF copy to send by email or message. The document itself stays as it is.'
          : 'Saves the pages again at a smaller size, replacing them, to free up space on this device.'}
      </Text>
      <ToolDocPicker
        docs={docs}
        doc={doc}
        fixed={fixed}
        disabled={running}
        note="Imported PDFs can’t be compressed here, so they aren’t listed."
        onPick={d => {
          setDocId(d.id);
          setResult(null);
        }}
      />

      {mode === 'pdf' ? (
        pdf ? (
          <View style={[styles.result, { backgroundColor: colors.card }]}>
            <View style={styles.resultCol}>
              <Text style={[Type.footnote, { color: colors.muted }]}>Pages now</Text>
              <Text style={[Type.title, { color: colors.text }]}>{formatBytes(currentSize)}</Text>
            </View>
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <View style={styles.resultCol}>
              <Text style={[Type.footnote, { color: colors.muted }]}>Smaller PDF</Text>
              <Text style={[Type.title, { color: colors.accent }]}>{formatBytes(pdf.bytes)}</Text>
            </View>
          </View>
        ) : (
          <ToolNote>Pages are sent at a lower resolution with stronger compression. Text stays searchable.</ToolNote>
        )
      ) : (
        <>
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
            choose Smaller PDF instead.
          </ToolNote>
        </>
      )}
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  modes: { marginTop: Spacing.sm },
  lead: { marginTop: Spacing.sm, marginHorizontal: Spacing.xs },
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
