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
//
// Smaller PDF's size (round 16, lib/compress-pdf.ts): presets Smallest /
// Small (the default, what it always made) / Medium / Large, each with its
// estimated size; under More options "Fit under" 1–10 MB (the largest
// resolution whose estimate fits) or a custom resolution, and the text layer.
// The made file's real size is what the result shows, with the limit kept or
// missed said plainly. Choices are remembered (lib/tool-prefs.ts).
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppSwitch } from '@/components/app-switch';
import { MoreOptions } from '@/components/more-options';
import { ValueSlider } from '@/components/value-slider';
import {
  COMPRESS_PRESETS,
  DEFAULT_COMPRESS_PDF,
  estimateFor,
  parseCompressPdfPrefs,
  pdfOptionsFor,
  targetVerdict,
  TARGET_MB,
  type CompressPdfPrefs,
  type CompressPreset,
  type PdfSizing,
} from '@/lib/compress-pdf';
import { pageStats } from '@/lib/page-stats';
import { readToolPrefs, TOOL_PREF_KEYS, writeToolPrefs } from '@/lib/tool-prefs';
import { useRememberedPrefs } from '@/components/use-remembered-prefs';
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
import { generatePdf, MAX_CUSTOM_EDGE, MIN_CUSTOM_EDGE, PdfCancelledError, roundUpEstimate, type PageStat } from '@/lib/pdf';
import { ocrAvailable } from '@/lib/ocr';
import { getDocSettings } from '@/lib/storage';
import { deleteQuietly, exportFileName, makeExportDir, placeExportFile, shareFile, ShareError } from '@/lib/share';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

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

const PRESET_LABELS: Record<CompressPreset, { label: string; detail: string }> = {
  smallest: { label: 'Smallest', detail: 'Readable on screen' },
  small: { label: 'Small', detail: 'For email and messages' },
  medium: { label: 'Medium', detail: 'Clear text, prints well' },
  large: { label: 'Large', detail: 'Near-original detail' },
};

const loadCompressPrefs = () => readToolPrefs(TOOL_PREF_KEYS.compress, parseCompressPdfPrefs);
const saveCompressPrefs = (p: CompressPdfPrefs) => writeToolPrefs(TOOL_PREF_KEYS.compress, p);

type MadePdf = { docId: string; uri: string; dir: string; bytes: number; name: string; target: number | null };

export default function CompressScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { show } = useToast();
  const params = useLocalSearchParams<{ mode?: string }>();
  const [mode, setMode] = useState<Mode>(params.mode === 'pdf' ? 'pdf' : 'space');
  const { docs, loaded, reload } = useToolDocuments();
  const [moreOpen, setMoreOpen] = useState(false);
  // Smaller PDF's choices and Free up space's level, remembered. A choice
  // made before they load wins (components/use-remembered-prefs.ts).
  const [prefs, setPrefs, latestPrefs] = useRememberedPrefs<CompressPdfPrefs>(DEFAULT_COMPRESS_PDF, loadCompressPrefs, saveCompressPrefs, {
    // A remembered choice that lives under More options shows it open.
    onLoaded: p => {
      if (p.sizing.kind !== 'preset' || !p.searchable) setMoreOpen(true);
    },
  });
  const level: CompressLevel = prefs.level;
  const setLevel = (v: CompressLevel) => setPrefs({ level: v });
  const [stats, setStats] = useState<{ docId: string; pages: PageStat[] } | null>(null);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [result, setResult] = useState<(CompressResult & { docId: string }) | null>(null);
  const [made, setMade] = useState<MadePdf | null>(null);
  const [making, setMaking] = useState<{ done: number; total: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { doc, docId, setDocId, fixed, fromViewer } = useToolDoc(docs);
  const currentSize = useMemo(() => (doc ? documentSize(doc) : 0), [doc]);
  // Each page's bytes and pixels, for the size estimates.
  const statsKey = doc ? `${doc.id}:${doc.updatedAt}` : null;
  useEffect(() => {
    if (!doc) return;
    let live = true;
    setStats(null);
    pageStats(doc.pages).then(pages => { if (live) setStats({ docId: doc.id, pages }); }).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsKey]);
  const docStats = stats && doc && stats.docId === doc.id ? stats.pages : null;
  const searchable = ocrAvailable() && prefs.searchable;
  const about = (sizing: PdfSizing) =>
    docStats ? `about ${formatBytes(roundUpEstimate(estimateFor(sizing, docStats, searchable)))}` : null;
  const chosen = pdfOptionsFor(prefs.sizing, docStats, searchable);
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

  /** A choice changed: the PDF made with the old one goes (its export folder too). */
  const clearMade = () => {
    if (made) deleteQuietly(made.dir).catch(() => {});
    setMade(null);
  };

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
      // Stats read now if the estimate hadn't finished, so "Fit under" is honoured.
      const chosenPrefs = latestPrefs();
      const opts = pdfOptionsFor(chosenPrefs.sizing, docStats ?? (await pageStats(doc.pages)), searchable);
      raw = await generatePdf(doc.pages, {
        pageSize: settings?.pdfPageSize ?? 'Auto',
        quality: opts.quality,
        maxEdge: opts.maxEdge,
        searchable,
        signal: controller.signal,
        onProgress: (done, total) => setMaking({ done: Math.min(done, total), total }),
      });
      const dir = await makeExportDir();
      const uri = await placeExportFile(raw, dir, exportFileName(doc.name, 'pdf'), 'move');
      raw = null;
      const target = chosenPrefs.sizing.kind === 'target' ? chosenPrefs.sizing.mb : null;
      setMade({ docId: doc.id, uri, dir, bytes: fileSize(uri), name: doc.name, target });
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

  // "Fit under": what it will do — never "may not fit" before the sizes are known.
  const fitGeneric = 'For upload forms and email with a size limit: picks the sharpest pages that keep the PDF under it.';
  const fitNote =
    prefs.sizing.kind !== 'target' || !doc
      ? fitGeneric
      : !docStats
        ? 'Working out the sizes…'
        : chosen.fits
          ? `Pages at up to ${(chosen.maxEdge ?? 0).toLocaleString('en-US')} pixels${about(prefs.sizing) ? `, ${about(prefs.sizing)}` : ''}. The real size is shown when it’s made.`
          : `Even the smallest size is ${about(prefs.sizing) ?? 'more'}, so the file may not fit under ${prefs.sizing.mb} MB. Extract fewer pages first.`;

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
      <View style={styles.modes} pointerEvents={running ? 'none' : 'auto'} collapsable={false}>
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
        <>
          {pdf ? (
            <>
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
              {pdf.target != null ? (
                <Text
                  style={[Type.footnote, styles.verdict, { color: targetVerdict(pdf.bytes, pdf.target).ok ? colors.muted : colors.danger }]}
                >
                  {targetVerdict(pdf.bytes, pdf.target).ok
                    ? `${targetVerdict(pdf.bytes, pdf.target).text}.`
                    : `${targetVerdict(pdf.bytes, pdf.target).text}. Choose a smaller size, or extract fewer pages first.`}
                </Text>
              ) : null}
            </>
          ) : null}
          <View pointerEvents={running ? 'none' : 'auto'} collapsable={false}>
            <SectionLabel>Size</SectionLabel>
            <OptionList
              options={COMPRESS_PRESETS.map(p => ({
                value: p,
                label: PRESET_LABELS[p].label,
                detail: [PRESET_LABELS[p].detail, about({ kind: 'preset', preset: p })].filter(Boolean).join(' · '),
              }))}
              value={prefs.sizing.kind === 'preset' ? prefs.sizing.preset : ('' as CompressPreset)}
              onChange={p => {
                setPrefs({ sizing: { kind: 'preset', preset: p } });
                clearMade();
              }}
            />
            <MoreOptions
              open={moreOpen}
              onToggle={setMoreOpen}
              changed={(prefs.sizing.kind !== 'preset' ? 1 : 0) + (prefs.searchable ? 0 : 1)}
            >
              <SectionLabel>Fit under</SectionLabel>
              <Segmented
                options={[
                  { value: 'off', label: 'Off' },
                  ...TARGET_MB.map(mb => ({ value: String(mb), label: `${mb} MB` })),
                ]}
                value={prefs.sizing.kind === 'target' ? String(prefs.sizing.mb) : 'off'}
                onChange={v => {
                  setPrefs({ sizing: v === 'off' ? DEFAULT_COMPRESS_PDF.sizing : { kind: 'target', mb: Number(v) } });
                  clearMade();
                }}
              />
              <ToolNote>
                {fitNote}
              </ToolNote>
              <SectionLabel>Custom resolution</SectionLabel>
              <ValueSlider
                label="Longest side of each page"
                value={prefs.sizing.kind === 'custom' ? prefs.sizing.edge : chosen.maxEdge ?? presetEdge(prefs.sizing)}
                min={MIN_CUSTOM_EDGE}
                max={MAX_CUSTOM_EDGE}
                step={100}
                format={v => `${(Math.round(v / 100) * 100).toLocaleString('en-US')} px`}
                onChange={v => {
                  setPrefs({ sizing: { kind: 'custom', edge: Math.round(v / 100) * 100 } });
                  clearMade();
                }}
              />
              <ToolNote>
                {prefs.sizing.kind === 'custom'
                  ? `Each page’s longest side at most ${prefs.sizing.edge.toLocaleString('en-US')} pixels${about(prefs.sizing) ? `, ${about(prefs.sizing)}` : ''}.`
                  : 'Drag to choose an exact resolution instead of a size above.'}
              </ToolNote>
              {ocrAvailable() ? (
                <View style={[styles.switchRow, { backgroundColor: colors.card }]}>
                  <View style={styles.switchText}>
                    <Text style={[Type.body, { color: colors.text }]}>Searchable text</Text>
                    <Text style={[Type.footnote, styles.switchDetail, { color: colors.muted }]}>
                      {prefs.searchable ? 'Text can be searched and copied.' : 'Off: a little smaller, and faster to make.'}
                    </Text>
                  </View>
                  <AppSwitch
                    value={prefs.searchable}
                    onValueChange={v => {
                      setPrefs({ searchable: v });
                      clearMade();
                    }}
                    accessibilityLabel="Searchable text"
                  />
                </View>
              ) : null}
            </MoreOptions>
            <ToolNote>Paper size comes from Document settings.</ToolNote>
          </View>
        </>
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
  verdict: { marginTop: Spacing.sm, marginHorizontal: Spacing.xs, lineHeight: 18 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    borderRadius: Radius.md,
    marginTop: Spacing.lg,
    paddingHorizontal: Spacing.lg,
    minHeight: HIT + 8,
  },
  switchText: { flex: 1, paddingVertical: Spacing.md },
  switchDetail: { marginTop: 1, lineHeight: 18 },
});

/** The resolution a preset stands for (where the custom slider starts). */
function presetEdge(sizing: PdfSizing): number {
  if (sizing.kind === 'custom') return sizing.edge;
  if (sizing.kind === 'preset') return { smallest: 1000, small: 1300, medium: 1800, large: 2400 }[sizing.preset];
  return 1600;
}
