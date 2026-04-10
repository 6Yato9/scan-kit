// components/thumbnail-strip.tsx
import { useEffect, useRef } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { PageFilter } from '@/types/document';
import { filterStyle } from '@/lib/filters';
import { useTheme } from '@/contexts/theme-context';

type Props = {
  pages: string[];
  filters?: PageFilter[];
  currentPage: number;
  onPagePress: (index: number) => void;
  onAddPress: () => void;
  bottomInset: number;
};

export function ThumbnailStrip({
  pages,
  filters,
  currentPage,
  onPagePress,
  onAddPress,
  bottomInset,
}: Props) {
  const { colors } = useTheme();
  const listRef = useRef<FlatList>(null);

  useEffect(() => {
    if (pages.length > 0) {
      listRef.current?.scrollToIndex({ index: currentPage, animated: true, viewPosition: 0.5 });
    }
  }, [currentPage, pages.length]);

  return (
    <View style={[styles.container, { paddingBottom: bottomInset + 8 }]}>
      <FlatList
        ref={listRef}
        data={pages}
        keyExtractor={(_, i) => String(i)}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.content}
        onScrollToIndexFailed={() => {}}
        renderItem={({ item, index }) => {
          const fStyle = filterStyle(filters?.[index]);
          return (
            <Pressable
              style={[styles.thumb, index === currentPage && { borderColor: colors.accent }]}
              onPress={() => onPagePress(index)}
            >
              <Image
                source={{ uri: item }}
                style={[styles.thumbImage, fStyle ? ({ filter: fStyle } as any) : undefined]}
                resizeMode="cover"
              />
            </Pressable>
          );
        }}
        ListFooterComponent={
          <Pressable style={styles.addBtn} onPress={onAddPress}>
            <Text style={styles.addIcon}>＋</Text>
            <Text style={styles.addLabel}>Add</Text>
          </Pressable>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#1a1a1a',
    paddingTop: 8,
  },
  content: {
    paddingHorizontal: 8,
    gap: 6,
  },
  thumb: {
    width: 48,
    height: 64,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: 'transparent',
    overflow: 'hidden',
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  addBtn: {
    width: 48,
    height: 64,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: '#555',
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addIcon: { fontSize: 18, color: '#999' },
  addLabel: { fontSize: 9, color: '#999', marginTop: 2 },
});
