// components/thumbnail-strip.tsx
// The viewer's page strip. The viewer is always-dark chrome, so this uses the
// `chrome*` colours regardless of the app theme.
//
// Tap a page to show it. Touch and hold a page to pick it up: drag it to a new
// place to reorder, or let go without moving to open the page's menu (Retake,
// Move, Delete…). The page number sits under each thumbnail, never on it.
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import DraggableFlatList, { ScaleDecorator, type RenderItemParams } from 'react-native-draggable-flatlist';
import { useTheme } from '@/contexts/theme-context';
import { PageThumb } from '@/components/page-thumb';
import { tapLight } from '@/lib/haptics';
import { Radius, Spacing } from '@/lib/theme';

type Props = {
  pages: string[];
  currentPage: number;
  onPagePress: (index: number) => void;
  onAddPress: () => void;
  /** Touch and hold, let go without moving: the page's menu. */
  onPageMenu?: (index: number) => void;
  /** A page was dragged from `from` to `to`. The strip shows the new order right away. */
  onReorder?: (from: number, to: number) => void;
  bottomInset: number;
  /** Cache-bust value (typically document.updatedAt) so RN <Image> reloads after page files are overwritten in place. */
  cacheBust?: number;
  /** Disables the Add tile while pages are being added. */
  adding?: boolean;
};

const THUMB_W = 48;
const THUMB_H = 64;
const GAP = 8;
const ITEM_STRIDE = THUMB_W + GAP;

/** The page order after moving page `from` to position `to`, as old indices. */
export function movedOrder(count: number, from: number, to: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  if (from < 0 || from >= count || to < 0 || to >= count || from === to) return order;
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  return order;
}

type Item = { key: string; uri: string };

export function ThumbnailStrip({
  pages,
  currentPage,
  onPagePress,
  onAddPress,
  onPageMenu,
  onReorder,
  bottomInset,
  cacheBust,
  adding,
}: Props) {
  const { colors } = useTheme();
  // DraggableFlatList forwards its ref to the inner FlatList; only scrolling is used.
  const listRef = useRef<{ scrollToOffset: (p: { offset: number; animated?: boolean }) => void } | null>(null);
  // The strip's own copy of the order, so a dropped page stays where it was
  // dropped while the files are being renamed (the next document read resets it).
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    setItems(pages.map((uri, i) => ({ key: `${i}:${cacheBust ?? 0}`, uri })));
  }, [pages, cacheBust]);

  useEffect(() => {
    if (pages.length === 0 || currentPage >= pages.length) return;
    // Centre the current page; offsets are exact (fixed-size cells).
    const t = setTimeout(() => {
      listRef.current?.scrollToOffset({
        offset: Math.max(0, ITEM_STRIDE * currentPage - ITEM_STRIDE * 2),
        animated: true,
      });
    }, 0);
    return () => clearTimeout(t);
  }, [currentPage, pages.length]);

  const canDrag = !!onReorder && pages.length > 1;

  const renderItem = ({ item, getIndex, drag, isActive }: RenderItemParams<Item>) => {
    const index = getIndex() ?? 0;
    const active = index === currentPage;
    const label = `Page ${index + 1} of ${pages.length}`;
    return (
      <ScaleDecorator activeScale={1.08}>
        <Pressable
          style={styles.cell}
          onPress={() => onPagePress(index)}
          onLongPress={() => {
            tapLight();
            if (canDrag) drag();
            else onPageMenu?.(index);
          }}
          delayLongPress={300}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ selected: active }}
          accessibilityHint={onPageMenu ? 'Touch and hold to move this page or see more options' : undefined}
          accessibilityActions={onPageMenu ? [{ name: 'longpress', label: 'Page options' }] : undefined}
          onAccessibilityAction={e => {
            if (e.nativeEvent.actionName === 'longpress') onPageMenu?.(index);
          }}
        >
          <View
            style={[
              styles.thumb,
              {
                borderColor: active ? colors.chromeAccent : colors.chromeBorder,
                borderWidth: active ? 2 : StyleSheet.hairlineWidth,
                backgroundColor: colors.chrome,
              },
              isActive && { borderColor: colors.chromeAccent, borderWidth: 2 },
            ]}
          >
            <PageThumb uri={cacheBust ? `${item.uri}?v=${cacheBust}` : item.uri} style={styles.thumbImage} />
          </View>
          <Text
            allowFontScaling={false}
            style={[
              styles.number,
              { color: active ? colors.chromeText : colors.chromeMuted, fontWeight: active ? '700' : '500' },
            ]}
          >
            {index + 1}
          </Text>
        </Pressable>
      </ScaleDecorator>
    );
  };

  return (
    // The viewer is a native full-screen modal; give the drag gesture its own root.
    <GestureHandlerRootView
      style={[
        styles.container,
        { paddingBottom: Math.max(Spacing.sm, bottomInset - Spacing.md), backgroundColor: colors.chromeRaised },
      ]}
    >
      <DraggableFlatList
        ref={listRef as never}
        data={items}
        keyExtractor={item => item.key}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.content}
        renderItem={renderItem}
        onDragEnd={({ data, from, to }) => {
          if (from === to) {
            onPageMenu?.(from);
            return;
          }
          setItems(data);
          onReorder?.(from, to);
        }}
        ListFooterComponent={
          <Pressable
            style={({ pressed }) => [styles.cell, (pressed || adding) && { opacity: 0.5 }]}
            onPress={onAddPress}
            disabled={adding}
            accessibilityRole="button"
            accessibilityLabel="Add pages"
            accessibilityState={{ disabled: !!adding, busy: !!adding }}
          >
            <View style={[styles.addBtn, { borderColor: colors.chromeMuted }]}>
              <Ionicons name="add" size={24} color={colors.chromeText} />
            </View>
            <Text allowFontScaling={false} style={[styles.number, { color: colors.chromeMuted, fontWeight: '500' }]}>
              Add
            </Text>
          </Pressable>
        }
      />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 0,
    paddingTop: Spacing.md,
  },
  content: {
    paddingHorizontal: Spacing.md,
  },
  cell: {
    width: ITEM_STRIDE,
    alignItems: 'center',
  },
  thumb: {
    width: THUMB_W,
    height: THUMB_H,
    borderRadius: Radius.sm - 2,
    overflow: 'hidden',
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  number: {
    marginTop: Spacing.xs,
    fontSize: 11,
    lineHeight: 13,
    fontVariant: ['tabular-nums'],
  },
  addBtn: {
    width: THUMB_W,
    height: THUMB_H,
    borderRadius: Radius.sm - 2,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
