// components/status-card.tsx
// The card a PDF tool shows about the chosen document (Protect PDF, Flatten
// PDF): a tinted 30pt icon tile beside a bold line and a muted explanation —
// the same look as Unlock PDF's status card and the tool intro's points.
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { Radius, Spacing, Type } from '@/lib/theme';
import type { IoniconName } from '@/components/app-icon';

export function StatusCard({ icon, title, detail }: { icon: IoniconName; title: string; detail: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, styles.status, { backgroundColor: colors.card }]} accessible accessibilityLabel={`${title}. ${detail}`}>
      <View style={[styles.tile, { backgroundColor: colors.accentLight }]}>
        <Ionicons name={icon} size={18} color={colors.accent} />
      </View>
      <View style={styles.flex}>
        <Text style={[Type.body, styles.title, { color: colors.text }]}>{title}</Text>
        <Text style={[Type.footnote, styles.detail, { color: colors.muted }]}>{detail}</Text>
      </View>
    </View>
  );
}

/** The card's place while the document is being read. */
export function StatusLoading() {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, styles.loading, { backgroundColor: colors.card }]}>
      <ActivityIndicator color={colors.muted} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: { borderRadius: Radius.md, overflow: 'hidden' },
  loading: { paddingVertical: Spacing.xxl, alignItems: 'center' },
  status: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    paddingVertical: Spacing.md + 2,
    paddingHorizontal: Spacing.lg,
  },
  tile: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  title: { fontWeight: '600', marginTop: 4 },
  detail: { marginTop: Spacing.xs, lineHeight: 18 },
});
