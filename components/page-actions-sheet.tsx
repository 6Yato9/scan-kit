// components/page-actions-sheet.tsx
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';
import { BottomSheet } from '@/components/bottom-sheet';
import { PageFilter } from '@/types/document';
import { filterStyle } from '@/lib/filters';

type Props = {
  visible: boolean;
  uri: string;
  filter: PageFilter;
  onRotate: (direction: 'cw' | 'ccw') => Promise<void>;
  onFilter: (filter: PageFilter) => void;
  onDelete: () => void;
  onShare: () => void;
  onClose: () => void;
};

const FILTERS: { key: PageFilter; label: string }[] = [
  { key: 'original', label: 'Original' },
  { key: 'grayscale', label: 'Grayscale' },
  { key: 'bw', label: 'B&W' },
  { key: 'enhanced', label: 'Enhanced' },
];

export function PageActionsSheet({
  visible,
  uri,
  filter,
  onRotate,
  onFilter,
  onDelete,
  onShare,
  onClose,
}: Props) {
  const [rotating, setRotating] = useState(false);

  async function rotate(direction: 'cw' | 'ccw') {
    setRotating(true);
    try {
      await onRotate(direction);
    } finally {
      setRotating(false);
    }
  }

  const fStyle = filterStyle(filter);

  return (
    <BottomSheet visible={visible} onClose={rotating ? undefined : onClose}>
      <Text style={styles.heading}>Page Actions</Text>

      {/* Preview */}
      <View style={styles.previewRow}>
        <Image
          source={{ uri }}
          style={[styles.preview, fStyle ? ({ filter: fStyle } as any) : undefined]}
          resizeMode="contain"
        />
      </View>

      {/* Rotate row */}
      <View style={styles.row}>
        {rotating ? (
          <ActivityIndicator style={{ flex: 1 }} />
        ) : (
          <>
            <Pressable style={styles.actionBtn} onPress={() => rotate('ccw')}>
              <Text style={styles.actionIcon}>↺</Text>
              <Text style={styles.actionLabel}>Rotate L</Text>
            </Pressable>
            <Pressable style={styles.actionBtn} onPress={() => rotate('cw')}>
              <Text style={styles.actionIcon}>↻</Text>
              <Text style={styles.actionLabel}>Rotate R</Text>
            </Pressable>
            <Pressable style={styles.actionBtn} onPress={onShare}>
              <Text style={styles.actionIcon}>↑</Text>
              <Text style={styles.actionLabel}>Share</Text>
            </Pressable>
            <Pressable style={[styles.actionBtn, styles.deleteAction]} onPress={onDelete}>
              <Text style={[styles.actionIcon, styles.deleteIcon]}>✕</Text>
              <Text style={[styles.actionLabel, styles.deleteLabel]}>Delete</Text>
            </Pressable>
          </>
        )}
      </View>

      {/* Filter strip */}
      <View style={styles.filterRow}>
        {FILTERS.map(({ key, label }) => {
          const fs = filterStyle(key);
          return (
            <Pressable
              key={key}
              style={[styles.filterTile, filter === key && styles.filterTileActive]}
              onPress={() => onFilter(key)}
            >
              <Image
                source={{ uri }}
                style={[styles.filterPreview, fs ? ({ filter: fs } as any) : undefined]}
                resizeMode="cover"
              />
              <Text style={[styles.filterLabel, filter === key && styles.filterLabelActive]}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 17, fontWeight: '700', marginBottom: 12, color: '#1a1a1a' },
  previewRow: { alignItems: 'center', marginBottom: 12 },
  preview: { width: 80, height: 100, borderRadius: 4, backgroundColor: '#f0f0f0' },
  row: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  actionBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    backgroundColor: '#f5f5f5',
    borderRadius: 10,
  },
  actionIcon: { fontSize: 22, color: '#1a1a1a' },
  actionLabel: { fontSize: 11, color: '#555', marginTop: 2 },
  deleteAction: { backgroundColor: '#fff0f0' },
  deleteIcon: { color: '#cc0000' },
  deleteLabel: { color: '#cc0000' },
  filterRow: { flexDirection: 'row', gap: 8 },
  filterTile: {
    flex: 1,
    alignItems: 'center',
    borderRadius: 8,
    padding: 4,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  filterTileActive: { borderColor: '#0a7ea4' },
  filterPreview: { width: '100%', aspectRatio: 0.75, borderRadius: 4, backgroundColor: '#e8e8e8' },
  filterLabel: { fontSize: 10, color: '#888', marginTop: 4 },
  filterLabelActive: { color: '#0a7ea4', fontWeight: '600' },
});
