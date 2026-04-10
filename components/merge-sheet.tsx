// components/merge-sheet.tsx
import { FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { BottomSheet } from '@/components/bottom-sheet';
import { Document } from '@/types/document';

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
  const sources = allDocs.filter(d => d.id !== targetDoc?.id);

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={styles.heading}>Merge with…</Text>
      <Text style={styles.sub}>Pages will be appended to "{targetDoc?.name}"</Text>
      {sources.length === 0 ? (
        <Text style={styles.empty}>No other documents to merge with.</Text>
      ) : (
        <FlatList
          data={sources}
          keyExtractor={d => d.id}
          scrollEnabled={sources.length > 4}
          style={{ maxHeight: 280 }}
          renderItem={({ item }) => (
            <Pressable
              style={styles.docRow}
              onPress={() => { onClose(); onMerge(targetDoc!, item); }}
            >
              {item.pages[0] ? (
                <Image source={{ uri: item.pages[0] }} style={styles.thumb} />
              ) : (
                <View style={[styles.thumb, styles.thumbPlaceholder]} />
              )}
              <View style={styles.docInfo}>
                <Text style={styles.docName} numberOfLines={2}>{item.name}</Text>
                <Text style={styles.docMeta}>
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
  heading: { fontSize: 18, fontWeight: '700', marginBottom: 4, color: '#1a1a1a' },
  sub: { fontSize: 13, color: '#888', marginBottom: 14 },
  empty: { fontSize: 14, color: '#999', paddingVertical: 24, textAlign: 'center' },
  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e8e8e8',
    gap: 12,
  },
  thumb: { width: 40, height: 52, borderRadius: 4, backgroundColor: '#e8e8e8' },
  thumbPlaceholder: { backgroundColor: '#e8e8e8' },
  docInfo: { flex: 1 },
  docName: { fontSize: 14, fontWeight: '600', color: '#1a1a1a' },
  docMeta: { fontSize: 12, color: '#999', marginTop: 2 },
});
