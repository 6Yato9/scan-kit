// components/document-card.tsx
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Document } from '@/types/document';
import { useTheme } from '@/contexts/theme-context';

type Props = {
  document: Document;
  onPress: () => void;
  onLongPress: () => void;
  isSelected?: boolean;
  isMultiSelectMode?: boolean;
};

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

export function DocumentCard({ document, onPress, onLongPress, isSelected, isMultiSelectMode }: Props) {
  const { colors } = useTheme();
  return (
    <Pressable style={[styles.card, { backgroundColor: colors.card }]} onPress={onPress} onLongPress={onLongPress}>
      {document.pages[0] ? (
        <Image source={{ uri: `${document.pages[0]}?v=${document.updatedAt}` }} style={styles.thumbnail} />
      ) : (
        <View style={[styles.thumbnail, { backgroundColor: colors.placeholder }]} />
      )}
      <View style={styles.info}>
        <Text style={[styles.name, { color: colors.text }]} numberOfLines={2}>{document.name}</Text>
        <Text style={[styles.meta, { color: colors.faint }]}>
          {document.pages.length} page{document.pages.length !== 1 ? 's' : ''} · {formatDate(document.createdAt)}
        </Text>
      </View>
      {isMultiSelectMode && (
        <View style={[styles.checkbox, isSelected && { backgroundColor: colors.accent, borderColor: colors.accent }]}>
          {isSelected && <Text style={styles.checkmark}>✓</Text>}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    margin: 6,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
    overflow: 'hidden',
  },
  thumbnail: { width: '100%', aspectRatio: 0.75 },
  info: { padding: 10 },
  name: { fontSize: 13, fontWeight: '600', marginBottom: 3 },
  meta: { fontSize: 11 },
  checkbox: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#fff',
    backgroundColor: 'rgba(0,0,0,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkmark: { color: '#fff', fontSize: 13, fontWeight: '700' },
});
