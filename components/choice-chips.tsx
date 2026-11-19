// components/choice-chips.tsx
// A single choice among a few short words that don't fit a segmented control
// (Timestamp's "Received / Approved / Paid / Custom"): pills that wrap onto a
// second line when the text is large, the chosen one filled with the accent.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/contexts/theme-context';
import { Radius, Spacing, Type } from '@/lib/theme';

export function ChoiceChips<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  accessibilityLabel: string;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.wrap} accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel}>
      {options.map(o => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, selected: on }}
            accessibilityLabel={o.label}
            hitSlop={{ top: 4, bottom: 4 }}
            style={({ pressed }) => [
              styles.chip,
              { backgroundColor: on ? colors.accentFill : colors.card },
              pressed && styles.pressed,
            ]}
          >
            <Text
              style={[Type.subhead, { color: on ? colors.onAccent : colors.text, fontWeight: on ? '600' : '500' }]}
              numberOfLines={1}
              maxFontSizeMultiplier={1.4}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  chip: { borderRadius: Radius.pill, paddingHorizontal: Spacing.lg, minHeight: 36, justifyContent: 'center' },
  pressed: { opacity: 0.6 },
});
