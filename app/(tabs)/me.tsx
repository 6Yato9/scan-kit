// app/(tabs)/me.tsx
import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SortSheet } from '@/components/sort-sheet';
import { getSortPreference, saveSortPreference, SortKey } from '@/lib/storage';

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
      style={styles.container}
      contentContainerStyle={{ paddingBottom: insets.bottom + 80 }}
    >
      <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
        <View style={styles.avatar}>
          <Text style={styles.avatarIcon}>👤</Text>
        </View>
        <Text style={styles.appName}>Scan Kit</Text>
      </View>

      <View style={styles.section}>
        {ROWS.map((row, i) => (
          <Pressable
            key={row.label}
            style={[styles.row, i === ROWS.length - 1 && styles.rowLast]}
            onPress={() => handleRow(row)}
          >
            <Text style={styles.rowIcon}>{row.icon}</Text>
            <Text style={styles.rowLabel}>{row.label}</Text>
            <Text style={styles.rowChevron}>›</Text>
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
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  header: {
    alignItems: 'center',
    paddingBottom: 24,
    paddingHorizontal: 20,
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#e0e0e0',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  avatarIcon: { fontSize: 36 },
  appName: { fontSize: 20, fontWeight: '700', color: '#1a1a1a' },
  section: {
    backgroundColor: '#fff',
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
    borderBottomColor: '#e8e8e8',
    gap: 12,
  },
  rowLast: { borderBottomWidth: 0 },
  rowIcon: { fontSize: 20, width: 28, textAlign: 'center' },
  rowLabel: { flex: 1, fontSize: 16, color: '#1a1a1a' },
  rowChevron: { fontSize: 20, color: '#ccc' },
});
