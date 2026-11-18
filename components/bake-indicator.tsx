// components/bake-indicator.tsx
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { subscribeBakeActivity } from '@/lib/bake-queue';
import { Radius, Spacing, Type } from '@/lib/theme';

/**
 * "Enhancing…" pill shown while filter bakes are in flight.
 *
 * Positioned from the safe-area insets: `placement` picks the edge and `offset`
 * is the distance from the safe area (e.g. the height of a header or tab bar
 * the pill must clear). The viewer anchors it to the top, because the
 * page-actions sheet covers the bottom half exactly when a filter is picked.
 *
 * Baking happens off-screen in a WebView and takes a moment per page, so without
 * this the user picks a filter (or finishes a multi-page scan) and nothing appears
 * to happen until the image silently changes underneath them.
 *
 * Renders nothing when idle, so it costs nothing on the common path.
 */
export function BakeIndicator({
  placement = 'top',
  offset = 0,
}: {
  placement?: 'top' | 'bottom';
  offset?: number;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [active, setActive] = useState(0);

  useEffect(() => subscribeBakeActivity(setActive), []);

  if (active === 0) return null;

  const edge = placement === 'top'
    ? { top: insets.top + offset + Spacing.sm }
    : { bottom: insets.bottom + offset + Spacing.sm };

  return (
    <View
      style={[styles.pill, edge, { backgroundColor: colors.chromeRaised }]}
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      accessibilityLabel={active > 1 ? `Enhancing ${active} pages` : 'Enhancing page'}
    >
      <ActivityIndicator size="small" color={colors.chromeText} />
      <Text style={[Type.footnote, styles.label, { color: colors.chromeText }]}>
        {active > 1 ? `Enhancing ${active} pages…` : 'Enhancing…'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md + 2,
    paddingVertical: Spacing.sm + 2,
    borderRadius: Radius.pill,
    zIndex: 10,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  label: { fontWeight: '600' },
});
