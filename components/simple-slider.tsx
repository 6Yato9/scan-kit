// components/simple-slider.tsx
import { useRef } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/contexts/theme-context';

type Props = {
  label: string;
  value: number;   // min to max
  min?: number;
  max?: number;
  onValueChange: (v: number) => void;
};

const THUMB = 22;
// Taller than the thumb so the whole row is an easy 44pt target.
const TOUCH_HEIGHT = 44;

export function SimpleSlider({ label, value, min = -100, max = 100, onValueChange }: Props) {
  const { colors } = useTheme();

  // Mutable ref holds everything panResponder closures need, updated every render.
  // `measured` is false until the first `measure()` callback resolves — the move
  // handler short-circuits before then so we don't compute against the sentinel
  // `width: 1` and emit a huge value on the first frame.
  const state = useRef({ x: 0, width: 1, measured: false, min, max, onChange: onValueChange });
  state.current.min = min;
  state.current.max = max;
  state.current.onChange = onValueChange;

  const trackRef = useRef<View>(null);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (_, gs) => {
        trackRef.current?.measure((_, __, w, ___, pageX) => {
          state.current.x = pageX;
          state.current.width = Math.max(1, w);
          state.current.measured = true;
          const { min: mn, max: mx, onChange } = state.current;
          const pct = Math.max(0, Math.min(1, (gs.x0 - pageX) / state.current.width));
          onChange(Math.round(mn + pct * (mx - mn)));
        });
      },
      onPanResponderMove: (_, gs) => {
        if (!state.current.measured) return;
        // Bail when a second finger is on screen — gs.moveX is averaged across
        // touches and produces jittery values.
        if (gs.numberActiveTouches > 1) return;
        const { x, width, min: mn, max: mx, onChange } = state.current;
        const pct = Math.max(0, Math.min(1, (gs.moveX - x) / width));
        onChange(Math.round(mn + pct * (mx - mn)));
      },
      onPanResponderRelease: () => {
        state.current.measured = false;
      },
      onPanResponderTerminate: () => {
        state.current.measured = false;
      },
    })
  ).current;

  const pct = (value - min) / (max - min);
  const centre = Math.max(0, Math.min(1, (0 - min) / (max - min)));
  const displayVal = value > 0 ? `+${value}` : String(value);

  return (
    <View style={styles.container}>
      <View style={styles.labelRow}>
        <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
        <Text style={[styles.valueText, { color: value === 0 ? colors.muted : colors.accent }]}>
          {displayVal}
        </Text>
      </View>
      <View
        ref={trackRef}
        style={styles.touchArea}
        onLayout={e => { state.current.width = e.nativeEvent.layout.width; }}
        {...panResponder.panHandlers}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ min, max, now: value }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={e => {
          const step = 10;
          if (e.nativeEvent.actionName === 'increment') onValueChange(Math.min(max, value + step));
          if (e.nativeEvent.actionName === 'decrement') onValueChange(Math.max(min, value - step));
        }}
      >
        {/* Track background */}
        <View style={[styles.track, { backgroundColor: colors.border }]} />
        {/* Center tick mark */}
        <View style={[styles.centerTick, { backgroundColor: colors.muted }]} />
        {/* Fill from the centre (no change) to the thumb */}
        <View
          style={[
            styles.fill,
            {
              left: `${Math.min(pct, centre) * 100}%` as any,
              width: `${Math.abs(pct - centre) * 100}%` as any,
              backgroundColor: colors.accent,
            },
          ]}
        />
        {/* Thumb */}
        <View
          style={[
            styles.thumb,
            {
              left: `${pct * 100}%` as any,
              marginLeft: -THUMB / 2,
              backgroundColor: colors.accent,
              borderColor: colors.card,
            },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginVertical: 2 },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 0,
  },
  label: { fontSize: 14, fontWeight: '500' },
  valueText: { fontSize: 13, fontWeight: '600', minWidth: 36, textAlign: 'right' },
  touchArea: {
    height: TOUCH_HEIGHT,
    justifyContent: 'center',
  },
  track: {
    height: 4,
    borderRadius: 2,
    position: 'absolute',
    left: 0,
    right: 0,
  },
  centerTick: {
    position: 'absolute',
    left: '50%' as any,
    width: 1,
    height: 10,
    marginTop: -3,
    opacity: 0.4,
  },
  fill: {
    position: 'absolute',
    height: 4,
    borderRadius: 2,
  },
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    borderWidth: 2,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
});
