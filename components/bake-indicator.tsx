// components/bake-indicator.tsx
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { subscribeBakeActivity } from '@/lib/bake-queue';

/**
 * "Enhancing…" pill shown while filter bakes are in flight.
 *
 * Anchored to the TOP rather than the bottom: filter changes are made from the
 * page-actions bottom sheet, which covers the lower half of the screen, so a
 * bottom-anchored pill would be hidden at exactly the moment it is needed.
 *
 * Baking happens off-screen in a WebView and takes a moment per page, so without
 * this the user picks a filter (or finishes a multi-page scan) and nothing appears
 * to happen until the image silently changes underneath them. That silence is the
 * single biggest thing making the app feel less finished than it is.
 *
 * Renders nothing when idle, so it costs nothing on the common path.
 */
export function BakeIndicator({ top = 0 }: { top?: number }) {
  const [active, setActive] = useState(0);

  useEffect(() => subscribeBakeActivity(setActive), []);

  if (active === 0) return null;

  return (
    <View style={[styles.pill, { top: top + 12 }]} pointerEvents="none">
      <ActivityIndicator size="small" color="#fff" />
      <Text style={styles.label}>
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
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.78)',
  },
  label: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
