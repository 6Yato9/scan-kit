// components/bake-indicator.tsx
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { subscribeBakeActivity } from '@/lib/bake-queue';
import { Radius, Spacing, Type } from '@/lib/theme';

/** Number of filter bakes in flight (0 when idle). */
export function useBakeActivity(): number {
  const [active, setActive] = useState(0);
  useEffect(() => subscribeBakeActivity(setActive), []);
  return active;
}

/**
 * "Enhancing…" pill shown while filter bakes are in flight.
 *
 * `top` / `bottom` float it from the safe-area insets: `offset` is the
 * distance from the safe area (e.g. the height of a header or tab bar the pill
 * must clear). `inline` lays it out in place with no shadow; the viewer puts it
 * in the row under the page, beside the page counter, so it never covers the
 * page itself.
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
  placement?: 'top' | 'bottom' | 'inline';
  offset?: number;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const active = useBakeActivity();

  if (active === 0) return null;

  const position = placement === 'inline'
    ? styles.inline
    : [styles.floating, placement === 'top'
      ? { top: insets.top + offset + Spacing.sm }
      : { bottom: insets.bottom + offset + Spacing.sm }];

  return (
    <View
      style={[styles.pill, position, { backgroundColor: colors.chromeRaised }]}
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      accessibilityLabel={active > 1 ? `Enhancing ${active} pages` : 'Enhancing page'}
    >
      <ActivityIndicator size="small" color={colors.chromeText} style={placement === 'inline' ? styles.smallSpinner : null} />
      <Text style={[Type.footnote, styles.label, { color: colors.chromeText }]}>
        {active > 1 ? `Enhancing ${active} pages…` : 'Enhancing…'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    borderRadius: Radius.pill,
  },
  // Same height as the viewer's page counter beside it.
  inline: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.xxs + 1 },
  smallSpinner: { transform: [{ scale: 0.8 }], marginVertical: -4 },
  floating: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: Spacing.md + 2,
    paddingVertical: Spacing.sm + 2,
    zIndex: 10,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  label: { fontWeight: '600' },
});
