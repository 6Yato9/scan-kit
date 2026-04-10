// app/settings/about.tsx
import { StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';

export default function AboutScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const version = Constants.expoConfig?.version ?? '1.0.0';

  return (
    <View style={[styles.container, { backgroundColor: colors.bg, paddingTop: insets.top + 24 }]}>
      <Text style={styles.icon}>📄</Text>
      <Text style={[styles.appName, { color: colors.text }]}>Scan Kit</Text>
      <Text style={[styles.version, { color: colors.muted }]}>Version {version}</Text>
      <Text style={[styles.desc, { color: colors.subtext }]}>
        A fast, offline document scanner. Scan, organise, export, and share your documents — no cloud required.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  icon: { fontSize: 56, marginBottom: 12 },
  appName: { fontSize: 26, fontWeight: '800' },
  version: { fontSize: 14, marginTop: 4, marginBottom: 20 },
  desc: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
});
