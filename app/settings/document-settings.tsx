// app/settings/document-settings.tsx
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getDocSettings, saveDocSettings, DocSettings } from '@/lib/storage';
import { useTheme } from '@/contexts/theme-context';

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
  const { colors } = useTheme();
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
      style={[styles.container, { backgroundColor: colors.bg }]}
      contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
    >
      <View style={[styles.section, { backgroundColor: colors.card }]}>
        <Text style={[styles.sectionTitle, { color: colors.muted }]}>DEFAULT DOCUMENT NAME PREFIX</Text>
        <View style={styles.row}>
          <TextInput
            style={[styles.input, { borderBottomColor: colors.border, color: colors.text }]}
            value={settings.namePrefix}
            onChangeText={v => update({ namePrefix: v })}
            placeholder="Scan"
            placeholderTextColor={colors.faint}
            returnKeyType="done"
          />
        </View>
        <Text style={[styles.hint, { color: colors.muted }]}>New scans will be named "{settings.namePrefix || 'Scan'} Apr 10, 2026".</Text>
      </View>

      <View style={[styles.section, { backgroundColor: colors.card }]}>
        <Text style={[styles.sectionTitle, { color: colors.muted }]}>PDF PAGE SIZE</Text>
        {PAGE_SIZE_OPTIONS.map(opt => (
          <Pressable
            key={opt.value}
            style={[styles.optRow, { borderTopColor: colors.separator }]}
            onPress={() => update({ pdfPageSize: opt.value })}
          >
            <Text style={[styles.rowLabel, { color: colors.text }]}>{opt.label}</Text>
            <View style={[styles.radio, { borderColor: settings.pdfPageSize === opt.value ? colors.accent : colors.border }]}>
              {settings.pdfPageSize === opt.value && <View style={[styles.radioDot, { backgroundColor: colors.accent }]} />}
            </View>
          </Pressable>
        ))}
      </View>

      <View style={[styles.section, { backgroundColor: colors.card }]}>
        <Text style={[styles.sectionTitle, { color: colors.muted }]}>PDF IMAGE QUALITY</Text>
        {QUALITY_OPTIONS.map(opt => (
          <Pressable
            key={opt.value}
            style={[styles.optRow, { borderTopColor: colors.separator }]}
            onPress={() => update({ pdfQuality: opt.value })}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowLabel, { color: colors.text }]}>{opt.label}</Text>
              <Text style={[styles.rowDesc, { color: colors.muted }]}>{opt.desc}</Text>
            </View>
            <View style={[styles.radio, { borderColor: settings.pdfQuality === opt.value ? colors.accent : colors.border }]}>
              {settings.pdfQuality === opt.value && <View style={[styles.radioDot, { backgroundColor: colors.accent }]} />}
            </View>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  section: {
    marginHorizontal: 14,
    marginTop: 20,
    borderRadius: 14,
    overflow: 'hidden',
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
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
  },
  input: {
    fontSize: 16,
    borderBottomWidth: 1,
    paddingVertical: 6,
  },
  hint: { fontSize: 12, paddingHorizontal: 16, paddingBottom: 12 },
  rowLabel: { fontSize: 16 },
  rowDesc: { fontSize: 12, marginTop: 1 },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
});
