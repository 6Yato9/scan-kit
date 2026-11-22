// components/value-slider.tsx
// A number picked on a card: minus and plus buttons for exact steps, a track
// between them for big moves, and the value itself on the right (Watermark's
// size and strength). Unlike SimpleSlider / ChromeSlider, which edit a change
// around zero (-100…+100, filled from the middle), this is an absolute amount,
// filled from the minimum like an iOS slider.
import { useRef } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@/contexts/theme-context';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

const THUMB = 24;

/** `v` moved by `delta`, rounded to a whole number and kept within min…max. */
export function stepValue(v: number, delta: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(v + delta)));
}

export function ValueSlider({
  label,
  value,
  min,
  max,
  step = 1,
  format,
  onChange,
}: {
  /** Spoken name ("Watermark size"); the visible label is the SectionLabel above. */
  label: string;
  value: number;
  min: number;
  max: number;
  /** What one tap on minus / plus (or one VoiceOver swipe) moves. */
  step?: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const { colors } = useTheme();
  // Everything the gesture closures read, refreshed every render (the
  // responder is created once).
  const live = useRef({ x: 0, width: 1, measured: false, min, max, onChange });
  live.current.min = min;
  live.current.max = max;
  live.current.onChange = onChange;
  const trackRef = useRef<View>(null);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // Keep the drag once started, so a vertical wobble can't hand it to the ScrollView.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (_, gs) => {
        trackRef.current?.measure((_x, _y, w, _h, pageX) => {
          live.current.x = pageX;
          live.current.width = Math.max(1, w);
          live.current.measured = true;
          const { min: mn, max: mx } = live.current;
          const pct = Math.max(0, Math.min(1, (gs.x0 - pageX) / live.current.width));
          live.current.onChange(Math.round(mn + pct * (mx - mn)));
        });
      },
      onPanResponderMove: (_, gs) => {
        if (!live.current.measured || gs.numberActiveTouches > 1) return;
        const { x, width, min: mn, max: mx } = live.current;
        const pct = Math.max(0, Math.min(1, (gs.moveX - x) / width));
        live.current.onChange(Math.round(mn + pct * (mx - mn)));
      },
      onPanResponderRelease: () => {
        live.current.measured = false;
      },
      onPanResponderTerminate: () => {
        live.current.measured = false;
      },
    }),
  ).current;

  const pct = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;
  const shown = format(value);

  const button = (dir: -1 | 1) => {
    const disabled = dir < 0 ? value <= min : value >= max;
    return (
      <Pressable
        onPress={() => onChange(stepValue(value, dir * step, min, max))}
        disabled={disabled}
        hitSlop={4}
        accessibilityRole="button"
        accessibilityLabel={`${dir < 0 ? 'Decrease' : 'Increase'} ${label.toLowerCase()}`}
        accessibilityState={{ disabled }}
        style={({ pressed }) => [styles.button, { backgroundColor: colors.input }, pressed && styles.pressed, disabled && styles.disabled]}
      >
        <Ionicons name={dir < 0 ? 'remove' : 'add'} size={18} color={colors.text} />
      </Pressable>
    );
  };

  return (
    <View style={[styles.card, { backgroundColor: colors.card }]}>
      {button(-1)}
      <View
        ref={trackRef}
        style={styles.touch}
        {...pan.panHandlers}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ text: shown }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={e => {
          if (e.nativeEvent.actionName === 'increment') onChange(stepValue(value, step, min, max));
          if (e.nativeEvent.actionName === 'decrement') onChange(stepValue(value, -step, min, max));
        }}
      >
        <View style={[styles.track, { backgroundColor: colors.input }]} />
        <View style={[styles.fill, { width: `${pct * 100}%`, backgroundColor: colors.accent }]} />
        <View
          style={[
            styles.thumb,
            { left: `${pct * 100}%`, backgroundColor: colors.paper, borderColor: colors.ring, shadowColor: colors.shadow },
          ]}
        />
      </View>
      {button(1)}
      <Text
        style={[Type.subhead, styles.value, { color: colors.text }]}
        numberOfLines={1}
        maxFontSizeMultiplier={1.3}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        {shown}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    minHeight: HIT + 16,
  },
  button: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.35 },
  // Inset by half a thumb on each side so the thumb's centre reaches both ends.
  touch: { flex: 1, height: HIT, justifyContent: 'center', marginHorizontal: THUMB / 2 },
  track: { position: 'absolute', left: -THUMB / 2, right: -THUMB / 2, height: 4, borderRadius: 2 },
  // Ends under the thumb, which covers its last half-thumb.
  fill: { position: 'absolute', left: -THUMB / 2, height: 4, borderRadius: 2 },
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    marginLeft: -THUMB / 2,
    borderRadius: THUMB / 2,
    borderWidth: StyleSheet.hairlineWidth,
    shadowOpacity: 0.18,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  value: { minWidth: 52, textAlign: 'right', fontWeight: '600', fontVariant: ['tabular-nums'] },
});
