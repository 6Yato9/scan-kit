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

const THUMB = 20;

export function SimpleSlider({ label, value, min = -100, max = 100, onValueChange }: Props) {
  const { colors } = useTheme();

  // Mutable ref holds everything panResponder closures need, updated every render.
  const state = useRef({ x: 0, width: 1, min, max, onChange: onValueChange });
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
          state.current.width = w;
          const { min: mn, max: mx, onChange, x, width } = state.current;
          const pct = Math.max(0, Math.min(1, (gs.x0 - x) / width));
          onChange(Math.round(mn + pct * (mx - mn)));
        });
      },
      onPanResponderMove: (_, gs) => {
        const { x, width, min: mn, max: mx, onChange } = state.current;
        const pct = Math.max(0, Math.min(1, (gs.moveX - x) / width));
        onChange(Math.round(mn + pct * (mx - mn)));
      },
    })
  ).current;

  const pct = (value - min) / (max - min);
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
      >
        {/* Track background */}
        <View style={[styles.track, { backgroundColor: colors.border }]} />
        {/* Center tick mark */}
        <View style={[styles.centerTick, { backgroundColor: colors.muted }]} />
        {/* Fill from left to thumb */}
        <View
          style={[
            styles.fill,
            {
              width: `${pct * 100}%` as any,
              backgroundColor: colors.accent,
              opacity: 0.5,
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
            },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginVertical: 6 },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  label: { fontSize: 13, fontWeight: '500' },
  valueText: { fontSize: 13, fontWeight: '600', minWidth: 36, textAlign: 'right' },
  touchArea: {
    height: THUMB,
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
    left: 0,
    height: 4,
    borderRadius: 2,
  },
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
  },
});
