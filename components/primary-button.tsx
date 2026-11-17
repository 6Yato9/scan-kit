// components/primary-button.tsx
// Standard full-width buttons. Keep them mounted and use `disabled` instead of
// conditionally rendering them, so layouts don't jump as state changes.
import { ActivityIndicator, Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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
  /** primary: filled accent. secondary: neutral fill. destructive: red text on neutral. */
  variant?: 'primary' | 'secondary' | 'destructive';
  style?: ViewStyle;
}) {
  const { colors } = useTheme();
  const bg = variant === 'primary' ? colors.accentFill : colors.secondary;
  const fg = variant === 'primary' ? colors.onAccent : variant === 'destructive' ? colors.danger : colors.text;
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
        disabled && !loading && styles.disabled,
        pressed && styles.pressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={styles.content}>
          {icon && <Ionicons name={icon} size={20} color={fg} />}
          <Text style={[Type.headline, { color: fg }]} numberOfLines={1}>
            {title}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    height: 50,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.lg,
  },
  content: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
});
