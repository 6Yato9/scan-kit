// app/settings/scan-settings.tsx
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getScanSettings, saveScanSettings, ScanSettings } from '@/lib/storage';
import { PageFilter } from '@/types/document';

type Quality = ScanSettings['quality'];
type FilterOrOriginal = PageFilter | 'original';

const QUALITY_OPTIONS: { label: string; value: Quality; desc: string }[] = [
  { label: 'Low', value: 'low', desc: '~0.5 MB/page' },
  { label: 'Medium', value: 'medium', desc: '~1 MB/page' },
  { label: 'High', value: 'high', desc: '~2 MB/page' },
];

const FILTER_OPTIONS: { label: string; value: FilterOrOriginal }[] = [
  { label: 'Color', value: 'original' },
  { label: 'Grayscale', value: 'grayscale' },
  { label: 'Black & White', value: 'bw' },
  { label: 'Enhanced', value: 'enhanced' },
];

export default function ScanSettingsScreen() {
  const insets = useSafeAreaInsets();
  const [settings, setSettings] = useState<ScanSettings>({
    quality: 'high',
    autoCrop: true,
    defaultFilter: 'original',
  });

  useFocusEffect(useCallback(() => {
    getScanSettings().then(setSettings);
  }, []));

  const update = async (patch: Partial<ScanSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await saveScanSettings(next);
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
    >
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>SCAN QUALITY</Text>
        {QUALITY_OPTIONS.map(opt => (
          <Pressable
            key={opt.value}
            style={styles.row}
            onPress={() => update({ quality: opt.value })}
          >
            <View style={styles.rowLeft}>
              <Text style={styles.rowLabel}>{opt.label}</Text>
              <Text style={styles.rowDesc}>{opt.desc}</Text>
            </View>
            <View style={[styles.radio, settings.quality === opt.value && styles.radioActive]}>
              {settings.quality === opt.value && <View style={styles.radioDot} />}
            </View>
          </Pressable>
        ))}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>AUTO-CROP</Text>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Allow manual crop adjustment</Text>
          <Switch
            value={settings.autoCrop}
            onValueChange={v => update({ autoCrop: v })}
            trackColor={{ true: '#0a7ea4' }}
          />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>DEFAULT COLOR MODE</Text>
        {FILTER_OPTIONS.map(opt => (
          <Pressable
            key={opt.value}
            style={styles.row}
            onPress={() => update({ defaultFilter: opt.value })}
          >
            <Text style={styles.rowLabel}>{opt.label}</Text>
            <View style={[styles.radio, settings.defaultFilter === opt.value && styles.radioActive]}>
              {settings.defaultFilter === opt.value && <View style={styles.radioDot} />}
            </View>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  section: {
    backgroundColor: '#fff',
    marginHorizontal: 14,
    marginTop: 20,
    borderRadius: 14,
    overflow: 'hidden',
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#888',
    letterSpacing: 0.8,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#f0f0f0',
  },
  rowLeft: { flex: 1 },
  rowLabel: { fontSize: 16, color: '#1a1a1a' },
  rowDesc: { fontSize: 12, color: '#888', marginTop: 1 },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#ccc',
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioActive: { borderColor: '#0a7ea4' },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#0a7ea4' },
});
