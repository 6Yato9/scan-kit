// components/tool-tile.tsx
// A tool as the Tools tab draws it: its coloured icon on a pale rounded square
// of the same hue, the label underneath (lib/tool-catalog.ts holds the colours).
// The Tools tab, Home's Tools row and the viewer's Tools sheet all use these,
// so a tool is recognisable by its colour wherever it is.
import { Pressable, StyleSheet, Text, View, type DimensionValue } from 'react-native';
import { useTheme } from '@/contexts/theme-context';
import { AppIcon } from '@/components/app-icon';
import { TOOLS, toolSwatch, type ToolId } from '@/lib/tool-catalog';
import { Radius, Spacing } from '@/lib/theme';

/** Tile sizes: the Tools tab and the viewer's sheet use `regular`, Home a step smaller. */
const SIZES = {
  regular: { box: 52, icon: 26, radius: 14 },
  compact: { box: 48, icon: 24, radius: 13 },
} as const;

/** The coloured icon on its tile, without a label (also for rows). */
export function ToolIcon({ id, size = 'regular' }: { id: ToolId; size?: keyof typeof SIZES }) {
  const { isDark } = useTheme();
  const s = SIZES[size];
  const { fg, bg } = toolSwatch(TOOLS[id].hue, isDark);
  return (
    <View style={[styles.iconWrap, { width: s.box, height: s.box, borderRadius: s.radius, backgroundColor: bg }]}>
      <AppIcon name={TOOLS[id].icon} size={s.icon} color={fg} />
    </View>
  );
}

export function ToolTile({
  id,
  onPress,
  label,
  size = 'regular',
  width = '25%',
}: {
  id: ToolId;
  onPress: () => void;
  /** Overrides the catalogue's label (e.g. an imported form's "Fill in"). */
  label?: string;
  size?: keyof typeof SIZES;
  /** Its share of the row: a quarter in a four-across grid, or flex in a single row. */
  width?: DimensionValue | 'flex';
}) {
  const { colors } = useTheme();
  const text = label ?? TOOLS[id].label;
  return (
    <Pressable
      style={({ pressed }) => [styles.tile, width === 'flex' ? styles.flex : { width }, pressed && { opacity: 0.6 }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={text}
    >
      <ToolIcon id={id} size={size} />
      <Text style={[styles.label, { color: colors.text }]} numberOfLines={1} maxFontSizeMultiplier={1.2}>
        {text}
      </Text>
    </Pressable>
  );
}

/**
 * A card of tiles, four across, wrapping and left-aligned (a short last row
 * keeps the grid's columns instead of spreading out).
 */
export function ToolGrid({
  tools,
  onPress,
  labels,
}: {
  tools: ToolId[];
  onPress: (id: ToolId) => void;
  labels?: Partial<Record<ToolId, string>>;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: colors.card }]}>
      {tools.map(id => (
        <ToolTile key={id} id={id} label={labels?.[id]} onPress={() => onPress(id)} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderRadius: Radius.lg,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.xs,
  },
  tile: {
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.xxs,
  },
  flex: { flex: 1 },
  iconWrap: { alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.sm },
  label: { fontSize: 12, lineHeight: 15, textAlign: 'center', fontWeight: '500' },
});
