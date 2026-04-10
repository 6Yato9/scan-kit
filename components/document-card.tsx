// components/document-card.tsx
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Document } from '@/types/document';

type Props = {
  document: Document;
  onPress: () => void;
  onLongPress: () => void;
};

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function DocumentCard({ document, onPress, onLongPress }: Props) {
  return (
    <Pressable style={styles.card} onPress={onPress} onLongPress={onLongPress}>
      {document.pages[0] ? (
        <Image source={{ uri: document.pages[0] }} style={styles.thumbnail} />
      ) : (
        <View style={[styles.thumbnail, styles.thumbnailPlaceholder]} />
      )}
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={2}>
          {document.name}
        </Text>
        <Text style={styles.meta}>
          {document.pages.length} page{document.pages.length !== 1 ? 's' : ''} ·{' '}
          {formatDate(document.createdAt)}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    margin: 6,
    borderRadius: 12,
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
    overflow: 'hidden',
  },
  thumbnail: {
    width: '100%',
    aspectRatio: 0.75,
  },
  thumbnailPlaceholder: {
    backgroundColor: '#e8e8e8',
  },
  info: {
    padding: 10,
  },
  name: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1a1a1a',
    marginBottom: 3,
  },
  meta: {
    fontSize: 11,
    color: '#999',
  },
});
