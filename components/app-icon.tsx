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
//   picture get their own glyph: one tall frame holding three pages stacked
//   end to end (SF Symbols' three-part split, turned upright). Arrows out of a
//   frame read as "resize", which this tool doesn't do.
// - 'watermark' (Watermark): Ionicons only has the water drop, a pun on the
//   name; SF Symbols' page with a stamp says "mark every page".
// - 'id-card' (ID card): Ionicons' id-card-outline is an upright badge; ID
//   cards are landscape, as SF Symbols' person.text.rectangle is.
// The pencil is a solid stroke rather than an outline, so it is drawn at the
// light weight to sit with the outline icons around it.
// Android and web fall back to the nearest Ionicon.
import { Platform, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SymbolView, type SFSymbol, type SymbolWeight } from 'expo-symbols';

export type IoniconName = React.ComponentProps<typeof Ionicons>['name'];
type SymbolGlyph = 'signature' | 'rename' | 'long-image' | 'id-card' | 'watermark' | 'rotate-left';
export type AppIconName = IoniconName | SymbolGlyph;

const SYMBOLS: Record<
  SymbolGlyph,
  { symbol: SFSymbol; fallback: IoniconName; scale: number; rotate?: string; weight?: SymbolWeight }
> = {
  // The glyph is wide and short, so it is drawn a little larger than the box
  // to carry the same visual weight as its square neighbours.
  signature: { symbol: 'signature', fallback: 'create-outline', scale: 1.2 },
  rename: { symbol: 'pencil', fallback: 'pencil-outline', scale: 0.95, weight: 'light' },
  // Pages joined into one tall picture: a three-part split turned upright.
  'long-image': { symbol: 'rectangle.split.3x1', fallback: 'albums-outline', scale: 1.15, rotate: '90deg' },
  // A page carrying a stamp: what a watermark does to every page.
  watermark: { symbol: 'checkmark.seal.text.page', fallback: 'ribbon-outline', scale: 1.05 },
  // Wide and short like the signature, so drawn a little larger.
  'id-card': { symbol: 'person.text.rectangle', fallback: 'id-card-outline', scale: 1.1 },
  // Counterclockwise rotation (PDF pages): Ionicons' circular arrows only turn clockwise.
  'rotate-left': { symbol: 'rotate.left', fallback: 'refresh-outline', scale: 1 },
};

export function isSymbolGlyph(name: AppIconName): name is SymbolGlyph {
  return name in SYMBOLS;
}

/** The Ionicon used for a glyph where an Ionicon is required (Android, plain rows). */
export function ioniconFor(name: AppIconName): IoniconName {
  return isSymbolGlyph(name) ? SYMBOLS[name].fallback : name;
}

export function AppIcon({
  name,
  size,
  color,
  weight: weightOverride,
}: {
  name: AppIconName;
  size: number;
  color: string;
  /** SF Symbol stroke weight, overriding the glyph's default (e.g. a bolder pencil beside a title). */
  weight?: SymbolWeight;
}) {
  if (!isSymbolGlyph(name)) return <Ionicons name={name} size={size} color={color} />;
  const { symbol, fallback: fallbackName, scale, rotate, weight: glyphWeight = 'regular' } = SYMBOLS[name];
  const weight = weightOverride ?? glyphWeight;
  const fallback = <Ionicons name={fallbackName} size={size} color={color} />;
  if (Platform.OS !== 'ios') return fallback;
  return (
    <View
      style={[styles.box, { width: size, height: size }, rotate ? { transform: [{ rotate }] } : null]}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      <SymbolView name={symbol} size={size * scale} tintColor={color} weight={weight} fallback={fallback} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
});
