// components/empty-state.tsx
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/contexts/theme-context';

type Variant = 'no-docs' | 'empty-folder' | 'no-search-results';

type Props = {
  variant?: Variant;
  folderName?: string;
  query?: string;
};

const COPY: Record<Variant, { title: string; subtitle: string; icon: string }> = {
  'no-docs':           { icon: '📄', title: 'No scans yet',       subtitle: 'Tap the camera button to scan your first document' },
  'empty-folder':      { icon: '📁', title: 'This folder is empty', subtitle: 'Long-press a document elsewhere to move it here' },
  'no-search-results': { icon: '🔎', title: 'No results',         subtitle: 'Try a different search term' },
};

export function EmptyState({ variant = 'no-docs', folderName, query }: Props) {
  const { colors } = useTheme();
  const copy = COPY[variant];
  const title = variant === 'empty-folder' && folderName
    ? `"${folderName}" is empty`
    : copy.title;
  const subtitle = variant === 'no-search-results' && query
    ? `No documents match "${query}"`
    : copy.subtitle;
  return (
    <View style={styles.container}>
      <Text style={styles.icon}>{copy.icon}</Text>
      <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
      <Text style={[styles.subtitle, { color: colors.faint }]}>{subtitle}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 48,
  },
  icon: {
    fontSize: 72,
    marginBottom: 20,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 10,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
});
