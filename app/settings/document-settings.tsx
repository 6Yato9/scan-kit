// app/settings/document-settings.tsx
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Stack, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getDocSettings, saveDocSettings, DocSettings } from '@/lib/storage';
import { autoName } from '@/lib/auto-name';
import { useTheme } from '@/contexts/theme-context';
import { SettingsGroup, SettingsRow } from '@/components/settings-list';
import { HIT, Spacing, Type } from '@/lib/theme';

const PAGE_SIZE_OPTIONS: { label: string; desc: string; value: DocSettings['pdfPageSize'] }[] = [
  { label: 'A4', desc: '210 × 297 mm', value: 'A4' },
  { label: 'US Letter', desc: '8.5 × 11 in', value: 'Letter' },
];

const QUALITY_OPTIONS: { label: string; value: DocSettings['pdfQuality']; desc: string }[] = [
  { label: 'Standard', value: 'standard', desc: 'Smaller files, good for email' },
  { label: 'High', value: 'high', desc: 'Full-resolution images' },
];

export default function DocumentSettingsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [settings, setSettings] = useState<DocSettings | null>(null);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    getDocSettings().then(s => { if (!cancelled) setSettings(s); });
    return () => { cancelled = true; };
  }, []));

  const update = async (patch: Partial<DocSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    await saveDocSettings(next);
  };

  // Shows exactly what the scanner will produce (lib/auto-name.ts).
  const example = autoName(new Date(), settings?.namePrefix ?? 'Scan');

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.xxxl }]}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: 'Document settings' }} />
      <SettingsGroup title="Name for new scans" footer={`New scans will be named “${example}”.`}>
        <View style={styles.inputRow}>
          <TextInput
            style={[Type.body, styles.input, { color: colors.text }]}
            value={settings?.namePrefix ?? ''}
            onChangeText={v => update({ namePrefix: v })}
            placeholder="Scan"
            placeholderTextColor={colors.muted}
            returnKeyType="done"
            autoCorrect={false}
            accessibilityLabel="Name for new scans"
            clearButtonMode="while-editing"
          />
        </View>
      </SettingsGroup>

      <SettingsGroup title="PDF page size">
        {PAGE_SIZE_OPTIONS.map((opt, i) => (
          <SettingsRow
            key={opt.value}
            label={opt.label}
            description={opt.desc}
            accessory={{ type: 'check', selected: settings?.pdfPageSize === opt.value }}
            onPress={() => update({ pdfPageSize: opt.value })}
            last={i === PAGE_SIZE_OPTIONS.length - 1}
          />
        ))}
      </SettingsGroup>

      <SettingsGroup title="PDF image quality">
        {QUALITY_OPTIONS.map((opt, i) => (
          <SettingsRow
            key={opt.value}
            label={opt.label}
            description={opt.desc}
            accessory={{ type: 'check', selected: settings?.pdfQuality === opt.value }}
            onPress={() => update({ pdfQuality: opt.value })}
            last={i === QUALITY_OPTIONS.length - 1}
          />
        ))}
      </SettingsGroup>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: Spacing.gutter },
  inputRow: { paddingHorizontal: Spacing.lg, minHeight: HIT + 8, justifyContent: 'center' },
  input: { paddingVertical: Spacing.md },
});
