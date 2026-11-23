// components/segmented-control.tsx
// The one segmented control in the app (Settings › Appearance, Sign, Watermark,
// Timestamp): a grey `input` track with the chosen segment raised on
// `segmentOn`, like iOS. 44pt tall in total.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@/contexts/theme-context';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  /** `disabled`: shown faint and not choosable (say why next to the control). */
  options: { value: T; label: string; icon?: IconName; disabled?: boolean }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.track, { backgroundColor: colors.input }]} accessibilityRole="radiogroup">
      {options.map(opt => {
        const on = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            disabled={opt.disabled}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, selected: on, disabled: !!opt.disabled }}
            accessibilityLabel={opt.label}
            style={[styles.item, on && [styles.itemOn, { backgroundColor: colors.segmentOn, shadowColor: colors.shadow }], opt.disabled && !on && styles.itemDisabled]}
          >
            {opt.icon ? <Ionicons name={opt.icon} size={16} color={on ? colors.text : colors.muted} /> : null}
            <Text
              style={[Type.subhead, { color: on ? colors.text : colors.muted, fontWeight: on ? '600' : '500' }]}
              numberOfLines={1}
              maxFontSizeMultiplier={1.3}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', borderRadius: Radius.sm + 2, padding: 3 },
  item: {
    flex: 1,
    minHeight: HIT - 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.xs,
  },
  // As a disabled SheetRow (components/bottom-sheet.tsx).
  itemDisabled: { opacity: 0.4 },
  itemOn: {
    shadowOpacity: 0.12,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
});
