// components/empty-state.tsx
// Every empty list uses this, with an action wherever one makes sense.
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { Spacing, Type } from '@/lib/theme';

type Variant = 'no-docs' | 'empty-folder' | 'no-search-results';
type IconName = keyof typeof Ionicons.glyphMap;

type Props = {
  variant?: Variant;
  folderName?: string;
  query?: string;
  onAction?: () => void;
  actionLabel?: string;
  actionIcon?: IconName;
  /** Optional second, quieter action (e.g. "Import file"). */
  onSecondaryAction?: () => void;
  secondaryLabel?: string;
  /** Override the variant's copy. */
  title?: string;
  subtitle?: string;
  icon?: IconName;
};

const COPY: Record<Variant, { title: string; subtitle: string; icon: IconName }> = {
  'no-docs':           { icon: 'scan-outline',        title: 'No documents yet',      subtitle: 'Scan a document with the camera or import one to get started.' },
  'empty-folder':      { icon: 'folder-open-outline', title: 'This folder is empty',  subtitle: 'Long-press a document and choose Move to folder to add it here.' },
  'no-search-results': { icon: 'search-outline',      title: 'No results',            subtitle: 'Try a different search term.' },
};

export function EmptyState({
  variant = 'no-docs',
  folderName,
  query,
  onAction,
  actionLabel,
  actionIcon,
  onSecondaryAction,
  secondaryLabel,
  title,
  subtitle,
  icon,
}: Props) {
  const { colors } = useTheme();
  const copy = COPY[variant];
  const heading = title
    ?? (variant === 'empty-folder' && folderName ? `“${folderName}” is empty` : copy.title);
  const body = subtitle
    ?? (variant === 'no-search-results' && query ? `No documents match “${query}”.` : copy.subtitle);
  return (
    <View style={styles.container}>
      <View style={[styles.iconCircle, { backgroundColor: colors.accentLight }]}>
        <Ionicons name={icon ?? copy.icon} size={36} color={colors.accent} />
      </View>
      <Text style={[Type.title, styles.title, { color: colors.text }]}>{heading}</Text>
      <Text style={[Type.callout, styles.subtitle, { color: colors.muted }]}>{body}</Text>
      {onAction && actionLabel ? (
        <View style={styles.actions}>
          <PrimaryButton title={actionLabel} icon={actionIcon} onPress={onAction} />
          {onSecondaryAction && secondaryLabel ? (
            <PrimaryButton title={secondaryLabel} variant="secondary" onPress={onSecondaryAction} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xxxl + Spacing.sm,
    paddingVertical: Spacing.xxxl,
  },
  iconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.xl,
  },
  title: { marginBottom: Spacing.sm, textAlign: 'center' },
  subtitle: { textAlign: 'center', lineHeight: 21 },
  actions: { marginTop: Spacing.xxl, alignSelf: 'stretch', gap: Spacing.sm },
});
