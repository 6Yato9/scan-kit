// components/camera-controls.tsx
// The pieces of Scan Kit's camera screen (app/camera.tsx) that are drawn in
// React Native over the native preview: the shutter with its auto-capture
// progress ring, the stack of captured pages, the floating buttons and pill
// toggles of the top row, the status pill and the full-screen messages
// (camera access, no camera). Always-dark chrome: `colors.chrome*` whatever
// the app theme.
//
// The preview fills the screen, so every control floats over the live picture:
// each sits on "glass" (a dark blur material plus a dimming fill and a
// hairline) so it reads over white paper as well as over a dark table.
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Animated, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Reanimated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

// ── Glass ───────────────────────────────────────────────────────────────────

/**
 * The backdrop of a floating control: blur material (iOS), a dimming fill so
 * white text and icons keep their contrast over bright paper, and a hairline
 * that separates it from a dark scene. Fills its parent; the parent sets the
 * shape (borderRadius + overflow hidden).
 */
export function Glass({ radius = Radius.pill }: { radius?: number }) {
  const { colors } = useTheme();
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.glass, { borderRadius: radius, borderColor: colors.chromeGlassBorder }]}>
      {Platform.OS === 'ios' ? <BlurView tint={colors.chromeGlassTint} intensity={60} style={StyleSheet.absoluteFill} /> : null}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: Platform.OS === 'ios' ? colors.chromeGlassFill : colors.chromeScrim }]} />
    </View>
  );
}

export const GLASS_BUTTON = 44;

/** A round floating icon button (close, …) on glass. */
export function GlassIconButton({
  icon,
  onPress,
  accessibilityLabel,
  size = 24,
}: {
  icon: IconName;
  onPress: () => void;
  accessibilityLabel: string;
  size?: number;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.glassButton, pressed && styles.pressed]}
    >
      <Glass />
      <Ionicons name={icon} size={size} color={colors.chromeText} />
    </Pressable>
  );
}

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
/** The shutter with its glass halo. */
export const SHUTTER_HALO = SHUTTER_SIZE + 14;
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
    <View style={styles.shutterHalo}>
      {/* Glass behind the white ring: it stays visible over white paper. */}
      <View style={styles.shutterGlass}>
        <Glass />
      </View>
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
    </View>
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
            styles.stackShadow,
            { shadowColor: colors.shadow, backgroundColor: colors.chromeRaised, borderColor: colors.chromeMuted, transform: [{ translateX: 4 }, { translateY: -4 }] },
          ]}
        />
      )}
      {/* Shadow on its own (a clipped view drops it): lifts the stack off a bright page. */}
      <View style={[styles.stackCard, styles.stackShadow, { shadowColor: colors.shadow, backgroundColor: colors.chromeRaised, borderColor: colors.chromeText }]} />
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

/** A compact labelled toggle floating in the camera's top row (Flash, Auto capture), on glass. */
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
        (pressed || disabled) && { opacity: disabled ? 0.4 : 0.6 },
      ]}
    >
      <Glass />
      <Ionicons name={icon} size={18} color={fg} />
      <Text style={[Type.footnote, styles.pillText, { color: fg }]} numberOfLines={1} maxFontSizeMultiplier={1.2}>
        {label}
      </Text>
    </Pressable>
  );
}

// ── Status pill ─────────────────────────────────────────────────────────────

export type StatusTone = 'normal' | 'done' | 'warning' | 'paused';

const TONE_ICON: Record<StatusTone, IconName | null> = {
  normal: null,
  done: 'checkmark-circle',
  warning: 'alert-circle',
  paused: 'pause-circle',
};

/**
 * `value` held for at least `minMs` before the next one replaces it (the
 * newest wins), so a detection flickering between two states doesn't make the
 * pill flash. `key` says when two values are the same.
 */
export function useSteadyValue<T>(value: T, key: string, minMs: number): T {
  const [shown, setShown] = useState({ key, value });
  const since = useRef(0);
  useEffect(() => {
    if (shown.key === key) return;
    const apply = () => {
      since.current = Date.now();
      setShown({ key, value });
    };
    const wait = since.current + minMs - Date.now();
    if (wait <= 0) {
      apply();
      return;
    }
    const t = setTimeout(apply, wait);
    return () => clearTimeout(t);
  }, [key, value, shown.key, minMs]);
  return shown.key === key ? value : shown.value;
}

/** A status shown at least this long before the next replaces it. */
const STATUS_DWELL_MS = 450;
const PILL_RADIUS = 20;

/**
 * The camera's one floating line of guidance: the mode (Whiteboard, ID card –
 * front, Retake page 2) over what to do now ("Hold still"). A new message
 * cross-fades in and the pill eases to its new width. Nothing is drawn while
 * there is nothing to say.
 */
export function StatusPill({
  title,
  text,
  tone = 'normal',
  maxWidth,
}: {
  title?: string | null;
  text: string;
  tone?: StatusTone;
  maxWidth: number;
}) {
  const { colors } = useTheme();
  const key = `${tone}|${title ?? ''}|${text}`;
  const shown = useSteadyValue({ title: title ?? null, text, tone }, key, STATUS_DWELL_MS);
  if (!shown.title && !shown.text) return null;
  const icon = TONE_ICON[shown.tone];
  const iconColor = shown.tone === 'warning' ? colors.chromeWarning : shown.tone === 'done' ? colors.chromeAccent : colors.chromeText;
  return (
    <Reanimated.View
      layout={LinearTransition.duration(220)}
      style={[styles.statusPill, { maxWidth }]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={[shown.title, shown.text].filter(Boolean).join('. ')}
      accessibilityLiveRegion="polite"
    >
      <Glass radius={PILL_RADIUS} />
      <Reanimated.View
        key={`${shown.tone}|${shown.title ?? ''}|${shown.text}`}
        entering={FadeIn.duration(180)}
        exiting={FadeOut.duration(110)}
        style={styles.statusRow}
      >
        {shown.title ? (
          <Text style={[styles.statusTitle, { color: colors.chromeAccent }]} numberOfLines={1} maxFontSizeMultiplier={1.2}>
            {shown.title}
          </Text>
        ) : null}
        {shown.text ? (
          <View style={styles.statusLine}>
            {icon ? <Ionicons name={icon} size={18} color={iconColor} /> : null}
            <Text
              style={[Type.subhead, styles.statusText, { color: colors.chromeText }]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.85}
              maxFontSizeMultiplier={1.3}
            >
              {shown.text}
            </Text>
          </View>
        ) : null}
      </Reanimated.View>
    </Reanimated.View>
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
  glass: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  pressed: { opacity: 0.6 },
  statusPill: {
    alignSelf: 'center',
    minHeight: 40,
    borderRadius: PILL_RADIUS,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  statusRow: {
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
  },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, flexShrink: 1 },
  statusTitle: { ...Type.sectionLabel, fontSize: 11, lineHeight: 14, textAlign: 'center' },
  statusText: { fontWeight: '600', textAlign: 'center', flexShrink: 1 },
  glassButton: {
    width: GLASS_BUTTON,
    height: GLASS_BUTTON,
    borderRadius: GLASS_BUTTON / 2,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterHalo: { width: SHUTTER_HALO, height: SHUTTER_HALO, alignItems: 'center', justifyContent: 'center' },
  shutterGlass: {
    position: 'absolute',
    width: SHUTTER_HALO,
    height: SHUTTER_HALO,
    borderRadius: SHUTTER_HALO / 2,
    overflow: 'hidden',
  },
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
  stackShadow: {
    overflow: 'visible',
    shadowOpacity: 0.45,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
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
    height: 40,
    minWidth: HIT,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.pill,
    overflow: 'hidden',
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
