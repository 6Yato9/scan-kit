// app/tools/extract.tsx
// Copy chosen pages of a document into a new document (lib/doc-ops
// extractPages). Each page travels with its .orig shadow so its filter
// metadata stays truthful.
//
// Round 16: under More options, pages can also be chosen by number ("1-3, 5",
// lib/page-ranges.ts; the field follows taps on the grid and the grid follows
// the field) or as all odd / all even pages (fronts and backs scanned as one
// stack).
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useTheme } from '@/contexts/theme-context';
import { PageThumb } from '@/components/page-thumb';
import { PrimaryButton } from '@/components/primary-button';
import { NoDocumentsScreen, SectionRow, ToolScreen, isSinglePageDoc, pageCountLabel, useToolDocuments } from '@/components/tool-ui';
import { SectionLabel } from '@/components/section-label';
import { ToolDocPicker, useToolDoc } from '@/components/tool-doc';
import { FilterBaker } from '@/components/filter-baker';
import { extractPages } from '@/lib/doc-ops';
import { MoreOptions } from '@/components/more-options';
import { oddEvenPages, pagesInRanges, parsePageRanges, selectionLabel } from '@/lib/page-ranges';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { Radius, Spacing, Type } from '@/lib/theme';
import type { Document } from '@/types/document';
import { navigateWhenUnlocked } from '@/lib/nav-guard';

export default function ExtractScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { docs, loaded } = useToolDocuments(d => !d.pdfUri && d.pages.length > 1);
  // One-page documents: offered "Add pages" instead of a dead end.
  const { docs: singles, loaded: singlesLoaded } = useToolDocuments(isSinglePageDoc);
  const [pages, setPages] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // The selection as typed page numbers; kept in step with taps on the grid.
  const [rangeText, setRangeText] = useState('');
  const [rangeError, setRangeError] = useState<string | null>(null);

  const { doc, docId, setDocId, fixed, fromViewer } = useToolDoc(docs);

  const pick = (d: Document) => {
    if (d.id === docId) return;
    setDocId(d.id);
    setPages(new Set());
    setRangeText('');
    setRangeError(null);
  };

  /** A new selection from the grid or a button: the field shows it as ranges. */
  const select = (next: Set<number>) => {
    setPages(next);
    setRangeText(selectionLabel(next));
    setRangeError(null);
  };

  const toggle = (i: number) => {
    const next = new Set(pages);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    select(next);
  };

  /** Typed page numbers select those pages as soon as they make sense. */
  const typeRanges = (text: string) => {
    setRangeText(text);
    if (!doc) return;
    if (!text.trim()) {
      setPages(new Set());
      setRangeError(null);
      return;
    }
    const r = parsePageRanges(text, doc.pages.length);
    if (r.ok) {
      setPages(new Set(pagesInRanges(r.ranges)));
      setRangeError(null);
    } else {
      setRangeError(r.error);
    }
  };

  const allSelected = !!doc && pages.size === doc.pages.length;

  const handleExtract = async () => {
    if (!doc || pages.size === 0 || saving) return;
    setSaving(true);
    try {
      // Copies under the document lock from the stored record (lib/doc-ops).
      const created = await extractPages(doc, [...pages]);
      notifySuccess();
      // The viewer shows the toast: it covers the app-wide toast host.
      navigateWhenUnlocked(() => router.replace({
        pathname: '/viewer',
        params: { id: created.id, notice: `${pageCountLabel(created.pages.length)} saved as a new document` },
      }));
    } catch {
      notifyError();
      Alert.alert('Couldn’t extract pages', 'A page file couldn’t be copied. The original document is unchanged. Try again.');
    } finally {
      setSaving(false);
    }
  };

  if (loaded && singlesLoaded && docs.length === 0) {
    return (
      <NoDocumentsScreen
        toolTitle="Extract pages"
        icon="cut-outline"
        title="No multi-page documents"
        subtitle={
          singles.length
            ? 'Extracting pages needs a document with at least two pages, and yours have one each. Add pages to one, or scan a new document.'
            : 'Extracting pages needs a document with at least two pages. Scan or import one first.'
        }
        addPagesTo={singles}
      />
    );
  }

  return (
    <ToolScreen
      title="Extract pages"
      footer={
        <PrimaryButton
          title={doc && pages.size ? `Extract ${pageCountLabel(pages.size)}` : 'Extract pages'}
          onPress={handleExtract}
          disabled={pages.size === 0}
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
        note="Scanned documents with two or more pages. For an imported PDF, use Split."
        onPick={pick}
      />

      {doc ? (
        <>
          <SectionRow
            label={`Pages, ${pages.size} selected`}
            action={allSelected ? 'Select none' : 'Select all'}
            onAction={() => select(allSelected ? new Set() : new Set(doc.pages.map((_, i) => i)))}
          />
          <View style={styles.grid}>
            {doc.pages.map((uri, i) => {
              const on = pages.has(i);
              return (
                <Pressable
                  key={`${uri}-${i}`}
                  onPress={() => toggle(i)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`Page ${i + 1}`}
                  style={[
                    styles.page,
                    { borderColor: on ? colors.accent : colors.border, backgroundColor: colors.placeholder },
                  ]}
                >
                  <PageThumb uri={`${uri}?v=${doc.updatedAt}`} style={styles.pageImg} />
                  <View style={[styles.pageNum, { backgroundColor: on ? colors.accentFill : colors.scrim }]}>
                    <Text style={[styles.pageNumText, { color: colors.onAccent }]} allowFontScaling={false}>{i + 1}</Text>
                  </View>
                  {on ? (
                    <View style={[styles.check, { backgroundColor: colors.accentFill }]}>
                      <Ionicons name="checkmark" size={16} color={colors.onAccent} />
                    </View>
                  ) : (
                    // An empty ring on every unchosen page, so the grid reads as selectable.
                    <View style={[styles.check, styles.checkEmpty, { borderColor: colors.onScrim, backgroundColor: colors.scrimSoft }]} />
                  )}
                </Pressable>
              );
            })}
          </View>
          <MoreOptions open={moreOpen} onToggle={setMoreOpen}>
            <SectionLabel>Select by page number</SectionLabel>
            <TextInput
              style={[Type.body, styles.input, { color: colors.text, backgroundColor: colors.card }]}
              value={rangeText}
              onChangeText={typeRanges}
              placeholder={doc.pages.length > 3 ? `For example 1-2, ${doc.pages.length}` : 'For example 1, 2'}
              placeholderTextColor={colors.muted}
              keyboardType="numbers-and-punctuation"
              autoCorrect={false}
              returnKeyType="done"
              editable={!saving}
              accessibilityLabel="Pages to extract"
            />
            <Text
              style={[Type.footnote, styles.note, { color: rangeError ? colors.danger : colors.muted }]}
              accessibilityLiveRegion="polite"
            >
              {rangeError ?? 'Numbers and ranges, separated by commas. “7-” runs to the last page.'}
            </Text>
            <View style={styles.chips}>
              {(['odd', 'even'] as const).map(which => (
                <Pressable
                  key={which}
                  onPress={() => select(new Set(oddEvenPages(doc.pages.length, which)))}
                  disabled={saving}
                  // 36 pt chips: the slop gives them a 44 pt touch area.
                  hitSlop={{ top: 4, bottom: 4 }}
                  accessibilityRole="button"
                  accessibilityLabel={which === 'odd' ? 'Select odd pages' : 'Select even pages'}
                  style={({ pressed }) => [styles.chip, { backgroundColor: colors.card }, pressed && styles.pressed]}
                >
                  <Text style={[Type.subhead, { color: colors.text }]} numberOfLines={1} maxFontSizeMultiplier={1.4}>
                    {which === 'odd' ? 'Odd pages' : 'Even pages'}
                  </Text>
                </Pressable>
              ))}
            </View>
          </MoreOptions>
        </>
      ) : null}
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md },
  page: {
    width: '30.5%',
    aspectRatio: 0.75,
    borderRadius: Radius.sm,
    overflow: 'hidden',
    borderWidth: 2,
  },
  pageImg: { width: '100%', height: '100%' },
  pageNum: {
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
  pageNumText: { fontSize: 12, fontWeight: '700' },
  check: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkEmpty: { borderWidth: 1.5 },
  input: { borderRadius: Radius.md, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md, minHeight: 50 },
  note: { marginTop: Spacing.sm, marginHorizontal: Spacing.xs, lineHeight: 18 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.md },
  chip: { borderRadius: Radius.pill, paddingHorizontal: Spacing.lg, minHeight: 36, justifyContent: 'center' },
  pressed: { opacity: 0.6 },
});
