// components/thumbnail-strip.tsx
// The viewer's page strip. The viewer is always-dark chrome, so this uses the
// `chrome*` colours regardless of the app theme.
import { useEffect, useRef } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { Spacing } from '@/lib/theme';

type Props = {
  pages: string[];
  currentPage: number;
  onPagePress: (index: number) => void;
  onAddPress: () => void;
  bottomInset: number;
  /** Cache-bust value (typically document.updatedAt) so RN <Image> reloads after page files are overwritten in place. */
  cacheBust?: number;
  /** Disables the Add tile while pages are being added. */
  adding?: boolean;
};

const THUMB_W = 48;
const THUMB_H = 64;
const GAP = 8;
// Thumb width + gap = stride. getItemLayout makes scrollToIndex deterministic
// even before items have laid out.
const ITEM_STRIDE = THUMB_W + GAP;

export function ThumbnailStrip({
  pages,
  currentPage,
  onPagePress,
  onAddPress,
  bottomInset,
  cacheBust,
  adding,
}: Props) {
  const { colors } = useTheme();
  const listRef = useRef<FlatList>(null);

  useEffect(() => {
    if (pages.length > 0 && currentPage < pages.length) {
      listRef.current?.scrollToIndex({ index: currentPage, animated: true, viewPosition: 0.5 });
    }
  }, [currentPage, pages.length]);

  return (
    <View style={[styles.container, { paddingBottom: bottomInset + Spacing.sm, backgroundColor: colors.chromeRaised }]}>
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
          const active = index === currentPage;
          return (
            <Pressable
              style={[styles.thumb, { borderColor: active ? colors.accent : 'transparent', backgroundColor: colors.chrome }]}
              onPress={() => onPagePress(index)}
              accessibilityRole="button"
              accessibilityLabel={`Page ${index + 1} of ${pages.length}`}
              accessibilityState={{ selected: active }}
            >
              <Image
                source={{ uri: cacheBust ? `${item}?v=${cacheBust}` : item }}
                style={styles.thumbImage}
                resizeMode="cover"
              />
              <View style={[styles.badge, { backgroundColor: active ? colors.accentFill : 'rgba(0,0,0,0.6)' }]}>
                <Text allowFontScaling={false} style={[styles.badgeText, { color: colors.chromeText }]}>
                  {index + 1}
                </Text>
              </View>
            </Pressable>
          );
        }}
        ListFooterComponent={
          <Pressable
            style={({ pressed }) => [
              styles.addBtn,
              { borderColor: colors.chromeMuted },
              (pressed || adding) && { opacity: 0.5 },
            ]}
            onPress={onAddPress}
            disabled={adding}
            accessibilityRole="button"
            accessibilityLabel="Add pages"
            accessibilityState={{ disabled: !!adding, busy: !!adding }}
          >
            <Ionicons name="add" size={24} color={colors.chromeText} />
            <Text allowFontScaling={false} style={[styles.addLabel, { color: colors.chromeMuted }]}>Add</Text>
          </Pressable>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: Spacing.sm + 2,
  },
  content: {
    paddingHorizontal: Spacing.md,
    gap: GAP,
  },
  thumb: {
    width: THUMB_W,
    height: THUMB_H,
    borderRadius: 6,
    borderWidth: 2,
    overflow: 'hidden',
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  badge: {
    position: 'absolute',
    bottom: 2,
    alignSelf: 'center',
    minWidth: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    alignItems: 'center',
  },
  badgeText: { fontSize: 10, fontWeight: '700', lineHeight: 14 },
  addBtn: {
    width: THUMB_W,
    height: THUMB_H,
    borderRadius: 6,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addLabel: { fontSize: 10, marginTop: 2, fontWeight: '500' },
});
