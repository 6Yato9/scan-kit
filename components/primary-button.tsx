// components/primary-button.tsx
// Standard full-width buttons. Keep them mounted and use `disabled` instead of
// conditionally rendering them, so layouts don't jump as state changes.
import { ActivityIndicator, Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@/contexts/theme-context';
import { Radius, Spacing, Type } from '@/lib/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

export function PrimaryButton({
  title,
  onPress,
  disabled,
  loading,
  icon,
  variant = 'primary',
  style,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  icon?: IconName;
  /**
   * primary: filled accent. secondary: tinted fill with accent text (visible on
   * both the screen background and cards). destructive: red text on a red tint.
   */
  variant?: 'primary' | 'secondary' | 'destructive';
  style?: ViewStyle;
}) {
  const { colors } = useTheme();
  // Disabled (not loading) is its own designed state — a neutral grey fill with
  // faint text, readable in both modes — rather than the live colours faded.
  const off = !!disabled && !loading;
  const bg = off
    ? colors.input
    : variant === 'primary' ? colors.accentFill : variant === 'destructive' ? colors.dangerBg : colors.tintFill;
  const fg = off
    ? colors.faint
    : variant === 'primary' ? colors.onAccent : variant === 'destructive' ? colors.danger : colors.onTint;
  const inactive = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: bg },
        pressed && styles.pressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={styles.content}>
          {icon && <Ionicons name={icon} size={20} color={fg} />}
          {/* Two lines before it truncates: two buttons side by side ("Save as a
              copy" | "Add timestamp") were cut off at large text sizes. */}
          <Text style={[Type.headline, styles.label, { color: fg }]} numberOfLines={2} maxFontSizeMultiplier={BUTTON_TEXT_MAX_SCALE}>
            {title}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

/**
 * How far the label grows with Dynamic Type. Uncapped, the largest
 * accessibility sizes made the label taller than the button; capped (like
 * UIKit's own filled buttons) it stays legible and the button grows to fit.
 */
const BUTTON_TEXT_MAX_SCALE = 1.6;

const styles = StyleSheet.create({
  btn: {
    minHeight: 50,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.lg,
  },
  content: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, maxWidth: '100%' },
  label: { flexShrink: 1, textAlign: 'center' },
  pressed: { opacity: 0.8 },
});
