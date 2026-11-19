// app/tools/split.tsx
// Split a document in two after a chosen page. Scanned documents are split
// by lib/doc-ops splitDocument: every page is copied with its shadows (the
// unfiltered .orig, the source photo and its crop), filter and adjustments,
// so both parts can still be filtered and re-cropped. Imported PDFs are split
// by PDFKit without redrawing a page (lib/pdf-edit splitStoredPdf), so their
// text stays selectable. Either way the parts are "<name> (1)" and
// "<name> (2)" in the same folder, and the original is kept unless the user
// chooses to move it to Recently deleted.
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/contexts/theme-context';
import { useScan } from '@/contexts/scan-context';
import { PageThumb } from '@/components/page-thumb';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import { NoDocumentsScreen, OptionList, ToolNote, ToolScreen, isSinglePageDoc, useToolDocuments } from '@/components/tool-ui';
import { ToolDocPicker, useToolDoc } from '@/components/tool-doc';
import { FilterBaker } from '@/components/filter-baker';
import { splitDocument, splitRanges } from '@/lib/doc-ops';
import { canEditPdfPages, PdfEditError, splitStoredPdf } from '@/lib/pdf-edit';
import { useReadablePdfUri, withNoPasswordNote } from '@/lib/pdf-session';
import { pdfPageThumbnails } from '@/lib/pdf-thumb';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { Radius, Spacing, Type } from '@/lib/theme';
import type { Document } from '@/types/document';

type Keep = 'keep' | 'trash';

const KEEP_OPTIONS: { value: Keep; label: string; detail: string }[] = [
  { value: 'keep', label: 'Keep the original', detail: 'You get two new documents and keep this one.' },
  { value: 'trash', label: 'Move the original to Recently deleted', detail: 'You can restore it there for 30 days.' },
];

const range = (a: number, b: number) => (a === b ? `page ${a}` : `pages ${a}–${b}`);

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
  const parts = count > 1 ? splitRanges(count, at) : null;

  const pick = (d: Document) => {
    setDocId(d.id);
    setAfter(null);
  };

  const split = () => {
    if (!doc || !parts || saving) return;
    // Its parts won't need a password; with the original deleted, nothing
    // protected is left: said before it happens.
    if (doc.pdfUri && unlockedForSession && keep === 'trash') {
      Alert.alert(
        'Split without the password?',
        'The two new documents won’t need a password, and the protected original moves to Recently deleted.',
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
      const trashOriginal = keep === 'trash';
      const result = doc.pdfUri
        ? await splitStoredPdf(doc.id, at, { trashOriginal })
        : await splitDocument(doc.id, at, { trashOriginal, expectedCount: count });
      bumpLastSaved();
      notifySuccess();
      const notice = withNoPasswordNote(
        result.originalTrashed
          ? 'Split into two documents. The original is in Recently deleted.'
          : 'Split into two documents. The original is kept.',
        [doc.id],
      );
      // The first part opens; the viewer says what happened.
      navigateWhenUnlocked(() => router.replace({ pathname: '/viewer', params: { id: result.first.id, notice } }));
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
          title="Split into two documents"
          onPress={split}
          disabled={!parts}
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
          <SectionLabel>{parts ? `Split after page ${at + 1}` : 'Pages'}</SectionLabel>
          {thumbs ? (
            <View style={styles.grid}>
              {thumbs.map((uri, i) => {
                const first = i <= at;
                const last = i === count - 1;
                return (
                  <Pressable
                    key={`${uri}-${i}`}
                    onPress={() => { if (!last) setAfter(i); }}
                    disabled={last || saving}
                    accessibilityRole="button"
                    accessibilityLabel={last ? `Page ${i + 1}` : `Split after page ${i + 1}`}
                    accessibilityState={{ selected: i === at }}
                    style={styles.cell}
                  >
                    <View
                      style={[
                        styles.page,
                        { backgroundColor: colors.placeholder, borderColor: first ? colors.accent : colors.border },
                      ]}
                    >
                      <PageThumb uri={uri} style={styles.pageImg} />
                      <View style={[styles.badge, { backgroundColor: first ? colors.accentFill : colors.scrim }]}>
                        <Text style={[styles.badgeText, { color: colors.onAccent }]}>{i + 1}</Text>
                      </View>
                    </View>
                    {i === at ? (
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
          {parts ? (
            <Text style={[Type.footnote, styles.summary, { color: colors.muted }]}>
              {`“${doc.name} (1)” gets ${range(1, parts[0].length)}, “${doc.name} (2)” gets ${range(parts[0].length + 1, count)}. Tap a page to split after it.`}
            </Text>
          ) : null}

          <SectionLabel>Original</SectionLabel>
          <OptionList options={KEEP_OPTIONS} value={keep} onChange={setKeep} />
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
  summary: { marginTop: Spacing.md, marginHorizontal: Spacing.xs },
});
