// app/settings/document-settings.tsx
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getDocSettings, saveDocSettings, DocSettings } from '@/lib/storage';

const PAGE_SIZE_OPTIONS: { label: string; value: DocSettings['pdfPageSize'] }[] = [
  { label: 'A4 (210 × 297 mm)', value: 'A4' },
  { label: 'Letter (8.5 × 11 in)', value: 'Letter' },
];

const QUALITY_OPTIONS: { label: string; value: DocSettings['pdfQuality']; desc: string }[] = [
  { label: 'Standard', value: 'standard', desc: 'Smaller file size' },
  { label: 'High', value: 'high', desc: 'Better image quality' },
];

export default function DocumentSettingsScreen() {
  const insets = useSafeAreaInsets();
  const [settings, setSettings] = useState<DocSettings>({
    namePrefix: 'Scan',
    pdfPageSize: 'A4',
    pdfQuality: 'standard',
  });

  useFocusEffect(useCallback(() => {
    getDocSettings().then(setSettings);
  }, []));

  const update = async (patch: Partial<DocSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await saveDocSettings(next);
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
    >
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>DEFAULT DOCUMENT NAME PREFIX</Text>
        <View style={styles.row}>
          <TextInput
            style={styles.input}
            value={settings.namePrefix}
            onChangeText={v => update({ namePrefix: v })}
            placeholder="Scan"
            placeholderTextColor="#aaa"
            returnKeyType="done"
          />
        </View>
        <Text style={styles.hint}>New scans will be named "{settings.namePrefix || 'Scan'} Apr 10, 2026".</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>PDF PAGE SIZE</Text>
        {PAGE_SIZE_OPTIONS.map(opt => (
          <Pressable
            key={opt.value}
            style={styles.optRow}
            onPress={() => update({ pdfPageSize: opt.value })}
          >
            <Text style={styles.rowLabel}>{opt.label}</Text>
            <View style={[styles.radio, settings.pdfPageSize === opt.value && styles.radioActive]}>
              {settings.pdfPageSize === opt.value && <View style={styles.radioDot} />}
            </View>
          </Pressable>
        ))}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>PDF IMAGE QUALITY</Text>
        {QUALITY_OPTIONS.map(opt => (
          <Pressable
            key={opt.value}
            style={styles.optRow}
            onPress={() => update({ pdfQuality: opt.value })}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>{opt.label}</Text>
              <Text style={styles.rowDesc}>{opt.desc}</Text>
            </View>
            <View style={[styles.radio, settings.pdfQuality === opt.value && styles.radioActive]}>
              {settings.pdfQuality === opt.value && <View style={styles.radioDot} />}
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
  row: { paddingHorizontal: 16, paddingVertical: 10 },
  optRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#f0f0f0',
  },
  input: {
    fontSize: 16,
    color: '#1a1a1a',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
    paddingVertical: 6,
  },
  hint: { fontSize: 12, color: '#888', paddingHorizontal: 16, paddingBottom: 12 },
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
