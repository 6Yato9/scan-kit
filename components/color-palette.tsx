// components/color-palette.tsx
// The stamp tools' colour picker (round 16): the shared palette
// (lib/stamp-colors.ts) as a grid of round swatches, five to a row, plus a
// Custom swatch that opens two sliders under the grid — Hue and Shade — for
// any other colour. Highlight pickers add a None swatch first.
//
// Ink colours are content, not UI (they are what lands on the page), so the
// swatches show the real colours in both themes; only the ring, the labels
// and the card follow the theme. A light swatch (white, yellow) gets a dark
// check and a visible outline on a light card.
import { useRef } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@/contexts/theme-context';
import {
  CUSTOM_SATURATION,
  DEFAULT_CUSTOM_HEX,
  SHADE_RANGE,
  contrastOn,
  customFromSliders,
  hslToHex,
  slidersFromCustom,
} from '@/lib/stamp-colors';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

const SWATCH = 30;
const PER_ROW = 5;

export type PaletteOption<T extends string> = { value: T; label: string; color: string };

export function ColorPalette<T extends string>({
  options,
  value,
  onChange,
  custom,
  onCustomChange,
  none,
  accessibilityLabel,
}: {
  /** The palette's colours, in order. */
  options: readonly PaletteOption<T>[];
  /** The chosen id: one of the options, 'custom', or 'none'. */
  value: T | 'custom' | 'none';
  onChange: (v: T | 'custom' | 'none') => void;
  /** The custom colour (hex), or null when none has been picked yet. Omit to offer no Custom swatch. */
  custom?: string | null;
  onCustomChange?: (hex: string) => void;
  /** Offer a None swatch first (a highlight that can be switched off). */
  none?: boolean;
  /** Spoken name of the group ("Text color"). */
  accessibilityLabel: string;
}) {
  const { colors } = useTheme();
  const withCustom = !!onCustomChange;
  const customHex = custom ?? DEFAULT_CUSTOM_HEX;
  type Cell = { key: string; value: T | 'custom' | 'none'; label: string; color: string | null; icon?: 'custom' | 'none' };
  const cells: Cell[] = [
    ...(none ? [{ key: 'none', value: 'none' as const, label: 'None', color: null, icon: 'none' as const }] : []),
    ...options.map(o => ({ key: o.value, value: o.value, label: o.label, color: o.color })),
    ...(withCustom ? [{ key: 'custom', value: 'custom' as const, label: 'Custom', color: customHex, icon: 'custom' as const }] : []),
  ];
  const rows: Cell[][] = [];
  for (let i = 0; i < cells.length; i += PER_ROW) rows.push(cells.slice(i, i + PER_ROW));

  return (
    <View style={[styles.card, { backgroundColor: colors.card }]}>
      <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel}>
        {rows.map((row, ri) => (
          <View key={ri} style={styles.row}>
            {row.map(cell => {
              const on = cell.value === value;
              const fill = cell.color ?? colors.card;
              const mark = cell.color ? contrastOn(cell.color) : colors.text;
              return (
                <Pressable
                  key={cell.key}
                  onPress={() => onChange(cell.value)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on, selected: on }}
                  accessibilityLabel={cell.label}
                  style={({ pressed }) => [styles.cell, pressed && styles.pressed]}
                >
                  <View style={[styles.ring, { borderColor: on ? colors.accent : 'transparent' }]}>
                    <View style={[styles.swatch, { backgroundColor: fill, borderColor: colors.ring }]}>
                      {cell.icon === 'none' ? (
                        // A slash across an empty swatch: "no colour".
                        <View style={[styles.slash, { backgroundColor: colors.muted }]} />
                      ) : null}
                      {on ? (
                        <Ionicons name="checkmark" size={17} color={cell.icon === 'none' ? colors.text : mark} />
                      ) : cell.icon === 'custom' ? (
                        <Ionicons name="color-palette-outline" size={15} color={mark} />
                      ) : null}
                    </View>
                  </View>
                  <Text
                    style={[Type.caption, styles.label, { color: on ? colors.text : colors.muted, fontWeight: on ? '600' : '400' }]}
                    numberOfLines={1}
                    maxFontSizeMultiplier={1.3}
                  >
                    {cell.label}
                  </Text>
                </Pressable>
              );
            })}
            {/* Keeps a short last row on the same grid as the rows above. */}
            {Array.from({ length: PER_ROW - row.length }, (_, i) => (
              <View key={`pad${i}`} style={styles.cell} />
            ))}
          </View>
        ))}
      </View>
      {withCustom && value === 'custom' ? (
        <CustomColorSliders hex={customHex} onChange={hex => onCustomChange?.(hex)} />
      ) : null}
    </View>
  );
}

/** Hue and Shade sliders for a custom colour, under the grid. */
function CustomColorSliders({ hex, onChange }: { hex: string; onChange: (hex: string) => void }) {
  const { colors } = useTheme();
  const { hue, shade } = slidersFromCustom(hex);
  const hueBands = Array.from({ length: 48 }, (_, i) => hslToHex((i / 47) * 359, CUSTOM_SATURATION, 0.5));
  const shadeBands = Array.from({ length: 24 }, (_, i) => customFromSliders(hue, i / 23));
  return (
    <View style={[styles.custom, { borderTopColor: colors.border }]}>
      <GradientSlider
        label="Hue"
        bands={hueBands}
        value={hue / 359}
        thumbColor={hslToHex(hue, CUSTOM_SATURATION, 0.5)}
        step={1 / 36}
        format={() => `${hue} degrees`}
        onChange={t => onChange(customFromSliders(Math.round(t * 359), shade))}
      />
      <GradientSlider
        label="Shade"
        bands={shadeBands}
        value={shade}
        thumbColor={hex}
        step={0.05}
        format={t => `${Math.round((SHADE_RANGE.min + t * (SHADE_RANGE.max - SHADE_RANGE.min)) * 100)}% light`}
        onChange={t => onChange(customFromSliders(hue, t))}
      />
    </View>
  );
}

/**
 * A slider over a colour track (drawn as flat bands: there is no gradient
 * library in the build), with a label on the left. `value` is 0..1.
 */
function GradientSlider({
  label,
  bands,
  value,
  thumbColor,
  step,
  format,
  onChange,
}: {
  label: string;
  bands: string[];
  value: number;
  thumbColor: string;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const { colors } = useTheme();
  // Read by the gesture closures (the responder is created once).
  const live = useRef({ x: 0, width: 1, measured: false, onChange });
  live.current.onChange = onChange;
  const trackRef = useRef<View>(null);
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (_, gs) => {
        trackRef.current?.measure((_x, _y, w, _h, pageX) => {
          live.current.x = pageX;
          live.current.width = Math.max(1, w);
          live.current.measured = true;
          live.current.onChange(Math.max(0, Math.min(1, (gs.x0 - pageX) / live.current.width)));
        });
      },
      onPanResponderMove: (_, gs) => {
        if (!live.current.measured) return;
        live.current.onChange(Math.max(0, Math.min(1, (gs.moveX - live.current.x) / live.current.width)));
      },
      onPanResponderRelease: () => {
        live.current.measured = false;
      },
      onPanResponderTerminate: () => {
        live.current.measured = false;
      },
    }),
  ).current;
  const t = Math.max(0, Math.min(1, value));
  return (
    <View style={styles.sliderRow}>
      <Text style={[Type.footnote, styles.sliderLabel, { color: colors.muted }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
        {label}
      </Text>
      <View
        ref={trackRef}
        style={styles.sliderTouch}
        {...pan.panHandlers}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ text: format(t) }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={e => {
          if (e.nativeEvent.actionName === 'increment') onChange(Math.min(1, t + step));
          if (e.nativeEvent.actionName === 'decrement') onChange(Math.max(0, t - step));
        }}
      >
        <View style={[styles.sliderTrack, { borderColor: colors.ring }]}>
          {bands.map((c, i) => (
            <View key={i} style={[styles.band, { backgroundColor: c }]} />
          ))}
        </View>
        <View
          style={[
            styles.sliderThumb,
            { left: `${t * 100}%`, backgroundColor: thumbColor, borderColor: colors.paper, shadowColor: colors.shadow },
          ]}
        />
      </View>
    </View>
  );
}

const THUMB = 26;

const styles = StyleSheet.create({
  card: { borderRadius: Radius.md, paddingVertical: Spacing.sm },
  row: { flexDirection: 'row', paddingHorizontal: Spacing.xs },
  cell: { flex: 1, alignItems: 'center', gap: Spacing.xs, paddingVertical: Spacing.xs, minHeight: HIT },
  pressed: { opacity: 0.6 },
  ring: { padding: 2, borderRadius: SWATCH, borderWidth: 2 },
  swatch: {
    width: SWATCH,
    height: SWATCH,
    borderRadius: SWATCH / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  slash: { position: 'absolute', width: SWATCH * 1.2, height: 1.5, transform: [{ rotate: '-45deg' }] },
  label: { textAlign: 'center' },
  custom: {
    marginTop: Spacing.xs,
    paddingTop: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, minHeight: HIT },
  sliderLabel: { width: 44 },
  // Inset by half a thumb so the thumb's centre reaches both ends.
  sliderTouch: { flex: 1, height: HIT, justifyContent: 'center', marginHorizontal: THUMB / 2 },
  sliderTrack: {
    position: 'absolute',
    left: -THUMB / 2,
    right: -THUMB / 2,
    height: 14,
    borderRadius: 7,
    overflow: 'hidden',
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
  },
  band: { flex: 1 },
  sliderThumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    marginLeft: -THUMB / 2,
    borderRadius: THUMB / 2,
    borderWidth: 3,
    shadowOpacity: 0.25,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
});
