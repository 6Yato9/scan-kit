// components/brand-mark.tsx
// The Scan Kit mark, drawn with plain views so it scales crisply and follows
// the theme: a page with text lines inside four viewfinder corners, crossed by
// a scan line, on an accent tile shaped like the app icon.
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/contexts/theme-context';

export function BrandMark({ size = 120 }: { size?: number }) {
  const { colors } = useTheme();
  const s = size / 120; // all geometry below is designed at 120pt
  const corner = 22 * s;
  const stroke = Math.max(2, 4 * s);
  const inset = 18 * s;

  return (
    <View
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          borderRadius: 27 * s,
          backgroundColor: colors.accentFill,
          shadowColor: colors.accentFill,
          shadowRadius: 18 * s,
          shadowOffset: { width: 0, height: 8 * s },
        },
      ]}
      accessible
      accessibilityLabel="Scan Kit"
      accessibilityRole="image"
    >
      {/* Viewfinder corners: two rounded bars each (partial borders with a
          radius render with feathered ends on iOS). */}
      {(['tl', 'tr', 'bl', 'br'] as const).map(c => {
        const v = c[0] === 't' ? { top: inset } : { bottom: inset };
        const h = c[1] === 'l' ? { left: inset } : { right: inset };
        const bar = { position: 'absolute' as const, backgroundColor: colors.onAccent, borderRadius: stroke / 2 };
        return (
          <View key={c} style={[styles.abs, v, h, { width: corner, height: corner }]}>
            <View style={[bar, { height: stroke, width: corner, [c[0] === 't' ? 'top' : 'bottom']: 0 }]} />
            <View style={[bar, { width: stroke, height: corner, [c[1] === 'l' ? 'left' : 'right']: 0 }]} />
          </View>
        );
      })}

      {/* Page */}
      <View
        style={{
          width: 50 * s,
          height: 64 * s,
          borderRadius: 6 * s,
          backgroundColor: colors.onAccent,
          paddingHorizontal: 9 * s,
          paddingTop: 12 * s,
          gap: 7 * s,
        }}
      >
        {[1, 0.8, 1, 0.6].map((w, i) => (
          <View
            key={i}
            style={{ height: 4 * s, width: `${w * 100}%`, borderRadius: 2 * s, backgroundColor: colors.accentFill, opacity: 0.35 }}
          />
        ))}
      </View>

      {/* Scan line: accent core with a light rim, so it reads on the page and on the tile */}
      <View
        style={[
          styles.abs,
          {
            left: (size - 70 * s) / 2,
            width: 70 * s,
            top: size / 2 - 3 * s,
            height: 6 * s,
            borderRadius: 3 * s,
            backgroundColor: colors.accentFill,
            borderWidth: Math.max(1, 1.5 * s),
            borderColor: colors.onAccent,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: 'center', justifyContent: 'center', shadowOpacity: 0.35, elevation: 8 },
  abs: { position: 'absolute' },
});
