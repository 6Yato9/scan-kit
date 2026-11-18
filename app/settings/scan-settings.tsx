// app/settings/scan-settings.tsx
import { useCallback, useState } from 'react';
import { FILTER_LABELS } from '@/components/page-actions-sheet';
import { ScrollView, StyleSheet } from 'react-native';
import { Stack, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getScanSettings, saveScanSettings, ScanSettings } from '@/lib/storage';
import { PageFilter } from '@/types/document';
import { useTheme } from '@/contexts/theme-context';
import { SettingsGroup, SettingsRow } from '@/components/settings-list';
import { Spacing } from '@/lib/theme';

type Quality = ScanSettings['quality'];

const QUALITY_OPTIONS: { label: string; value: Quality; desc: string }[] = [
  { label: 'Standard', value: 'low', desc: 'Smallest files, about 0.5 MB a page' },
  { label: 'High', value: 'medium', desc: 'About 1 MB a page' },
  { label: 'Best', value: 'high', desc: 'Sharpest text, about 2 MB a page' },
];

// Labels match the filter names in the viewer.
const FILTER_OPTIONS: { label: string; value: PageFilter; desc: string }[] = [
  { label: FILTER_LABELS.enhanced, value: 'enhanced', desc: 'Brighter paper and crisper text' },
  { label: FILTER_LABELS.original, value: 'original', desc: 'Colors exactly as captured' },
  { label: FILTER_LABELS.grayscale, value: 'grayscale', desc: 'Shades of gray' },
  { label: FILTER_LABELS.bw, value: 'bw', desc: 'High contrast, best for text' },
];

export default function ScanSettingsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [settings, setSettings] = useState<ScanSettings | null>(null);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    getScanSettings().then(s => { if (!cancelled) setSettings(s); });
    return () => { cancelled = true; };
  }, []));

  const update = async (patch: Partial<ScanSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    await saveScanSettings(next);
  };

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.xxxl }]}
    >
      <Stack.Screen options={{ title: 'Scan settings' }} />
      <SettingsGroup title="Image quality" footer="Applies to new scans and imported photos.">
        {QUALITY_OPTIONS.map((opt, i) => (
          <SettingsRow
            key={opt.value}
            label={opt.label}
            description={opt.desc}
            accessory={{ type: 'check', selected: settings?.quality === opt.value }}
            onPress={() => update({ quality: opt.value })}
            last={i === QUALITY_OPTIONS.length - 1}
          />
        ))}
      </SettingsGroup>

      <SettingsGroup title="Default filter" footer="Every new page gets this filter. You can change it per page in the viewer.">
        {FILTER_OPTIONS.map((opt, i) => (
          <SettingsRow
            key={opt.value}
            label={opt.label}
            description={opt.desc}
            accessory={{ type: 'check', selected: settings?.defaultFilter === opt.value }}
            onPress={() => update({ defaultFilter: opt.value })}
            last={i === FILTER_OPTIONS.length - 1}
          />
        ))}
      </SettingsGroup>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: Spacing.gutter },
});
