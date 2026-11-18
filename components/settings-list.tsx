// components/settings-list.tsx
// Grouped-list building blocks shared by the Settings tab and every settings
// screen, so they all share one inset, radius, row height and accessory style.
import { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { SectionLabel } from '@/components/section-label';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

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
  label,
  description,
  accessory = { type: 'none' },
  onPress,
  last,
  accessibilityLabel,
}: {
  icon?: IconName;
  label: string;
  description?: string;
  accessory?: Accessory;
  onPress?: () => void;
  last?: boolean;
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme();
  const isSwitch = accessory.type === 'switch';
  const isCheck = accessory.type === 'check';

  const body = (
    <>
      {icon ? (
        <View style={[styles.iconTile, { backgroundColor: colors.accentLight }]}>
          <Ionicons name={icon} size={18} color={colors.accent} />
        </View>
      ) : null}
      <View style={[styles.inner, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}>
        <View style={styles.text}>
          <Text style={[Type.body, { color: colors.text }]}>{label}</Text>
          {description ? (
            <Text style={[Type.footnote, styles.desc, { color: colors.muted }]}>{description}</Text>
          ) : null}
        </View>
        {accessory.type === 'chevron' && <Ionicons name="chevron-forward" size={18} color={colors.muted} />}
        {isCheck && accessory.selected && <Ionicons name="checkmark" size={22} color={colors.accent} />}
        {accessory.type === 'value' &&
          (accessory.text === null ? (
            <ActivityIndicator size="small" color={colors.muted} accessibilityLabel="Calculating" />
          ) : (
            <Text style={[Type.body, { color: colors.muted }]}>{accessory.text}</Text>
          ))}
        {accessory.type === 'value' && onPress && <Ionicons name="chevron-forward" size={18} color={colors.muted} />}
        {isSwitch && (
          <Switch
            value={accessory.value}
            onValueChange={accessory.onChange}
            disabled={accessory.disabled}
            trackColor={{ true: colors.accentFill, false: undefined }}
            accessibilityLabel={label}
          />
        )}
      </View>
    </>
  );

  if (!onPress || isSwitch) {
    return (
      <View
        style={styles.row}
        accessible={!isSwitch}
        accessibilityLabel={accessibilityLabel ?? (accessory.type === 'value' ? `${label}, ${accessory.text ?? 'calculating'}` : label)}
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
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.separator }]}
    >
      {body}
    </Pressable>
  );
}

/** iOS-style segmented control: 44pt tall, selected segment filled. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; icon?: IconName }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.segments, { backgroundColor: colors.card }]} accessibilityRole="radiogroup">
      {options.map(opt => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected, checked: selected }}
            accessibilityLabel={opt.label}
            style={[styles.segment, selected && [styles.segmentSelected, { backgroundColor: colors.accentFill, shadowColor: colors.shadow }]]}
          >
            {opt.icon ? <Ionicons name={opt.icon} size={16} color={selected ? colors.onAccent : colors.muted} /> : null}
            <Text style={[Type.subhead, { color: selected ? colors.onAccent : colors.text, fontWeight: selected ? '600' : '500' }]}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  spacer: { height: Spacing.xxl },
  group: { borderRadius: Radius.md, overflow: 'hidden' },
  footer: { marginTop: Spacing.sm, marginHorizontal: Spacing.xs, lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'center', paddingLeft: Spacing.lg },
  iconTile: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginRight: Spacing.md },
  inner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: HIT + 8,
    paddingVertical: Spacing.sm,
    paddingRight: Spacing.lg,
    gap: Spacing.sm,
  },
  text: { flex: 1 },
  desc: { marginTop: 2, lineHeight: 18 },
  segments: { flexDirection: 'row', borderRadius: Radius.md, padding: 3, gap: 3 },
  segment: {
    flex: 1,
    height: HIT,
    borderRadius: Radius.sm + 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  segmentSelected: {
    shadowOpacity: 0.12,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
});
