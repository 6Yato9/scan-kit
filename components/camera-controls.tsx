// components/camera-controls.tsx
// The pieces of Scan Kit's camera screen (app/camera.tsx) that are drawn in
// React Native over the native preview: the shutter with its auto-capture
// progress ring, the stack of captured pages, the pill toggles of the top bar
// and the full-preview messages (camera access, no camera). Always-dark
// chrome: `colors.chrome*` whatever the app theme.
import { type ComponentProps, type ReactNode } from 'react';
import { Animated, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

// ── Progress ring ───────────────────────────────────────────────────────────

/**
 * A ring that fills clockwise from the top as `progress` (0..1) rises. Drawn
 * from two half-rings, each clipped to one side of the circle and turned with
 * the native driver, so it costs no JS frames.
 *
 * A circle whose top and right borders are coloured shows the arc from 10:30
 * to 4:30; turned 45° it is exactly the right half (12 → 6). Its mirror
 * (bottom and left borders) turned 45° is the left half (6 → 12).
 *  - The right clip holds the LEFT half turned by min(θ, 180°): it sweeps into
 *    view from 12 o'clock, showing 0..θ.
 *  - The left clip holds the RIGHT half turned by max(θ − 180°, 0): it shows
 *    180°..θ once the first half is full.
 */
export function ProgressRing({
  size,
  thickness,
  progress,
  color,
}: {
  size: number;
  thickness: number;
  progress: Animated.Value | Animated.AnimatedInterpolation<number>;
  color: string;
}) {
  const half = size / 2;
  const first = progress.interpolate({ inputRange: [0, 0.5, 1], outputRange: ['45deg', '225deg', '225deg'], extrapolate: 'clamp' });
  const second = progress.interpolate({ inputRange: [0, 0.5, 1], outputRange: ['45deg', '45deg', '225deg'], extrapolate: 'clamp' });
  const arc = { width: size, height: size, borderRadius: half, borderWidth: thickness, borderColor: 'transparent' };
  return (
    <View pointerEvents="none" style={{ position: 'absolute', width: size, height: size }}>
      <View style={[styles.clip, { left: half, width: half, height: size }]}>
        <Animated.View
          style={[
            arc,
            { position: 'absolute', left: -half, borderBottomColor: color, borderLeftColor: color, transform: [{ rotate: first }] },
          ]}
        />
      </View>
      <View style={[styles.clip, { left: 0, width: half, height: size }]}>
        <Animated.View
          style={[
            arc,
            { position: 'absolute', left: 0, borderTopColor: color, borderRightColor: color, transform: [{ rotate: second }] },
          ]}
        />
      </View>
    </View>
  );
}

// ── Shutter ─────────────────────────────────────────────────────────────────

export const SHUTTER_SIZE = 78;
const RING = 4;
const DISC = SHUTTER_SIZE - 2 * RING - 8;

/** The big round shutter. With `ring`, a progress arc shows how close auto-capture is. */
export function ShutterButton({
  onPress,
  disabled,
  busy,
  progress,
  ring,
}: {
  onPress: () => void;
  disabled?: boolean;
  /** A photo is being taken: the disc dims. */
  busy?: boolean;
  progress: Animated.Value;
  /** Draw the auto-capture progress (only while auto-capture is on). */
  ring: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel="Take photo"
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      style={({ pressed }) => [
        styles.shutter,
        { borderColor: colors.chromeText, opacity: disabled ? 0.4 : 1 },
        pressed && { transform: [{ scale: 0.94 }] },
      ]}
    >
      {ring && <View style={{ position: 'absolute', left: -RING, top: -RING }}><ProgressRing size={SHUTTER_SIZE} thickness={RING} progress={progress} color={colors.chromeAccent} /></View>}
      <View style={[styles.disc, { backgroundColor: colors.chromeText, opacity: busy ? 0.55 : 1 }]} />
    </Pressable>
  );
}

// ── Captured pages ──────────────────────────────────────────────────────────

export const STACK_W = 48;
export const STACK_H = 64;

/** The captured pages, as a small stack with a count; opens the review. */
export function CaptureStack({
  uri,
  count,
  onPress,
  disabled,
}: {
  /** The latest page (its preview, or the photo while the preview renders). */
  uri: string | null;
  count: number;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  if (!count || !uri) return <View style={styles.stackHit} />;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={count === 1 ? 'Review 1 page' : `Review ${count} pages`}
      style={({ pressed }) => [styles.stackHit, pressed && { opacity: 0.6 }]}
    >
      {count > 1 && (
        <View
          style={[
            styles.stackCard,
            { backgroundColor: colors.chromeRaised, borderColor: colors.chromeMuted, transform: [{ translateX: 4 }, { translateY: -4 }] },
          ]}
        />
      )}
      <View style={[styles.stackCard, { backgroundColor: colors.chromeRaised, borderColor: colors.chromeText }]}>
        <Image source={{ uri }} style={styles.stackImage} resizeMode="cover" />
      </View>
      <View style={[styles.badge, { backgroundColor: colors.accentFill, borderColor: colors.chrome }]}>
        <Text style={[styles.badgeText, { color: colors.onAccent }]} allowFontScaling={false}>
          {count}
        </Text>
      </View>
    </Pressable>
  );
}

// ── Top bar pill ────────────────────────────────────────────────────────────

/** A compact labelled toggle for the camera's top bar (Flash, Auto capture). */
export function ChromePill({
  icon,
  label,
  active,
  onPress,
  accessibilityLabel,
  disabled,
}: {
  icon: IconName;
  label: string;
  /** Tinted: the option is on. */
  active?: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const fg = active ? colors.chromeAccent : colors.chromeText;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        styles.pill,
        { backgroundColor: colors.chromeRaised, borderColor: colors.chromeBorder },
        (pressed || disabled) && { opacity: disabled ? 0.4 : 0.6 },
      ]}
    >
      <Ionicons name={icon} size={18} color={fg} />
      <Text style={[Type.footnote, styles.pillText, { color: fg }]} numberOfLines={1} maxFontSizeMultiplier={1.2}>
        {label}
      </Text>
    </Pressable>
  );
}

// ── Messages in place of the preview ────────────────────────────────────────

export function CameraMessage({
  icon,
  title,
  text,
  action,
}: {
  icon: IconName;
  title: string;
  text: string;
  action?: { title: string; icon?: IconName; onPress: () => void };
}): ReactNode {
  const { colors } = useTheme();
  return (
    <View style={styles.message} accessibilityLiveRegion="polite">
      <View style={[styles.messageIcon, { backgroundColor: colors.chrome, borderColor: colors.chromeBorder }]}>
        <Ionicons name={icon} size={34} color={colors.chromeText} />
      </View>
      <Text style={[Type.headline, styles.messageTitle, { color: colors.chromeText }]} accessibilityRole="header">
        {title}
      </Text>
      <Text style={[Type.callout, styles.messageText, { color: colors.chromeMuted }]}>{text}</Text>
      {action && (
        <View style={styles.messageAction}>
          <PrimaryButton title={action.title} icon={action.icon} onPress={action.onPress} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { position: 'absolute', top: 0, overflow: 'hidden' },
  shutter: {
    width: SHUTTER_SIZE,
    height: SHUTTER_SIZE,
    borderRadius: SHUTTER_SIZE / 2,
    borderWidth: RING,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disc: { width: DISC, height: DISC, borderRadius: DISC / 2 },
  stackHit: { width: STACK_W + 20, height: STACK_H + 16, alignItems: 'center', justifyContent: 'center' },
  stackCard: {
    position: 'absolute',
    width: STACK_W,
    height: STACK_H,
    borderRadius: Radius.sm - 2,
    borderWidth: 1.5,
    overflow: 'hidden',
  },
  stackImage: { width: '100%', height: '100%' },
  badge: {
    position: 'absolute',
    top: 0,
    right: 2,
    minWidth: 24,
    height: 24,
    paddingHorizontal: 6,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  pill: {
    height: 36,
    minWidth: HIT,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pillText: { fontWeight: '600' },
  message: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.xxl },
  messageIcon: { width: 72, height: 72, borderRadius: 36, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.lg },
  messageTitle: { textAlign: 'center', marginBottom: Spacing.sm },
  messageText: { textAlign: 'center', lineHeight: 21 },
  messageAction: { alignSelf: 'stretch', marginTop: Spacing.xl },
});
