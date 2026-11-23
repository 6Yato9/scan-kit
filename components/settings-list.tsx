// components/settings-list.tsx
// Grouped-list building blocks shared by the Settings tab and every settings
// screen, so they all share one inset, radius, row height and accessory style.
import { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@/contexts/theme-context';
import { AppIcon, type AppIconName } from '@/components/app-icon';
import { AppSwitch } from '@/components/app-switch';
import { SectionLabel } from '@/components/section-label';
import { HIT, Radius, Spacing, TextScale, Type } from '@/lib/theme';
import { toolSwatch, type ToolHue } from '@/lib/tool-catalog';

/** Line height of a row's label; the icon rule below is computed from it. */
const LABEL_LINE = 22;

/** Section label, a rounded card of rows, and an optional footnote below. */
export function SettingsGroup({ title, footer, children }: { title?: string; footer?: string; children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View>
      {title ? <SectionLabel>{title}</SectionLabel> : <View style={styles.spacer} />}
      <View style={[styles.group, { backgroundColor: colors.card }]}>{children}</View>
      {footer ? <Text style={[Type.footnote, styles.footer, { color: colors.muted }]}>{footer}</Text> : null}
    </View>
  );
}

type Accessory =
  | { type: 'chevron' }
  | { type: 'check'; selected: boolean }
  | { type: 'switch'; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }
  | { type: 'value'; text: string | null } // null → loading spinner
  | { type: 'none' };

export function SettingsRow({
  icon,
  hue,
  label,
  description,
  accessory = { type: 'none' },
  onPress,
  last,
  accessibilityLabel,
}: {
  icon?: AppIconName;
  /** The icon tile's colour, from the same palette as the Tools tab. The app's accent when left out. */
  hue?: ToolHue;
  label: string;
  description?: string;
  accessory?: Accessory;
  onPress?: () => void;
  last?: boolean;
  accessibilityLabel?: string;
}) {
  const { colors, isDark } = useTheme();
  const swatch = hue ? toolSwatch(hue, isDark) : { fg: colors.accent, bg: colors.accentLight };
  const isSwitch = accessory.type === 'switch';
  const isCheck = accessory.type === 'check';

  const body = (
    <>
      {icon ? (
        <View style={[styles.iconTile, description ? styles.iconTileTop : null, { backgroundColor: swatch.bg }]}>
          <AppIcon name={icon} size={18} color={swatch.fg} />
        </View>
      ) : null}
      <View style={[styles.inner, description ? styles.innerTall : null, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}>
        <View style={styles.text}>
          <Text style={[Type.body, styles.label, { color: colors.text }]} maxFontSizeMultiplier={TextScale.row}>{label}</Text>
          {description ? (
            <Text style={[Type.footnote, styles.desc, { color: colors.muted }]} maxFontSizeMultiplier={TextScale.row}>{description}</Text>
          ) : null}
        </View>
        {accessory.type === 'chevron' && <Ionicons name="chevron-forward" size={18} color={colors.muted} />}
        {isCheck && accessory.selected && <Ionicons name="checkmark" size={22} color={colors.accent} />}
        {accessory.type === 'value' &&
          (accessory.text === null ? (
            <ActivityIndicator size="small" color={colors.muted} accessibilityLabel="Calculating" />
          ) : (
            <Text style={[Type.body, styles.value, !onPress && styles.valueAlone, { color: colors.muted }]} numberOfLines={1} maxFontSizeMultiplier={TextScale.row}>{accessory.text}</Text>
          ))}
        {accessory.type === 'value' && onPress && <Ionicons name="chevron-forward" size={18} color={colors.muted} />}
        {isSwitch && (
          <AppSwitch
            value={accessory.value}
            onValueChange={accessory.onChange}
            disabled={accessory.disabled}
            accessibilityLabel={label}
          />
        )}
      </View>
    </>
  );

  if (!onPress || isSwitch) {
    return (
      <View
        style={[styles.row, description ? styles.rowTop : null]}
        accessible={!isSwitch}
        accessibilityLabel={accessibilityLabel ?? (accessory.type === 'value' ? `${label}, ${accessory.text ?? 'calculating'}` : description ? `${label}. ${description}` : label)}
      >
        {body}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={isCheck ? 'radio' : 'button'}
      accessibilityState={isCheck ? { selected: accessory.selected, checked: accessory.selected } : undefined}
      accessibilityLabel={accessibilityLabel ?? (description ? `${label}, ${description}` : label)}
      style={({ pressed }) => [styles.row, description ? styles.rowTop : null, pressed && { backgroundColor: colors.separator }]}
    >
      {body}
    </Pressable>
  );
}

/** The app's one segmented control, re-exported for settings screens. */
export { SegmentedControl } from '@/components/segmented-control';

/** Vertical padding of a row with a description (a two-line row needs more air). */
const TALL_PAD = Spacing.md;

/** Top offset that centres the 30pt icon tile on a row's first (label) line. */
export const ICON_TOP = TALL_PAD + Math.round((LABEL_LINE - 30) / 2);

const styles = StyleSheet.create({
  spacer: { height: Spacing.xxl },
  group: { borderRadius: Radius.md, overflow: 'hidden' },
  footer: { marginTop: Spacing.sm, marginHorizontal: Spacing.xs, lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'center', paddingLeft: Spacing.lg },
  iconTile: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginRight: Spacing.md },
  // One rule for every row: the icon is centred on the label's line. A
  // one-line row is simply centred; a row with a description keeps its icon
  // beside the label instead of floating in the middle of the paragraph
  // (inner padding 12 + half the 22pt label line - half the 30pt tile = 8pt
  // clear above the tile, as on a one-line row).
  rowTop: { alignItems: 'flex-start' },
  iconTileTop: { marginTop: ICON_TOP },
  inner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: HIT + 8,
    paddingVertical: Spacing.sm,
    paddingRight: Spacing.lg,
    gap: Spacing.sm,
  },
  innerTall: { paddingVertical: TALL_PAD },
  // A value with no chevron after it ends where the chevrons above and below
  // visibly end (the chevron glyph is inset in its box).
  valueAlone: { marginRight: 4 },
  // The label keeps at least most of the row: a long value gives way first.
  value: { flexShrink: 1, maxWidth: '45%', textAlign: 'right' },
  text: { flex: 1 },
  label: { lineHeight: LABEL_LINE },
  desc: { marginTop: 2, lineHeight: 18 },
});
