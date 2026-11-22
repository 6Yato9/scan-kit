// components/more-options.tsx
// Progressive disclosure for the stamp tools (round 16): the common choices
// stay on the screen, the rest sit behind one "More options" row that opens
// them in place. The row says how many of the hidden options differ from the
// default ("2 changed") while closed, so nothing changes the stamp unseen.
import { type ReactNode } from 'react';
import { LayoutAnimation, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@/contexts/theme-context';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

export function MoreOptions({
  open,
  onToggle,
  changed = 0,
  children,
}: {
  open: boolean;
  onToggle: (open: boolean) => void;
  /** How many hidden options are not at their default (shown while closed). */
  changed?: number;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View>
      <Pressable
        onPress={() => {
          LayoutAnimation.configureNext(LayoutAnimation.create(200, 'easeInEaseOut', 'opacity'));
          onToggle(!open);
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? 'Fewer options' : 'More options'}
        accessibilityHint={!open && changed > 0 ? `${changed} changed` : undefined}
        style={({ pressed }) => [styles.row, { backgroundColor: colors.card }, pressed && styles.pressed]}
      >
        <Ionicons name="options-outline" size={20} color={colors.accent} />
        <Text style={[Type.body, styles.title, { color: colors.text }]} numberOfLines={1} maxFontSizeMultiplier={1.5}>
          {open ? 'Fewer options' : 'More options'}
        </Text>
        {!open && changed > 0 ? (
          <Text style={[Type.footnote, { color: colors.muted }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
            {`${changed} changed`}
          </Text>
        ) : null}
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.muted} />
      </Pressable>
      {open ? <View>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginTop: Spacing.xxl,
    paddingHorizontal: Spacing.lg,
    minHeight: HIT + 8,
    borderRadius: Radius.md,
  },
  title: { flex: 1 },
  pressed: { opacity: 0.6 },
});
