// app/(tabs)/me.tsx
import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SortSheet } from '@/components/sort-sheet';
import { getSortPreference, saveSortPreference, SortKey } from '@/lib/storage';
import { useTheme } from '@/contexts/theme-context';

type Row = {
  icon: string;
  label: string;
  route?: string;
  action?: 'sort' | 'help';
};

const ROWS: Row[] = [
  { icon: '📷', label: 'Scan Settings', route: '/settings/scan-settings' },
  { icon: '📄', label: 'Document Settings', route: '/settings/document-settings' },
  { icon: '🖨', label: 'My Printer', route: '/settings/printer' },
  { icon: '↕️', label: 'Sort Preference', action: 'sort' },
  { icon: '❓', label: 'Help', action: 'help' },
  { icon: 'ℹ️', label: 'About', route: '/settings/about' },
];

export default function MeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [sortSheetVisible, setSortSheetVisible] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('dateAdded');
  const { preference, setPreference, colors } = useTheme();

  useFocusEffect(useCallback(() => {
    getSortPreference().then(setSortKey);
  }, []));

  const handleRow = (row: Row) => {
    if (row.route) {
      router.push(row.route as any);
    } else if (row.action === 'sort') {
      setSortSheetVisible(true);
    } else if (row.action === 'help') {
      Alert.alert(
        'Help',
        '• Tap 📷 in the tab bar to scan a document.\n• Tap any document to view it.\n• Long-press a document for actions.\n• Use Tools tab to import files or images.\n• Adjust quality and defaults in Scan Settings.',
        [{ text: 'Got it' }]
      );
    }
  };

  const handleSort = async (key: SortKey) => {
    setSortKey(key);
    await saveSortPreference(key);
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.bg }]}
      contentContainerStyle={{ paddingBottom: insets.bottom + 80 }}
    >
      <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
        <View style={[styles.avatar, { backgroundColor: colors.border }]}>
          <Text style={styles.avatarIcon}>👤</Text>
        </View>
        <Text style={[styles.appName, { color: colors.text }]}>Scan Kit</Text>
      </View>

      <View style={[styles.section, { marginBottom: 12 }]}>
        <Text style={[styles.sectionLabel, { color: colors.muted }]}>APPEARANCE</Text>
        <View style={[styles.themeRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {(['system', 'light', 'dark'] as const).map((opt, i) => (
            <Pressable
              key={opt}
              style={[
                styles.themeBtn,
                preference === opt && { backgroundColor: colors.accent },
                i < 2 && { borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.border },
              ]}
              onPress={() => setPreference(opt)}
            >
              <Text style={[styles.themeBtnText, { color: preference === opt ? '#fff' : colors.text }]}>
                {opt === 'system' ? 'Auto' : opt === 'light' ? 'Light' : 'Dark'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={[styles.settingsSection, { backgroundColor: colors.card }]}>
        {ROWS.map((row, i) => (
          <Pressable
            key={row.label}
            style={[styles.row, i === ROWS.length - 1 && styles.rowLast, { borderBottomColor: colors.border }]}
            onPress={() => handleRow(row)}
          >
            <Text style={styles.rowIcon}>{row.icon}</Text>
            <Text style={[styles.rowLabel, { color: colors.text }]}>{row.label}</Text>
            <Text style={[styles.rowChevron, { color: colors.border }]}>›</Text>
          </Pressable>
        ))}
      </View>

      <SortSheet
        visible={sortSheetVisible}
        current={sortKey}
        onSort={handleSort}
        onClose={() => setSortSheetVisible(false)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    alignItems: 'center',
    paddingBottom: 24,
    paddingHorizontal: 20,
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  avatarIcon: { fontSize: 36 },
  appName: { fontSize: 20, fontWeight: '700' },
  section: {
    marginHorizontal: 14,
    borderRadius: 14,
    overflow: 'hidden',
  },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginHorizontal: 14, marginBottom: 6 },
  themeRow: { flexDirection: 'row', marginHorizontal: 14, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  themeBtn: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  themeBtnText: { fontSize: 14, fontWeight: '600' },
  settingsSection: {
    marginHorizontal: 14,
    borderRadius: 14,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 15,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  rowLast: { borderBottomWidth: 0 },
  rowIcon: { fontSize: 20, width: 28, textAlign: 'center' },
  rowLabel: { flex: 1, fontSize: 16 },
  rowChevron: { fontSize: 20 },
});
