// app/settings/about.tsx
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { BrandMark } from '@/components/brand-mark';
import { SettingsGroup, SettingsRow } from '@/components/settings-list';
import { Spacing, Type } from '@/lib/theme';

export default function AboutScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const version = Constants.expoConfig?.version ?? '1.0.0';

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      // The native header already sits below the status bar; only pad the content.
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.xxxl }]}
    >
      <Stack.Screen options={{ title: 'About' }} />
      <View style={styles.hero}>
        <BrandMark size={88} />
        <Text style={[styles.appName, { color: colors.text }]}>Scan Kit</Text>
        <Text style={[Type.subhead, { color: colors.muted }]}>Version {version}</Text>
        <Text style={[Type.callout, styles.desc, { color: colors.subtext }]}>
          A fast document scanner that works offline. Scan, organize, export and share your documents, with no account and no cloud.
        </Text>
      </View>

      <SettingsGroup title="Your data">
        <SettingsRow icon="phone-portrait-outline" label="Stored on this device" description="Scans never leave your phone unless you share them." />
        <SettingsRow icon="cloud-offline-outline" label="Works offline" description="Scanning, text recognition and export need no connection." last />
      </SettingsGroup>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: Spacing.gutter },
  hero: { alignItems: 'center', paddingTop: Spacing.xxxl, paddingHorizontal: Spacing.lg },
  appName: { fontSize: 26, fontWeight: '800', marginTop: Spacing.xl, marginBottom: Spacing.xs },
  desc: { textAlign: 'center', lineHeight: 22, marginTop: Spacing.lg },
});
