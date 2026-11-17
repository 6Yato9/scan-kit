// components/screen-header.tsx
// The one header used by every screen that hides the native navigation bar.
//
// Layout: [left slot | title | right slot]. The two side slots are flex:1 and
// equal, so the title is centred on the screen no matter what each side holds.
// The title truncates rather than colliding with the side actions.
import { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { HIT, Spacing, Type } from '@/lib/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

export function HeaderIconButton({
  icon,
  onPress,
  label,
  color,
  disabled,
  size = 24,
}: {
  icon: IconName;
  onPress: () => void;
  label: string;
  color?: string;
  disabled?: boolean;
  size?: number;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [styles.iconBtn, (pressed || disabled) && { opacity: disabled ? 0.35 : 0.5 }]}
    >
      <Ionicons name={icon} size={size} color={color ?? colors.text} />
    </Pressable>
  );
}

/** A text action for the header ("Done", "Save"). Prefer icons unless the verb is clearer. */
export function HeaderTextButton({
  title,
  onPress,
  disabled,
  color,
  emphasis = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  color?: string;
  emphasis?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      style={({ pressed }) => [styles.textBtn, (pressed || disabled) && { opacity: disabled ? 0.35 : 0.5 }]}
    >
      <Text style={[Type.body, { color: color ?? colors.accent, fontWeight: emphasis ? '600' : '400' }]}>
        {title}
      </Text>
    </Pressable>
  );
}

export function ScreenHeader({
  title,
  onBack,
  backIcon = 'back',
  backLabel = 'Back',
  right,
  left,
  dark = false,
  withInset = true,
}: {
  title?: string;
  /** Renders a back (or close) button in the left slot. */
  onBack?: () => void;
  /** 'back' (chevron) for pushed screens, 'close' (x) for modals. */
  backIcon?: 'back' | 'close';
  backLabel?: string;
  /** Custom left content; overrides onBack. */
  left?: ReactNode;
  right?: ReactNode;
  /** Always-dark chrome (viewer, annotate, crop) regardless of theme. */
  dark?: boolean;
  /** Add the top safe-area inset. Turn off when the parent already pads for it. */
  withInset?: boolean;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const fg = dark ? colors.chromeText : colors.text;

  const leftContent =
    left ??
    (onBack ? (
      <HeaderIconButton
        icon={backIcon === 'close' ? 'close' : 'chevron-back'}
        size={backIcon === 'close' ? 26 : 28}
        onPress={onBack}
        label={backIcon === 'close' ? 'Close' : backLabel}
        color={fg}
      />
    ) : null);

  return (
    <View style={[styles.bar, { paddingTop: withInset ? insets.top : 0 }, dark && { backgroundColor: colors.chrome }]}>
      <View style={styles.row}>
        <View style={[styles.side, styles.sideLeft]}>{leftContent}</View>
        {title ? (
          <Text style={[Type.headline, styles.title, { color: fg }]} numberOfLines={1} accessibilityRole="header">
            {title}
          </Text>
        ) : (
          <View />
        )}
        <View style={[styles.side, styles.sideRight]}>{right}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {},
  row: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.sm,
  },
  side: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  sideLeft: { justifyContent: 'flex-start' },
  sideRight: { justifyContent: 'flex-end' },
  title: { flexShrink: 1, textAlign: 'center', maxWidth: '60%' },
  iconBtn: { minWidth: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  textBtn: { minHeight: HIT, paddingHorizontal: Spacing.sm, justifyContent: 'center' },
});
