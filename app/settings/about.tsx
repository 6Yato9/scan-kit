// app/settings/about.tsx
import { StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function AboutScreen() {
  const insets = useSafeAreaInsets();
  const version = Constants.expoConfig?.version ?? '1.0.0';

  return (
    <View style={[styles.container, { paddingTop: insets.top + 24 }]}>
      <Text style={styles.icon}>📄</Text>
      <Text style={styles.appName}>Scan Kit</Text>
      <Text style={styles.version}>Version {version}</Text>
      <Text style={styles.desc}>
        A fast, offline document scanner. Scan, organise, export, and share your documents — no cloud required.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  icon: { fontSize: 56, marginBottom: 12 },
  appName: { fontSize: 26, fontWeight: '800', color: '#1a1a1a' },
  version: { fontSize: 14, color: '#888', marginTop: 4, marginBottom: 20 },
  desc: {
    fontSize: 15,
    color: '#555',
    textAlign: 'center',
    lineHeight: 22,
  },
});
