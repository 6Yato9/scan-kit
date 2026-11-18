// components/app-icon.tsx
// Ionicons, plus the one glyph Ionicons lacks: a signature. Ionicons' nearest
// options all mean something else in this app (create-outline is compose,
// pencil-outline is Rename, brush-outline is Mark up), so "Sign" uses Apple's
// own SF Symbol `signature` — already linked through expo-symbols — drawn at a
// regular weight so its stroke matches the outline icons around it. Android and
// web fall back to create-outline.
import { Platform, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SymbolView } from 'expo-symbols';

export type IoniconName = React.ComponentProps<typeof Ionicons>['name'];
export type AppIconName = IoniconName | 'signature';

export function AppIcon({ name, size, color }: { name: AppIconName; size: number; color: string }) {
  if (name !== 'signature') return <Ionicons name={name} size={size} color={color} />;
  const fallback = <Ionicons name="create-outline" size={size} color={color} />;
  if (Platform.OS !== 'ios') return fallback;
  return (
    // The glyph is wide and short, so it is drawn a little larger than the
    // box to carry the same visual weight as its square neighbours.
    <View style={[styles.box, { width: size, height: size }]} accessibilityElementsHidden importantForAccessibility="no">
      <SymbolView name="signature" size={size * 1.2} tintColor={color} weight="regular" fallback={fallback} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
});
