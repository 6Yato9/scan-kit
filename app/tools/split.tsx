// app/tools/split.tsx
// Split a document in two after a chosen page. Scanned documents are split
// by lib/doc-ops splitDocument: every page is copied with its shadows (the
// unfiltered .orig, the source photo and its crop), filter and adjustments,
// so both parts can still be filtered and re-cropped. Imported PDFs are split
// by PDFKit without redrawing a page (lib/pdf-edit splitStoredPdf), so their
// text stays selectable. Either way the parts are "<name> (1)" and
// "<name> (2)" in the same folder, and the original is kept unless the user
// chooses to move it to Recently deleted.
//
// Round 16: three ways to split, chosen at the top (remembered, with the
// part size, in lib/tool-prefs.ts):
// - At a page (the default, as before): two documents, cut after the page tapped.
// - Every N pages: equal parts of N pages (the last may be shorter), e.g. a
//   stack of two-page forms scanned in one go.
// - By ranges: typed ranges, one document per range ("1-3, 4-8, 9"; pages
//   left out aren't copied), parsed by lib/page-ranges.ts.
// Parts are "<name> (1)", "<name> (2)", … (lib/doc-ops splitDocumentParts,
// lib/pdf-edit splitStoredPdfParts) and the first part opens.
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/contexts/theme-context';
import { useScan } from '@/contexts/scan-context';
import { PageThumb } from '@/components/page-thumb';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import { NoDocumentsScreen, OptionList, Segmented, ToolNote, ToolScreen, isSinglePageDoc, useToolDocuments } from '@/components/tool-ui';
import { ValueSlider } from '@/components/value-slider';
import {
  chunkPages,
  DEFAULT_SPLIT_PREFS,
  describeParts,
  keepOriginalReason,
  newDocumentsLabel,
  omittedPages,
  parsePageRanges,
  parseSplitPrefs,
  SPLIT_CONFIRM_OVER,
  type SplitMode,
  type SplitPrefs,
} from '@/lib/page-ranges';
import { readToolPrefs, TOOL_PREF_KEYS, writeToolPrefs } from '@/lib/tool-prefs';
import { useRememberedPrefs } from '@/components/use-remembered-prefs';
import { ToolDocPicker, useToolDoc } from '@/components/tool-doc';
import { FilterBaker } from '@/components/filter-baker';
import { splitDocumentParts, splitRanges } from '@/lib/doc-ops';
import { canEditPdfPages, partPlans, PdfEditError, splitStoredPdfParts } from '@/lib/pdf-edit';
import { useReadablePdfUri, withNoPasswordNote } from '@/lib/pdf-session';
import { pdfPageThumbnails } from '@/lib/pdf-thumb';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { Radius, Spacing, Type } from '@/lib/theme';
import type { Document } from '@/types/document';

type Keep = 'keep' | 'trash';

/**
 * Keep or trash the original. The details say how many documents the split
 * makes; when pages are left out of every range, trashing is offered greyed
 * out with the reason (those pages would exist only in the deleted original).
 */
function keepOptions(parts: number | null, keptBecause: string | null): { value: Keep; label: string; detail: string; disabled?: boolean }[] {
  return [
    {
      value: 'keep',
      label: 'Keep the original',
      detail: parts ? `You get ${newDocumentsLabel(parts)} and keep this one.` : 'You get the new documents and keep this one.',
    },
    {
      value: 'trash',
      label: 'Move the original to Recently deleted',
      detail: keptBecause ?? 'You can restore it there for 30 days.',
      disabled: !!keptBecause,
    },
  ];
}

const loadSplitPrefs = () => readToolPrefs(TOOL_PREF_KEYS.split, parseSplitPrefs);
const saveSplitPrefs = (p: SplitPrefs) => writeToolPrefs(TOOL_PREF_KEYS.split, p);

const range = (a: number, b: number) => (a === b ? `page ${a}` : `pages ${a}–${b}`);
/** "two documents" (the classic split's words), "1 document", "6 documents". */
const documentsLabel = (n: number) => (n === 2 ? 'two documents' : n === 1 ? '1 document' : `${n} documents`);

const MODE_OPTIONS: { value: SplitMode; label: string }[] = [
  { value: 'at', label: 'At a page' },
  { value: 'every', label: 'Every N pages' },
  { value: 'ranges', label: 'By ranges' },
];

export default function SplitScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { bumpLastSaved } = useScan();
  const pdfSplit = canEditPdfPages();
  // Scanned documents with two or more pages; imported PDFs where this build can edit them.
  const { docs, loaded } = useToolDocuments(d => (d.pdfUri ? pdfSplit : d.pages.length > 1));
  const { docs: singles, loaded: singlesLoaded } = useToolDocuments(isSinglePageDoc);
  const { doc, setDocId, fixed, fromViewer } = useToolDoc(docs);
  const [after, setAfter] = useState<number | null>(null);
  const [keep, setKeep] = useState<Keep>('keep');
  const [prefs, setPrefs] = useRememberedPrefs(DEFAULT_SPLIT_PREFS, loadSplitPrefs, saveSplitPrefs);
  // "By ranges": what was typed, for this document only.
  const [rangeText, setRangeText] = useState('');
  const [saving, setSaving] = useState(false);
  // An imported PDF's pages as thumbnails (its page count comes from them).
  const [pdfThumbs, setPdfThumbs] = useState<{ docId: string; uris: string[] } | null>(null);
  const [pdfFailed, setPdfFailed] = useState(false);

  // A protected PDF unlocked this session shows its pages from its decrypted copy (lib/pdf-session.ts).
  const { uri: pdfUri, unlocked: unlockedForSession } = useReadablePdfUri(doc?.pdfUri ? doc : null);
  const docId = doc?.id ?? null;
  useEffect(() => {
    if (!docId || !pdfUri) return;
    let cancelled = false;
    setPdfThumbs(null);
    setPdfFailed(false);
    pdfPageThumbnails(docId, pdfUri)
      .then(uris => { if (!cancelled) setPdfThumbs({ docId, uris }); })
      .catch(() => { if (!cancelled) setPdfFailed(true); });
    return () => { cancelled = true; };
  }, [docId, pdfUri]);

  const thumbs: string[] | null = !doc
    ? null
    : doc.pdfUri
      ? pdfThumbs?.docId === doc.id ? pdfThumbs.uris : null
      : doc.pages.map(p => `${p}?v=${doc.updatedAt}`);
  const count = thumbs?.length ?? 0;
  // The split point: after the page tapped; by default the middle.
  const at = after != null && after < count - 1 ? after : Math.max(0, Math.ceil(count / 2) - 1);
  const mode = prefs.mode;
  // Every N: at most count - 1 per part (N = count would be no split at all).
  const every = Math.min(Math.max(1, prefs.every), Math.max(1, count - 1));
  const parsed = mode === 'ranges' && count > 0 && rangeText.trim() ? parsePageRanges(rangeText, count) : null;
  // The documents this split makes (0-based pages), or null while it can't run.
  const parts: number[][] | null =
    count < 2
      ? null
      : mode === 'at'
        ? splitRanges(count, at)
        : mode === 'every'
          ? chunkPages(count, every)
          : parsed?.ok
            ? parsed.ranges
            : null;
  // The last page of each part gets the cut mark in the grid (At a page, Every N).
  const cutAfter = new Set(mode === 'ranges' || !parts ? [] : parts.slice(0, -1).map(p => p[p.length - 1]));
  // By ranges: pages no range names are dimmed (they aren't copied).
  const used = mode === 'ranges' && parts ? new Set(parts.flat()) : null;
  // ...and while there are any, the original can't go to Recently deleted:
  // they would be left only in it, and gone for good after 30 days.
  const keptBecause = mode === 'ranges' && parts ? keepOriginalReason(omittedPages(parts, count)) : null;
  const keepChoice: Keep = keptBecause ? 'keep' : keep;

  const pick = (d: Document) => {
    setDocId(d.id);
    setAfter(null);
    setRangeText('');
  };

  const split = () => {
    if (!doc || !parts || saving) return;
    // Many documents at once (Every N pages, or a long list of ranges): asked
    // first, as each is a document of its own to delete again.
    if (parts.length > SPLIT_CONFIRM_OVER) {
      Alert.alert(
        `Make ${parts.length} documents?`,
        `“${doc.name}” is split into ${parts.length} new documents, each with a copy of its pages.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: `Make ${parts.length} documents`, isPreferred: true, onPress: () => { confirmPassword(); } },
        ],
      );
      return;
    }
    confirmPassword();
  };

  const confirmPassword = () => {
    if (!doc || !parts || saving) return;
    // Its parts won't need a password; with the original deleted, nothing
    // protected is left: said before it happens.
    if (doc.pdfUri && unlockedForSession && keepChoice === 'trash') {
      Alert.alert(
        'Split without the password?',
        `The new ${parts.length === 1 ? 'document won’t' : 'documents won’t'} need a password, and the protected original moves to Recently deleted.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Split', isPreferred: true, onPress: () => { runSplit(); } },
        ],
      );
      return;
    }
    runSplit();
  };

  const runSplit = async () => {
    if (!doc || !parts || saving) return;
    setSaving(true);
    try {
      const trashOriginal = keepChoice === 'trash';
      const plan = parts;
      const result = doc.pdfUri
        ? await splitStoredPdfParts(doc.id, n => (n === count ? partPlans(plan, n) : []), { trashOriginal })
        : await splitDocumentParts(doc.id, plan, { trashOriginal, expectedCount: count });
      bumpLastSaved();
      notifySuccess();
      const made = documentsLabel(result.parts.length);
      const notice = withNoPasswordNote(
        result.originalTrashed
          ? `Split into ${made}. The original is in Recently deleted.`
          : `Split into ${made}. The original is kept.`,
        [doc.id],
      );
      // The first part opens; the viewer says what happened.
      navigateWhenUnlocked(() => router.replace({ pathname: '/viewer', params: { id: result.parts[0].id, notice } }));
    } catch (err) {
      notifyError();
      if (err instanceof PdfEditError && err.kind === 'locked') {
        Alert.alert('This PDF is password protected', 'Open it and enter its password, then split it.');
      } else if (err instanceof PdfEditError && err.kind === 'restricted') {
        Alert.alert('This PDF can’t be split', 'Its author doesn’t allow changes to its pages. You can still view, share and print it.');
      } else if (err instanceof PdfEditError && err.kind === 'unreadable') {
        Alert.alert('Couldn’t read this PDF', 'The file may be damaged. Try importing it again.');
      } else {
        console.error('Split failed', err);
        Alert.alert('Couldn’t split the document', 'Your document is unchanged. Check that there’s free space, then try again.');
      }
    } finally {
      setSaving(false);
    }
  };

  if (loaded && singlesLoaded && docs.length === 0) {
    return (
      <NoDocumentsScreen
        toolTitle="Split"
        icon="split"
        title="No multi-page documents"
        subtitle={
          singles.length
            ? 'Splitting needs a document with at least two pages, and yours have one each. Add pages to one, or scan a new document.'
            : 'Splitting needs a document with at least two pages. Scan or import one first.'
        }
        addPagesTo={singles}
      />
    );
  }

  return (
    <ToolScreen
      title="Split"
      busy={saving}
      footer={
        <PrimaryButton
          title={parts ? `Split into ${documentsLabel(parts.length)}` : mode === 'at' ? 'Split into two documents' : 'Split'}
          onPress={split}
          disabled={!parts || parts.length < 1 || (mode !== 'ranges' && parts.length < 2)}
          loading={saving}
        />
      }
    >
      {/* Presented over the viewer: a baker underneath would never run (see FilterBaker). */}
      {fromViewer ? <FilterBaker /> : null}
      <ToolDocPicker
        docs={docs}
        doc={doc}
        fixed={fixed}
        disabled={saving}
        autoOpen
        note={pdfSplit ? 'Documents and PDFs with two or more pages.' : 'Documents with two or more pages.'}
        onPick={pick}
      />

      {doc ? (
        <>
          <SectionLabel>Split</SectionLabel>
          <View pointerEvents={saving ? 'none' : 'auto'} collapsable={false}>
            <Segmented options={MODE_OPTIONS} value={mode} onChange={v => setPrefs({ mode: v })} />
          </View>
          {mode === 'every' && count > 2 ? (
            <>
              <SectionLabel>Pages per document</SectionLabel>
              <ValueSlider
                label="Pages per document"
                value={every}
                min={1}
                max={count - 1}
                format={v => String(v)}
                onChange={v => setPrefs({ every: v })}
              />
            </>
          ) : null}
          {mode === 'ranges' ? (
            <>
              <SectionLabel>Page ranges</SectionLabel>
              <TextInput
                style={[Type.body, styles.input, { color: colors.text, backgroundColor: colors.card }]}
                value={rangeText}
                onChangeText={setRangeText}
                placeholder={count > 3 ? `For example 1-2, 3-${count}` : 'For example 1, 2'}
                placeholderTextColor={colors.muted}
                keyboardType="numbers-and-punctuation"
                autoCorrect={false}
                returnKeyType="done"
                editable={!saving}
                accessibilityLabel="Page ranges"
              />
              <Text
                style={[Type.footnote, styles.summary, { color: parsed && !parsed.ok ? colors.danger : colors.muted }]}
                accessibilityLiveRegion="polite"
              >
                {parsed && !parsed.ok
                  ? parsed.error
                  : 'Each range becomes its own document. Separate ranges with commas; pages you leave out aren’t copied.'}
              </Text>
            </>
          ) : null}
          <SectionLabel>{mode === 'at' && parts ? `Split after page ${at + 1}` : 'Pages'}</SectionLabel>
          {thumbs ? (
            <View style={styles.grid}>
              {thumbs.map((uri, i) => {
                // At a page: the first part is outlined. Every N: parts alternate. Ranges: named pages.
                const partIndex = parts && mode === 'every' ? Math.floor(i / every) : 0;
                const first = mode === 'at' ? i <= at : mode === 'every' ? partIndex % 2 === 0 : !!used?.has(i);
                const last = i === count - 1;
                const tappable = mode === 'at' && !last;
                return (
                  <Pressable
                    key={`${uri}-${i}`}
                    onPress={() => { if (tappable) setAfter(i); }}
                    disabled={!tappable || saving}
                    accessibilityRole={tappable ? 'button' : 'image'}
                    accessibilityLabel={tappable ? `Split after page ${i + 1}` : `Page ${i + 1}`}
                    accessibilityState={{ selected: mode === 'at' && i === at }}
                    style={styles.cell}
                  >
                    <View
                      style={[
                        styles.page,
                        { backgroundColor: colors.placeholder, borderColor: first ? colors.accent : colors.border },
                        used && !used.has(i) && styles.unused,
                      ]}
                    >
                      <PageThumb uri={uri} style={styles.pageImg} />
                      <View style={[styles.badge, { backgroundColor: first ? colors.accentFill : colors.scrim }]}>
                        <Text style={[styles.badgeText, { color: colors.onAccent }]}>{i + 1}</Text>
                      </View>
                    </View>
                    {cutAfter.has(i) ? (
                      // The cut: a bar in the gap after the chosen page.
                      <View style={[styles.cut, { backgroundColor: colors.accent }]} />
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          ) : pdfFailed ? (
            <ToolNote>This PDF’s pages couldn’t be shown. It may be password protected: open it first and enter its password.</ToolNote>
          ) : (
            <View style={styles.loading}>
              <ActivityIndicator color={colors.muted} />
            </View>
          )}
          {parts && mode === 'at' ? (
            <Text style={[Type.footnote, styles.summary, { color: colors.muted }]}>
              {`“${doc.name} (1)” gets ${range(1, parts[0].length)}, “${doc.name} (2)” gets ${range(parts[0].length + 1, count)}. Tap a page to split after it.`}
            </Text>
          ) : parts ? (
            <Text style={[Type.footnote, styles.summary, { color: colors.muted }]}>{`${describeParts(parts)}.`}</Text>
          ) : null}

          <SectionLabel>Original</SectionLabel>
          <OptionList options={keepOptions(parts?.length ?? null, keptBecause)} value={keepChoice} onChange={setKeep} />
        </>
      ) : null}
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: Spacing.md },
  cell: { width: '33.33%', paddingRight: Spacing.md, position: 'relative' },
  page: { aspectRatio: 0.75, borderRadius: Radius.sm, overflow: 'hidden', borderWidth: 2 },
  pageImg: { width: '100%', height: '100%' },
  badge: {
    position: 'absolute',
    left: 6,
    bottom: 6,
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 12, fontWeight: '700' },
  cut: { position: 'absolute', right: Spacing.md / 2 - 1.5, top: 4, bottom: 4, width: 3, borderRadius: 1.5 },
  loading: { paddingVertical: Spacing.xxl, alignItems: 'center' },
  summary: { marginTop: Spacing.md, marginHorizontal: Spacing.xs, lineHeight: 18 },
  input: { borderRadius: Radius.md, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md, minHeight: 50 },
  unused: { opacity: 0.35 },
});
