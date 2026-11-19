// components/merge-sheet.tsx
// Pick a document to merge with the target.
//
// Two scanned documents: the other one's pages are appended to the target
// (lib/doc-ops mergeInto). When either is an imported PDF, the two become ONE
// new PDF document instead (lib/pdf-edit mergeDocumentsToPdf): PDF pages keep
// their text, scanned pages are rendered on the user's paper size, and both
// originals are kept. PDFs are offered only in builds that can merge them.
import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { PageThumb } from '@/components/page-thumb';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet, SheetHeader } from '@/components/bottom-sheet';
import { documentMeta } from '@/components/document-card';
import { Document } from '@/types/document';
import { useTheme } from '@/contexts/theme-context';
import { canMergePdfDocuments } from '@/lib/pdf-edit';
import { usePdfThumbnail } from '@/lib/pdf-thumb';
import { Radius, Spacing, Type } from '@/lib/theme';

type Props = {
  visible: boolean;
  targetDoc: Document | null;
  allDocs: Document[];
  onMerge: (targetDoc: Document, sourceDoc: Document) => void;
  onClose: () => void;
};

/** Documents `target` can be merged with, in list order. */
export function mergeCandidates(target: Document | null, allDocs: Document[], pdfMerge: boolean): Document[] {
  if (!target) return [];
  if (target.pdfUri && !pdfMerge) return [];
  return allDocs.filter(
    d => d.id !== target.id && !d.trashedAt && (d.pdfUri ? pdfMerge : d.pages.length > 0),
  );
}

/**
 * The sheet's subtitle: what merging will do. It has two lines at most
 * (SheetHeader), so what matters comes first and the name, which may be
 * long, last: a cut can only shorten the name. What picking a PDF does
 * instead is said on the PDF rows themselves (mergeRowMeta).
 */
export function mergeSubtitle(target: Document): string {
  if (target.pdfUri) return `Both are kept. They become one new PDF, starting with “${target.name}”.`;
  return `The document you pick is kept. Its pages are added to the end of “${target.name}”.`;
}

/** A row's second line: its usual meta, and for a PDF picked for a scan, that a new PDF is made instead. */
export function mergeRowMeta(target: Document | null, item: Document, meta: string): string {
  return target && !target.pdfUri && item.pdfUri ? `Makes a new PDF · ${meta}` : meta;
}

function Thumb({ doc }: { doc: Document }) {
  const { colors } = useTheme();
  const pdfThumb = usePdfThumbnail(doc.id, doc.pdfUri);
  const style = [styles.thumb, { backgroundColor: colors.placeholder }];
  if (doc.pdfUri) {
    return pdfThumb ? (
      <PageThumb uri={pdfThumb} style={style} />
    ) : (
      <View style={[style, styles.thumbIcon]}>
        <Ionicons name="document-text-outline" size={20} color={colors.muted} />
      </View>
    );
  }
  return doc.pages[0] ? <PageThumb uri={`${doc.pages[0]}?v=${doc.updatedAt}`} style={style} /> : <View style={style} />;
}

export function MergeSheet({ visible, targetDoc, allDocs, onMerge, onClose }: Props) {
  const { colors } = useTheme();
  const [target, setTarget] = useState<Document | null>(targetDoc);
  useEffect(() => { if (targetDoc) setTarget(targetDoc); }, [targetDoc]);
  const pdfMerge = canMergePdfDocuments();
  const sources = mergeCandidates(target, allDocs, pdfMerge);

  return (
    <BottomSheet visible={visible} onClose={onClose} variant="grouped">
      <SheetHeader
        title="Merge with another document"
        subtitle={target ? mergeSubtitle(target) : undefined}
      />
      {sources.length === 0 ? (
        <View style={[styles.empty, { backgroundColor: colors.card }]}>
          <Ionicons name="documents-outline" size={28} color={colors.muted} />
          <Text style={[Type.callout, { color: colors.muted, textAlign: 'center' }]}>
            {pdfMerge ? 'There are no other documents to merge with.' : 'There are no other scanned documents to merge with.'}
          </Text>
        </View>
      ) : (
        <View style={[styles.group, { backgroundColor: colors.card }]}>
          <FlatList
            data={sources}
            keyExtractor={d => d.id}
            scrollEnabled={sources.length > 5}
            style={styles.list}
            renderItem={({ item, index }) => (
              <Pressable
                style={({ pressed }) => [styles.docRow, pressed && { backgroundColor: colors.separator }]}
                onPress={() => { onClose(); if (target) onMerge(target, item); }}
                accessibilityRole="button"
                accessibilityLabel={`Merge ${item.name}`}
              >
                <Thumb doc={item} />
                <View
                  style={[
                    styles.docInfo,
                    index < sources.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[Type.subhead, { color: colors.text, fontWeight: '600' }]} numberOfLines={1}>{item.name}</Text>
                    <Text style={[Type.footnote, { color: colors.muted, marginTop: 2 }]} numberOfLines={1}>
                      {mergeRowMeta(target, item, documentMeta(item))}
                    </Text>
                  </View>
                  <Ionicons name="add-circle-outline" size={22} color={colors.accent} />
                </View>
              </Pressable>
            )}
          />
        </View>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  group: { borderRadius: Radius.md, overflow: 'hidden' },
  list: { maxHeight: 340 },
  empty: { borderRadius: Radius.md, alignItems: 'center', gap: Spacing.sm, padding: Spacing.xxl },
  docRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: Spacing.md, gap: Spacing.md },
  thumb: { width: 36, height: 48, borderRadius: 5 },
  thumbIcon: { alignItems: 'center', justifyContent: 'center' },
  docInfo: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.sm + 2, paddingRight: Spacing.lg, gap: Spacing.sm },
});
