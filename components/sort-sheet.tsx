// components/sort-sheet.tsx
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BottomSheet } from '@/components/bottom-sheet';
import { SortKey } from '@/lib/storage';

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
  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={styles.heading}>Sort by</Text>
      {OPTIONS.map(({ key, label, sub }) => (
        <Pressable
          key={key}
          style={styles.option}
          onPress={() => { onSort(key); onClose(); }}
        >
          <View style={styles.optionText}>
            <Text style={styles.optionLabel}>{label}</Text>
            <Text style={styles.optionSub}>{sub}</Text>
          </View>
          {current === key && <Text style={styles.check}>✓</Text>}
        </Pressable>
      ))}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 18, fontWeight: '700', marginBottom: 12, color: '#1a1a1a' },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e8e8e8',
  },
  optionText: { flex: 1 },
  optionLabel: { fontSize: 16, fontWeight: '500', color: '#1a1a1a' },
  optionSub: { fontSize: 12, color: '#999', marginTop: 2 },
  check: { fontSize: 18, color: '#0a7ea4', fontWeight: '700' },
});
