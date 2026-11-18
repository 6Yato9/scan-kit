// app/tools/extract.tsx
// Copy chosen pages of a document into a new document (lib/doc-ops
// extractPages). Each page travels with its .orig shadow so its filter
// metadata stays truthful.
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useTheme } from '@/contexts/theme-context';
import { PageThumb } from '@/components/page-thumb';
import { PrimaryButton } from '@/components/primary-button';
import { NoDocumentsScreen, SectionRow, ToolScreen, isSinglePageDoc, pageCountLabel, useToolDocuments } from '@/components/tool-ui';
import { ToolDocPicker, useToolDoc } from '@/components/tool-doc';
import { FilterBaker } from '@/components/filter-baker';
import { extractPages } from '@/lib/doc-ops';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { Radius, Spacing } from '@/lib/theme';
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

  const { doc, docId, setDocId, fixed, fromViewer } = useToolDoc(docs);

  const pick = (d: Document) => {
    if (d.id === docId) return;
    setDocId(d.id);
    setPages(new Set());
  };

  const toggle = (i: number) =>
    setPages(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

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
        note="Documents with two or more pages. Imported PDFs can’t be split."
        onPick={pick}
      />

      {doc ? (
        <>
          <SectionRow
            label={`Pages, ${pages.size} selected`}
            action={allSelected ? 'Select none' : 'Select all'}
            onAction={() => setPages(allSelected ? new Set() : new Set(doc.pages.map((_, i) => i)))}
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
                    <Text style={[styles.pageNumText, { color: colors.onAccent }]}>{i + 1}</Text>
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
});
