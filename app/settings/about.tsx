// app/settings/about.tsx
import { StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { useTheme } from '@/contexts/theme-context';
import { ToolScreen } from '@/components/tool-ui';
import { BrandMark } from '@/components/brand-mark';
import { SettingsGroup, SettingsRow } from '@/components/settings-list';
import { Spacing, Type } from '@/lib/theme';

export default function AboutScreen() {
  const { colors } = useTheme();
  const version = Constants.expoConfig?.version ?? '1.0.0';

  return (
    <ToolScreen title="About">
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
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', paddingTop: Spacing.xl, paddingHorizontal: Spacing.lg },
  appName: { fontSize: 26, fontWeight: '800', marginTop: Spacing.xl, marginBottom: Spacing.xs },
  desc: { textAlign: 'center', lineHeight: 22, marginTop: Spacing.lg },
});
