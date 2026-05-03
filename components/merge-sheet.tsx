// components/merge-sheet.tsx
import { FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { BottomSheet } from '@/components/bottom-sheet';
import { Document } from '@/types/document';
import { useTheme } from '@/contexts/theme-context';

type Props = {
  visible: boolean;
  targetDoc: Document | null;
  allDocs: Document[];
  onMerge: (targetDoc: Document, sourceDoc: Document) => void;
  onClose: () => void;
};

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

export function MergeSheet({ visible, targetDoc, allDocs, onMerge, onClose }: Props) {
  const { colors } = useTheme();
  const sources = allDocs.filter(d => d.id !== targetDoc?.id);

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={[styles.heading, { color: colors.text }]}>Merge with…</Text>
      <Text style={[styles.sub, { color: colors.muted }]}>Pages will be appended to "{targetDoc?.name}"</Text>
      {sources.length === 0 ? (
        <Text style={[styles.empty, { color: colors.faint }]}>No other documents to merge with.</Text>
      ) : (
        <FlatList
          data={sources}
          keyExtractor={d => d.id}
          scrollEnabled={sources.length > 4}
          style={{ maxHeight: 280 }}
          renderItem={({ item }) => (
            <Pressable
              style={[styles.docRow, { borderBottomColor: colors.border }]}
              onPress={() => { onClose(); onMerge(targetDoc!, item); }}
            >
              {item.pages[0] ? (
                <Image source={{ uri: `${item.pages[0]}?v=${item.updatedAt}` }} style={styles.thumb} />
              ) : (
                <View style={[styles.thumb, { backgroundColor: colors.placeholder }]} />
              )}
              <View style={styles.docInfo}>
                <Text style={[styles.docName, { color: colors.text }]} numberOfLines={2}>{item.name}</Text>
                <Text style={[styles.docMeta, { color: colors.faint }]}>
                  {item.pages.length} page{item.pages.length !== 1 ? 's' : ''} · {formatDate(item.createdAt)}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 18, fontWeight: '700', marginBottom: 4 },
  sub: { fontSize: 13, marginBottom: 14 },
  empty: { fontSize: 14, paddingVertical: 24, textAlign: 'center' },
  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  thumb: { width: 40, height: 52, borderRadius: 4 },
  docInfo: { flex: 1 },
  docName: { fontSize: 14, fontWeight: '600' },
  docMeta: { fontSize: 12, marginTop: 2 },
});
