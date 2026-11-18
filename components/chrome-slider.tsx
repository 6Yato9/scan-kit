// components/chrome-slider.tsx
// A centred (-100…+100) slider for the always-dark viewer chrome. Same
// behaviour as SimpleSlider, but drawn with the `chrome*` colours so it reads
// on the viewer's dark edit panel in both app themes.
import { useRef } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/contexts/theme-context';
import { Spacing, Type } from '@/lib/theme';

type Props = {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onValueChange: (v: number) => void;
  /** Fires when the finger lifts, so the caller can commit the value. */
  onSlidingComplete?: () => void;
};

const THUMB = 24;
const TOUCH_HEIGHT = 44;

export function ChromeSlider({ label, value, min = -100, max = 100, onValueChange, onSlidingComplete }: Props) {
  const { colors } = useTheme();
  const state = useRef({ x: 0, width: 1, measured: false, min, max, onChange: onValueChange, onDone: onSlidingComplete });
  state.current.min = min;
  state.current.max = max;
  state.current.onChange = onValueChange;
  state.current.onDone = onSlidingComplete;
  const trackRef = useRef<View>(null);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // Keep the gesture once started, so a vertical wobble can't hand it to a parent.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (_, gs) => {
        trackRef.current?.measure((_x, _y, w, _h, pageX) => {
          state.current.x = pageX;
          state.current.width = Math.max(1, w);
          state.current.measured = true;
          const { min: mn, max: mx, onChange } = state.current;
          const pct = Math.max(0, Math.min(1, (gs.x0 - pageX) / state.current.width));
          onChange(Math.round(mn + pct * (mx - mn)));
        });
      },
      onPanResponderMove: (_, gs) => {
        if (!state.current.measured || gs.numberActiveTouches > 1) return;
        const { x, width, min: mn, max: mx, onChange } = state.current;
        const pct = Math.max(0, Math.min(1, (gs.moveX - x) / width));
        onChange(Math.round(mn + pct * (mx - mn)));
      },
      onPanResponderRelease: () => {
        state.current.measured = false;
        state.current.onDone?.();
      },
      onPanResponderTerminate: () => {
        state.current.measured = false;
        state.current.onDone?.();
      },
    }),
  ).current;

  const pct = (value - min) / (max - min);
  const centre = Math.max(0, Math.min(1, (0 - min) / (max - min)));
  const shown = value > 0 ? `+${value}` : String(value);

  return (
    <View style={styles.container}>
      <Text style={[Type.footnote, styles.label, { color: colors.chromeText }]} numberOfLines={1}>{label}</Text>
      <View
        ref={trackRef}
        style={styles.touch}
        {...pan.panHandlers}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ min, max, now: value }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={e => {
          const step = 10;
          if (e.nativeEvent.actionName === 'increment') onValueChange(Math.min(max, value + step));
          if (e.nativeEvent.actionName === 'decrement') onValueChange(Math.max(min, value - step));
          onSlidingComplete?.();
        }}
      >
        <View style={[styles.track, { backgroundColor: colors.chromeBorder }]} />
        <View style={[styles.tick, { backgroundColor: colors.chromeMuted }]} />
        <View
          style={[
            styles.fill,
            {
              left: `${Math.min(pct, centre) * 100}%`,
              width: `${Math.abs(pct - centre) * 100}%`,
              backgroundColor: colors.chromeAccent,
            },
          ]}
        />
        <View
          style={[
            styles.thumb,
            { left: `${pct * 100}%`, marginLeft: -THUMB / 2, backgroundColor: colors.chromeText },
          ]}
        />
      </View>
      <Text style={[Type.footnote, styles.value, { color: value === 0 ? colors.chromeMuted : colors.chromeAccent }]}>
        {shown}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // One row: label, track, value. Three of these fit where one tall slider used to.
  container: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  label: { width: 84, fontWeight: '500' },
  value: { width: 40, fontWeight: '600', textAlign: 'right', fontVariant: ['tabular-nums'] },
  touch: { flex: 1, height: TOUCH_HEIGHT, justifyContent: 'center' },
  track: { position: 'absolute', left: 0, right: 0, height: 4, borderRadius: 2 },
  tick: { position: 'absolute', left: '50%', width: 1, height: 12, marginTop: -4, opacity: 0.6 },
  fill: { position: 'absolute', height: 4, borderRadius: 2 },
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
});
