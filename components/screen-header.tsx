// components/screen-header.tsx
// The one header used by every screen that hides the native navigation bar.
//
// Layout: [left slot | title | right slot]. The two side slots are flex:1 and
// equal, so the title is centred on the screen no matter what each side holds.
// The title truncates rather than colliding with the side actions.
import { ReactNode, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@/contexts/theme-context';
import { HIT, Spacing, Type } from '@/lib/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

// The bar is a fixed 52 pt row, like UIKit's navigation bar, so its text is
// capped the way UIKit caps it: uncapped, the largest text sizes made the
// title and text buttons taller than the bar (clipped).
const HEADER_TITLE_MAX_SCALE = 1.3;
const HEADER_BUTTON_MAX_SCALE = 1.4;

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
  maxFontSizeMultiplier = HEADER_BUTTON_MAX_SCALE,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  color?: string;
  emphasis?: boolean;
  /** Caps how far the label grows with Dynamic Type (like a UIKit bar button). */
  maxFontSizeMultiplier?: number;
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
      <Text
        style={[Type.body, { color: color ?? colors.accent, fontWeight: emphasis ? '600' : '400' }]}
        maxFontSizeMultiplier={maxFontSizeMultiplier}
        // Android: one line. The header makes room for the whole label there (below).
        numberOfLines={Platform.OS === 'android' ? 1 : undefined}
      >
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
  fillLeft = false,
  backDisabled = false,
  maxTitleScale = HEADER_TITLE_MAX_SCALE,
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
  /**
   * Give the left slot all the room the right slot doesn't need (no centred
   * title). For a left-aligned document title next to a few actions (viewer).
   */
  fillLeft?: boolean;
  /** Show the back/close button dimmed and inert (e.g. while a change is being written). */
  backDisabled?: boolean;
  /** Caps how far the title grows with Dynamic Type (like a UIKit navigation bar). */
  maxTitleScale?: number;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const fg = dark ? colors.chromeText : colors.text;
  // Android: Roboto sets a label wider than SF does, and a side slot fixed at
  // a share of the bar wrapped "Add 1 page" onto two lines. There each side
  // is as wide as the wider side's content (measured), so the title stays
  // centred and is what gives way (it truncates). iOS keeps the equal
  // flex slots.
  const fitSides = Platform.OS === 'android' && !fillLeft;
  const [sideW, setSideW] = useState({ left: 0, right: 0 });
  const sideMin = Math.max(sideW.left, sideW.right);
  const measure = (side: 'left' | 'right') => (e: { nativeEvent: { layout: { width: number } } }) => {
    const w = Math.ceil(e.nativeEvent.layout.width);
    setSideW(prev => (prev[side] === w ? prev : { ...prev, [side]: w }));
  };

  const leftContent =
    left ??
    (onBack ? (
      <HeaderIconButton
        icon={backIcon === 'close' ? 'close' : 'chevron-back'}
        size={backIcon === 'close' ? 26 : 28}
        onPress={onBack}
        label={backIcon === 'close' ? 'Close' : backLabel}
        color={fg}
        disabled={backDisabled}
      />
    ) : null);

  return (
    <View style={[styles.bar, { paddingTop: withInset ? insets.top : 0 }, dark && { backgroundColor: colors.chrome }]}>
      <View style={styles.row}>
        <View style={[styles.side, styles.sideLeft, fitSides && [styles.sideFitContent, { minWidth: sideMin }]]}>
          {fitSides ? <View style={styles.sideContent} onLayout={measure('left')}>{leftContent}</View> : leftContent}
        </View>
        {title ? (
          <Text
            style={[Type.headline, styles.title, fitSides && styles.titleFill, { color: fg }]}
            numberOfLines={1}
            accessibilityRole="header"
            maxFontSizeMultiplier={maxTitleScale}
          >
            {title}
          </Text>
        ) : (
          <View style={fitSides ? styles.titleFill : undefined} />
        )}
        <View style={[styles.side, styles.sideRight, fillLeft && styles.sideFit, fitSides && [styles.sideFitContent, { minWidth: sideMin }]]}>
          {fitSides ? <View style={styles.sideContent} onLayout={measure('right')}>{right}</View> : right}
        </View>
      </View>
    </View>
  );
}

/**
 * The large title at the top of each tab (Home, Files, Tools, Settings). One
 * component so the title has the same size, weight and position on every tab
 * — switching tabs never makes it jump. The row is a fixed height whether or
 * not `right` holds header buttons. Place it directly under the top safe-area
 * inset, outside any horizontal padding (it applies its own).
 */
export function LargeTitle({ title, right }: { title: string; right?: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={styles.largeBar}>
      <Text
        style={[Type.largeTitle, styles.largeTitle, { color: colors.text }]}
        accessibilityRole="header"
        numberOfLines={1}
        maxFontSizeMultiplier={1.3}
      >
        {title}
      </Text>
      {right ? <View style={styles.largeRight}>{right}</View> : null}
    </View>
  );
}

/** Total height LargeTitle occupies below the safe-area inset. */
export const LARGE_TITLE_HEIGHT = Spacing.sm + 52;

const styles = StyleSheet.create({
  bar: {},
  largeBar: {
    height: LARGE_TITLE_HEIGHT,
    paddingTop: Spacing.sm,
    paddingLeft: Spacing.xl,
    paddingRight: Spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  largeTitle: { flexShrink: 1 },
  largeRight: { flexDirection: 'row', alignItems: 'center', marginLeft: Spacing.sm },
  row: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.sm,
  },
  side: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  sideLeft: { justifyContent: 'flex-start' },
  sideRight: { justifyContent: 'flex-end' },
  sideFit: { flex: 0 },
  // Android (fitSides): content-wide sides that never shrink; the title takes the rest.
  // (`flex: 0`, not just flexBasis 'auto': Yoga reads a positive `flex` as a zero basis.)
  sideFitContent: { flex: 0, flexGrow: 0, flexShrink: 0 },
  sideContent: { flexDirection: 'row', alignItems: 'center' },
  title: { flexShrink: 1, textAlign: 'center', maxWidth: '60%' },
  titleFill: { flex: 1, maxWidth: undefined },
  iconBtn: { minWidth: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  textBtn: { minHeight: HIT, paddingHorizontal: Spacing.sm, justifyContent: 'center' },
});
