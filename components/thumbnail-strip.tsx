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
import { PageAdjustment, PageFilter } from '@/types/document';
import { combinedFilterStyle } from '@/lib/filters';
import { useTheme } from '@/contexts/theme-context';

type Props = {
  pages: string[];
  filters?: PageFilter[];
  adjustments?: PageAdjustment[];
  currentPage: number;
  onPagePress: (index: number) => void;
  onAddPress: () => void;
  bottomInset: number;
  /** Cache-bust value (typically document.updatedAt) so RN <Image> reloads after page files are overwritten by rotate/annotate/compress. */
  cacheBust?: number;
};

export function ThumbnailStrip({
  pages,
  filters,
  adjustments,
  currentPage,
  onPagePress,
  onAddPress,
  bottomInset,
  cacheBust,
}: Props) {
  const { colors } = useTheme();
  const listRef = useRef<FlatList>(null);

  useEffect(() => {
    if (pages.length > 0) {
      listRef.current?.scrollToIndex({ index: currentPage, animated: true, viewPosition: 0.5 });
    }
  }, [currentPage, pages.length]);

  // Width 48 + gap 6 in content style = 54 px stride. Providing getItemLayout
  // makes scrollToIndex deterministic even before items have laid out.
  const ITEM_STRIDE = 54;

  return (
    <View style={[styles.container, { paddingBottom: bottomInset + 8, backgroundColor: colors.card }]}>
      <FlatList
        ref={listRef}
        data={pages}
        keyExtractor={(_, i) => String(i)}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.content}
        getItemLayout={(_, i) => ({ length: ITEM_STRIDE, offset: ITEM_STRIDE * i, index: i })}
        onScrollToIndexFailed={({ index }) => {
          // Layout race: retry after a tick.
          setTimeout(() => {
            listRef.current?.scrollToOffset({ offset: ITEM_STRIDE * index, animated: false });
          }, 50);
        }}
        renderItem={({ item, index }) => {
          const fStyle = combinedFilterStyle(filters?.[index], adjustments?.[index]);
          return (
            <Pressable
              style={[styles.thumb, index === currentPage && { borderColor: colors.accent }]}
              onPress={() => onPagePress(index)}
            >
              <Image
                source={{ uri: cacheBust ? `${item}?v=${cacheBust}` : item }}
                style={[styles.thumbImage, fStyle ? ({ filter: fStyle } as any) : undefined]}
                resizeMode="cover"
              />
            </Pressable>
          );
        }}
        ListFooterComponent={
          <Pressable style={[styles.addBtn, { borderColor: colors.border }]} onPress={onAddPress}>
            <Text style={[styles.addIcon, { color: colors.muted }]}>＋</Text>
            <Text allowFontScaling={false} style={[styles.addLabel, { color: colors.muted }]}>Add</Text>
          </Pressable>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
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
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addIcon: { fontSize: 18 },
  addLabel: { fontSize: 9, marginTop: 2 },
});
