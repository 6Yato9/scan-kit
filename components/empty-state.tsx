// components/empty-state.tsx
import { StyleSheet, Text, View } from 'react-native';

export function EmptyState() {
  return (
    <View style={styles.container}>
      <Text style={styles.icon}>📄</Text>
      <Text style={styles.title}>No scans yet</Text>
      <Text style={styles.subtitle}>
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
    color: '#1a1a1a',
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 15,
    color: '#999',
    textAlign: 'center',
    lineHeight: 22,
  },
});
