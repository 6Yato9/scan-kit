// components/viewer-toolbar.tsx
// The viewer's always-visible edit toolbar: Crop · Filters · Rotate · Mark up ·
// Text (an imported PDF's: Fill & sign · Rotate · Blank page · Reorder · Split ·
// Delete), and a pinned Tools button at the end. Each button opens its tool
// directly, so fixing a page never means hunting behind "…". Always-dark
// chrome, like the rest of the viewer.
//
// The row scrolls sideways when its items don't fit at a comfortable width
// (more actions, a narrow phone, larger text): items never shrink below
// MIN_ITEM (scaled with Dynamic Type), and the row is sized so the item at the
// edge is cut part-way through — the hint that it scrolls (lib/toolbar-layout).
// While they fit, items share the width as before. The pinned button (Tools)
// stays put outside the scrolling part, behind a hairline, so it is always one
// tap away however far the row is scrolled; while more items wait to its left,
// the row fades out into it rather than ending in a hard cut.
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useTheme } from '@/contexts/theme-context';
import { AppIcon, type AppIconName } from '@/components/app-icon';
import { HIT, Spacing, Type } from '@/lib/theme';
import { toolbarLayout } from '@/lib/toolbar-layout';

/** Narrowest an item gets at the default text size: a 44pt target plus room for "Blank page". */
const MIN_ITEM = 64;
/** Labels grow with Dynamic Type up to this (and items widen with them). */
const LABEL_MAX_SCALE = 1.3;
/** The fade at the row's scrolling end: thin opaque-ramping slices (no gradient library in the app). */
const FADE_STEPS = [0.08, 0.18, 0.3, 0.42, 0.55, 0.67, 0.78, 0.88];
const FADE_STEP_W = 2.5;

export type ToolbarItem = {
  key: string;
  /** An Ionicon, or one of the app's SF Symbol glyphs (components/app-icon). */
  icon: AppIconName;
  label: string;
  /** VoiceOver label when it should say more than the visible label. */
  a11y?: string;
  hint?: string;
  onPress: () => void;
  /** Optional secondary action on touch-and-hold (also offered to VoiceOver). */
  onLongPress?: () => void;
  longPressLabel?: string;
  busy?: boolean;
  disabled?: boolean;
};

export function ViewerToolbar({ items, pinned }: { items: ToolbarItem[]; pinned?: ToolbarItem }) {
  const { colors } = useTheme();
  const window = useWindowDimensions();
  // The bar spans the screen; measured once laid out (split view, rotation).
  const [barWidth, setBarWidth] = useState(window.width);
  // More items past the trailing edge (the fade shows); false once scrolled to the end.
  const [moreAfter, setMoreAfter] = useState(true);
  const minItem = Math.round(MIN_ITEM * Math.min(Math.max(window.fontScale, 1), LABEL_MAX_SCALE));
  const pinnedWidth = pinned && items.length > 0 ? minItem : 0;
  const scrollWidth = barWidth - pinnedWidth - (pinnedWidth ? StyleSheet.hairlineWidth : 0);
  const { itemWidth, scrolls } = toolbarLayout(scrollWidth - Spacing.xs * 2, items.length, minItem);
  // No other items (a build that can't edit PDF pages): the pinned one is just an item.
  const rowItems = pinned && items.length === 0 ? [pinned] : items;

  return (
    <View
      style={[styles.bar, { backgroundColor: colors.chromeRaised, borderBottomColor: colors.chromeBorder }]}
      onLayout={e => {
        const w = Math.round(e.nativeEvent.layout.width);
        if (w > 0 && w !== barWidth) setBarWidth(w);
      }}
    >
      <ScrollView
        horizontal
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        scrollEnabled={scrolls}
        showsHorizontalScrollIndicator={false}
        // Rests on item edges, so the cut-off item stays at the edge as a hint.
        snapToInterval={scrolls ? itemWidth : undefined}
        decelerationRate={scrolls ? 'fast' : 'normal'}
        bounces={scrolls}
        scrollEventThrottle={32}
        onScroll={e => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          const next = contentOffset.x + layoutMeasurement.width < contentSize.width - 2;
          if (next !== moreAfter) setMoreAfter(next);
        }}
      >
        {rowItems.map(item => (
          <ToolbarButton key={item.key} item={item} width={itemWidth} />
        ))}
      </ScrollView>
      {scrolls && moreAfter ? (
        <View
          style={[styles.fade, { right: pinnedWidth ? pinnedWidth + StyleSheet.hairlineWidth : 0 }]}
          pointerEvents="none"
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
        >
          {FADE_STEPS.map(o => (
            <View key={o} style={{ width: FADE_STEP_W, backgroundColor: colors.chromeRaised, opacity: o }} />
          ))}
        </View>
      ) : null}
      {pinned && items.length > 0 ? (
        <>
          <View style={[styles.divider, { backgroundColor: colors.chromeBorder }]} />
          <ToolbarButton item={pinned} width={pinnedWidth} />
        </>
      ) : null}
    </View>
  );
}

function ToolbarButton({ item, width }: { item: ToolbarItem; width: number }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={item.onPress}
      onLongPress={item.onLongPress}
      disabled={item.disabled || item.busy}
      style={({ pressed }) => [styles.item, { width }, (pressed || item.disabled) && { opacity: item.disabled ? 0.35 : 0.55 }]}
      accessibilityRole="button"
      accessibilityLabel={item.a11y ?? item.label}
      accessibilityHint={item.hint}
      accessibilityState={{ disabled: !!item.disabled, busy: !!item.busy }}
      accessibilityActions={item.onLongPress ? [{ name: 'longpress', label: item.longPressLabel }] : undefined}
      onAccessibilityAction={e => { if (e.nativeEvent.actionName === 'longpress') item.onLongPress?.(); }}
    >
      <View style={styles.iconBox}>
        {item.busy ? (
          <ActivityIndicator size="small" color={colors.chromeText} />
        ) : (
          <AppIcon name={item.icon} size={24} color={colors.chromeText} />
        )}
      </View>
      <Text
        style={[Type.caption, styles.label, { color: colors.chromeText }]}
        numberOfLines={1}
        // Large text: a long label ("Fill & sign") shrinks a little rather than being cut off.
        adjustsFontSizeToFit
        minimumFontScale={0.75}
        maxFontSizeMultiplier={LABEL_MAX_SCALE}
      >
        {item.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  scroll: { flex: 1 },
  // The bar's side padding lives in the scrolling part, so items scroll out to the screen edge.
  scrollContent: { paddingHorizontal: Spacing.xs },
  item: { alignItems: 'center', justifyContent: 'center', minHeight: HIT + 12, gap: 3, paddingHorizontal: Spacing.xxs },
  iconBox: { height: 26, justifyContent: 'center' },
  label: { fontWeight: '500' },
  fade: { position: 'absolute', top: 0, bottom: 0, flexDirection: 'row' },
  divider: { width: StyleSheet.hairlineWidth, marginVertical: Spacing.sm },
});
