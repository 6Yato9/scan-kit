// components/create-pdf/page-row.tsx
// One page in Create PDF's list: its position, a thumbnail turned the way the
// page will be, where it came from, and Rotate, Remove and a drag handle.
// Touch and hold the row (or press the handle) to drag it. VoiceOver gets the
// same actions without dragging: Move up, Move down, Rotate, Remove.
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { PageThumb } from '@/components/page-thumb';
import { originLabel, type CreateItem } from '@/lib/create-pdf';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

export const ROW_THUMB = { width: 44, height: 58 };

function thumbOf(item: CreateItem): string | null {
  if (item.kind === 'image') return item.page;
  if (item.kind === 'scan') return item.uri;
  return item.thumb;
}

type Props = {
  item: CreateItem;
  position: number;
  count: number;
  active: boolean;
  disabled: boolean;
  drag: () => void;
  onRotate: () => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
};

export const PageRow = memo(function PageRow({ item, position, count, active, disabled, drag, onRotate, onRemove, onMove }: Props) {
  const { colors } = useTheme();
  const thumb = thumbOf(item);
  const sideways = item.turn === 90 || item.turn === 270;
  const title = item.label;
  const meta = originLabel(item);
  const turned = item.turn ? `, turned ${item.turn} degrees` : '';
  const actions = [
    ...(position > 1 ? [{ name: 'moveUp', label: 'Move up' }] : []),
    ...(position < count ? [{ name: 'moveDown', label: 'Move down' }] : []),
    { name: 'rotate', label: 'Rotate' },
    { name: 'remove', label: 'Remove' },
  ];
  return (
    <Pressable
      onLongPress={disabled ? undefined : drag}
      delayLongPress={200}
      disabled={disabled}
      style={[styles.row, { backgroundColor: active ? colors.separator : colors.card }]}
      accessible
      accessibilityLabel={`Page ${position} of ${count}: ${title}. ${meta}${turned}`}
      accessibilityHint="Touch and hold, then drag to move. Swipe up or down for more actions."
      accessibilityActions={actions}
      onAccessibilityAction={e => {
        switch (e.nativeEvent.actionName) {
          case 'moveUp': onMove(-1); break;
          case 'moveDown': onMove(1); break;
          case 'rotate': onRotate(); break;
          case 'remove': onRemove(); break;
        }
      }}
    >
      <Text style={[Type.footnote, styles.position, { color: colors.muted }]}>{position}</Text>
      <View style={[styles.thumbBox, { backgroundColor: colors.placeholder, borderColor: colors.thumbBorder }]}>
        {thumb ? (
          <PageThumb
            uri={thumb}
            style={[
              sideways ? styles.thumbSideways : styles.thumbFill,
              { transform: [{ rotate: `${item.turn}deg` }] },
            ]}
          />
        ) : (
          <Ionicons name="document-text-outline" size={20} color={colors.muted} />
        )}
      </View>
      <View style={styles.body}>
        <Text style={[Type.body, { color: colors.text }]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[Type.footnote, styles.meta, { color: colors.muted }]} numberOfLines={1}>
          {meta}
        </Text>
      </View>
      <Pressable
        onPress={onRotate}
        disabled={disabled}
        hitSlop={4}
        style={({ pressed }) => [styles.btn, (pressed || disabled) && styles.dim]}
        accessibilityRole="button"
        accessibilityLabel={`Rotate page ${position}`}
      >
        <Ionicons name="refresh-outline" size={22} color={colors.accent} />
      </Pressable>
      <Pressable
        onPress={onRemove}
        disabled={disabled}
        hitSlop={4}
        style={({ pressed }) => [styles.btn, (pressed || disabled) && styles.dim]}
        accessibilityRole="button"
        accessibilityLabel={`Remove page ${position}`}
      >
        <Ionicons name="remove-circle-outline" size={22} color={colors.danger} />
      </Pressable>
      <Pressable
        onPressIn={disabled ? undefined : drag}
        disabled={disabled}
        style={styles.handle}
        accessibilityLabel={`Move page ${position}`}
        importantForAccessibility="no"
        accessibilityElementsHidden
      >
        <Ionicons name="reorder-three-outline" size={26} color={colors.muted} />
      </Pressable>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: Spacing.sm,
    paddingRight: Spacing.xs,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
    marginBottom: Spacing.sm,
  },
  position: { width: 24, textAlign: 'center', fontVariant: ['tabular-nums'] },
  thumbBox: {
    width: ROW_THUMB.width,
    height: ROW_THUMB.height,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: Spacing.xs,
  },
  thumbFill: { width: ROW_THUMB.width, height: ROW_THUMB.height },
  // Turned a quarter, a page lies across the tile: drawn smaller so all of it shows.
  thumbSideways: { width: Math.round((ROW_THUMB.width * ROW_THUMB.width) / ROW_THUMB.height), height: ROW_THUMB.width },
  body: { flex: 1, marginLeft: Spacing.md },
  meta: { marginTop: 2 },
  btn: { width: HIT - 4, height: HIT, alignItems: 'center', justifyContent: 'center' },
  dim: { opacity: 0.4 },
  handle: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
});
