// components/app-icon.tsx
// Ionicons, plus the few glyphs Ionicons lacks, drawn with Apple's own SF
// Symbols (already linked through expo-symbols) at a regular weight so their
// stroke matches the outline icons around them:
// - 'signature' (Sign): Ionicons' nearest options all mean something else in
//   this app (create-outline is compose, the pencil is Rename, brush-outline is
//   Mark up).
// - 'rename' (Rename): Ionicons' pencil-outline is drawn with a heavier
//   stroke than every other outline icon, so it reads as solid in a list.
// - 'long-image' (Long image): image-outline already means "a page as an
//   image" (Share page as image, JPEG export), so pages stitched into one tall
//   picture get their own glyph.
// Android and web fall back to the nearest Ionicon.
import { Platform, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SymbolView, type SFSymbol } from 'expo-symbols';

export type IoniconName = React.ComponentProps<typeof Ionicons>['name'];
type SymbolGlyph = 'signature' | 'rename' | 'long-image';
export type AppIconName = IoniconName | SymbolGlyph;

const SYMBOLS: Record<SymbolGlyph, { symbol: SFSymbol; fallback: IoniconName; scale: number; rotate?: string }> = {
  // The glyph is wide and short, so it is drawn a little larger than the box
  // to carry the same visual weight as its square neighbours.
  signature: { symbol: 'signature', fallback: 'create-outline', scale: 1.2 },
  rename: { symbol: 'pencil', fallback: 'pencil-outline', scale: 1 },
  // A tall page split in two: SF Symbols only has the side-by-side split, so
  // it is turned upright.
  'long-image': { symbol: 'rectangle.split.2x1', fallback: 'albums-outline', scale: 1.1, rotate: '90deg' },
};

export function isSymbolGlyph(name: AppIconName): name is SymbolGlyph {
  return name in SYMBOLS;
}

/** The Ionicon used for a glyph where an Ionicon is required (Android, plain rows). */
export function ioniconFor(name: AppIconName): IoniconName {
  return isSymbolGlyph(name) ? SYMBOLS[name].fallback : name;
}

export function AppIcon({ name, size, color }: { name: AppIconName; size: number; color: string }) {
  if (!isSymbolGlyph(name)) return <Ionicons name={name} size={size} color={color} />;
  const { symbol, fallback: fallbackName, scale, rotate } = SYMBOLS[name];
  const fallback = <Ionicons name={fallbackName} size={size} color={color} />;
  if (Platform.OS !== 'ios') return fallback;
  return (
    <View
      style={[styles.box, { width: size, height: size }, rotate ? { transform: [{ rotate }] } : null]}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      <SymbolView name={symbol} size={size * scale} tintColor={color} weight="regular" fallback={fallback} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
});
