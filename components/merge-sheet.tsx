// components/merge-sheet.tsx
// Pick a document whose pages get appended to the target.
import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { PageThumb } from '@/components/page-thumb';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet, SheetHeader } from '@/components/bottom-sheet';
import { documentMeta } from '@/components/document-card';
import { Document } from '@/types/document';
import { useTheme } from '@/contexts/theme-context';
import { Radius, Spacing, Type } from '@/lib/theme';

type Props = {
  visible: boolean;
  targetDoc: Document | null;
  allDocs: Document[];
  onMerge: (targetDoc: Document, sourceDoc: Document) => void;
  onClose: () => void;
};

export function MergeSheet({ visible, targetDoc, allDocs, onMerge, onClose }: Props) {
  const { colors } = useTheme();
  const [target, setTarget] = useState<Document | null>(targetDoc);
  useEffect(() => { if (targetDoc) setTarget(targetDoc); }, [targetDoc]);
  // Exclude PDF-only docs from the merge picker — the merge code path appends
  // image pages and can't combine PDFs.
  const sources = allDocs.filter(d => d.id !== target?.id && !d.pdfUri && d.pages.length > 0);

  return (
    <BottomSheet visible={visible} onClose={onClose} variant="grouped">
      <SheetHeader
        title="Merge with another document"
        subtitle={target ? `Its pages are added to the end of “${target.name}”. The other document is kept.` : undefined}
      />
      {sources.length === 0 ? (
        <View style={[styles.empty, { backgroundColor: colors.card }]}>
          <Ionicons name="documents-outline" size={28} color={colors.muted} />
          <Text style={[Type.callout, { color: colors.muted, textAlign: 'center' }]}>
            There are no other scanned documents to merge with.
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
                {item.pages[0] ? (
                  <PageThumb uri={`${item.pages[0]}?v=${item.updatedAt}`} style={[styles.thumb, { backgroundColor: colors.placeholder }]} />
                ) : (
                  <View style={[styles.thumb, { backgroundColor: colors.placeholder }]} />
                )}
                <View
                  style={[
                    styles.docInfo,
                    index < sources.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[Type.subhead, { color: colors.text, fontWeight: '600' }]} numberOfLines={1}>{item.name}</Text>
                    <Text style={[Type.footnote, { color: colors.muted, marginTop: 2 }]} numberOfLines={1}>{documentMeta(item)}</Text>
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
  docInfo: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.sm + 2, paddingRight: Spacing.lg, gap: Spacing.sm },
});
