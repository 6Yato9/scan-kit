// components/page-actions-sheet.tsx
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';
import { BottomSheet } from '@/components/bottom-sheet';
import { PageFilter } from '@/types/document';
import { filterStyle } from '@/lib/filters';
import { useTheme } from '@/contexts/theme-context';

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
  const { colors } = useTheme();
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
      <Text style={[styles.heading, { color: colors.text }]}>Page Actions</Text>

      {/* Preview */}
      <View style={styles.previewRow}>
        <Image
          source={{ uri }}
          style={[styles.preview, { backgroundColor: colors.secondary }, fStyle ? ({ filter: fStyle } as any) : undefined]}
          resizeMode="contain"
        />
      </View>

      {/* Rotate row */}
      <View style={styles.row}>
        {rotating ? (
          <ActivityIndicator style={{ flex: 1 }} />
        ) : (
          <>
            <Pressable style={[styles.actionBtn, { backgroundColor: colors.actionBtnBg }]} onPress={() => rotate('ccw')}>
              <Text style={[styles.actionIcon, { color: colors.text }]}>↺</Text>
              <Text style={[styles.actionLabel, { color: colors.subtext }]}>Rotate L</Text>
            </Pressable>
            <Pressable style={[styles.actionBtn, { backgroundColor: colors.actionBtnBg }]} onPress={() => rotate('cw')}>
              <Text style={[styles.actionIcon, { color: colors.text }]}>↻</Text>
              <Text style={[styles.actionLabel, { color: colors.subtext }]}>Rotate R</Text>
            </Pressable>
            <Pressable style={[styles.actionBtn, { backgroundColor: colors.actionBtnBg }]} onPress={onShare}>
              <Text style={[styles.actionIcon, { color: colors.text }]}>↑</Text>
              <Text style={[styles.actionLabel, { color: colors.subtext }]}>Share</Text>
            </Pressable>
            <Pressable style={[styles.actionBtn, { backgroundColor: colors.dangerBg }]} onPress={onDelete}>
              <Text style={[styles.actionIcon, { color: colors.danger }]}>✕</Text>
              <Text style={[styles.actionLabel, { color: colors.danger }]}>Delete</Text>
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
              style={[styles.filterTile, { borderColor: filter === key ? colors.accent : 'transparent' }]}
              onPress={() => onFilter(key)}
            >
              <Image
                source={{ uri }}
                style={[styles.filterPreview, { backgroundColor: colors.placeholder }, fs ? ({ filter: fs } as any) : undefined]}
                resizeMode="cover"
              />
              <Text style={[styles.filterLabel, { color: filter === key ? colors.accent : colors.muted }, filter === key && styles.filterLabelActive]}>
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
  heading: { fontSize: 17, fontWeight: '700', marginBottom: 12 },
  previewRow: { alignItems: 'center', marginBottom: 12 },
  preview: { width: 80, height: 100, borderRadius: 4 },
  row: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  actionBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 10,
  },
  actionIcon: { fontSize: 22 },
  actionLabel: { fontSize: 11, marginTop: 2 },
  filterRow: { flexDirection: 'row', gap: 8 },
  filterTile: {
    flex: 1,
    alignItems: 'center',
    borderRadius: 8,
    padding: 4,
    borderWidth: 2,
  },
  filterPreview: { width: '100%', aspectRatio: 0.75, borderRadius: 4 },
  filterLabel: { fontSize: 10, marginTop: 4 },
  filterLabelActive: { fontWeight: '600' },
});
