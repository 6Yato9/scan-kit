// components/empty-state.tsx
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/contexts/theme-context';

export function EmptyState() {
  const { colors } = useTheme();
  return (
    <View style={styles.container}>
      <Text style={styles.icon}>📄</Text>
      <Text style={[styles.title, { color: colors.text }]}>No scans yet</Text>
      <Text style={[styles.subtitle, { color: colors.faint }]}>
        Tap the button below to scan your first document
      </Text>
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
  },
  subtitle: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
});
