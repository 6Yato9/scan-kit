// components/sort-sheet.tsx
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BottomSheet } from '@/components/bottom-sheet';
import { SortKey } from '@/lib/storage';
import { useTheme } from '@/contexts/theme-context';

type Props = {
  visible: boolean;
  current: SortKey;
  onSort: (key: SortKey) => void;
  onClose: () => void;
};

const OPTIONS: { key: SortKey; label: string; sub: string }[] = [
  { key: 'dateAdded', label: 'Date Added', sub: 'Newest first' },
  { key: 'dateModified', label: 'Last Modified', sub: 'Recently edited first' },
  { key: 'nameAZ', label: 'Name A–Z', sub: 'Alphabetical order' },
];

export function SortSheet({ visible, current, onSort, onClose }: Props) {
  const { colors } = useTheme();
  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={[styles.heading, { color: colors.text }]}>Sort by</Text>
      {OPTIONS.map(({ key, label, sub }) => (
        <Pressable
          key={key}
          style={[styles.option, { borderBottomColor: colors.border }]}
          onPress={() => { onSort(key); onClose(); }}
        >
          <View style={styles.optionText}>
            <Text style={[styles.optionLabel, { color: colors.text }]}>{label}</Text>
            <Text style={[styles.optionSub, { color: colors.faint }]}>{sub}</Text>
          </View>
          {current === key && <Text style={[styles.check, { color: colors.accent }]}>✓</Text>}
        </Pressable>
      ))}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 18, fontWeight: '700', marginBottom: 12 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  optionText: { flex: 1 },
  optionLabel: { fontSize: 16, fontWeight: '500' },
  optionSub: { fontSize: 12, marginTop: 2 },
  check: { fontSize: 18, fontWeight: '700' },
});
