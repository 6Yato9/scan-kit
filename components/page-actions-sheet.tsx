// components/page-actions-sheet.tsx
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';
import { BottomSheet } from '@/components/bottom-sheet';
import { PageFilter, PageAdjustment } from '@/types/document';
import { combinedFilterStyle } from '@/lib/filters';
import { SimpleSlider } from '@/components/simple-slider';
import { useTheme } from '@/contexts/theme-context';

type Props = {
  visible: boolean;
  uri: string;
  filter: PageFilter;
  adjustment?: PageAdjustment;
  onRotate: (direction: 'cw' | 'ccw') => Promise<void>;
  onFilter: (filter: PageFilter) => void;
  onAdjust: (adj: PageAdjustment) => void;
  onAnnotate: () => void;
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

const DEFAULT_ADJ: PageAdjustment = { brightness: 0, contrast: 0, saturation: 0 };

type Tab = 'filter' | 'adjust';

export function PageActionsSheet({
  visible,
  uri,
  filter,
  adjustment,
  onRotate,
  onFilter,
  onAdjust,
  onAnnotate,
  onDelete,
  onShare,
  onClose,
}: Props) {
  const { colors } = useTheme();
  const [rotating, setRotating] = useState(false);
  const [tab, setTab] = useState<Tab>('filter');

  async function rotate(direction: 'cw' | 'ccw') {
    setRotating(true);
    try {
      await onRotate(direction);
    } finally {
      setRotating(false);
    }
  }

  const adj = adjustment ?? DEFAULT_ADJ;

  return (
    <BottomSheet visible={visible} onClose={rotating ? undefined : onClose} transparentBackdrop>
      {/* Action buttons */}
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
            <Pressable style={[styles.actionBtn, { backgroundColor: colors.actionBtnBg }]} onPress={() => { onClose(); onAnnotate(); }}>
              <Text style={[styles.actionIcon, { color: colors.text }]}>✏️</Text>
              <Text style={[styles.actionLabel, { color: colors.subtext }]}>Annotate</Text>
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

      {/* Tabs */}
      <View style={[styles.tabRow, { backgroundColor: colors.secondary }]}>
        <Pressable
          style={[styles.tab, tab === 'filter' && { backgroundColor: colors.card }]}
          onPress={() => setTab('filter')}
        >
          <Text style={[styles.tabText, { color: tab === 'filter' ? colors.accent : colors.muted }]}>Filter</Text>
        </Pressable>
        <Pressable
          style={[styles.tab, tab === 'adjust' && { backgroundColor: colors.card }]}
          onPress={() => setTab('adjust')}
        >
          <Text style={[styles.tabText, { color: tab === 'adjust' ? colors.accent : colors.muted }]}>Adjust</Text>
        </Pressable>
      </View>

      {/* Tab content */}
      {tab === 'filter' ? (
        <View style={styles.filterRow}>
          {FILTERS.map(({ key, label }) => {
            const fs = combinedFilterStyle(key, adjustment);
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
      ) : (
        <View style={styles.adjustPanel}>
          <SimpleSlider
            label="Brightness"
            value={adj.brightness}
            onValueChange={v => onAdjust({ ...adj, brightness: v })}
          />
          <SimpleSlider
            label="Contrast"
            value={adj.contrast}
            onValueChange={v => onAdjust({ ...adj, contrast: v })}
          />
          <SimpleSlider
            label="Saturation"
            value={adj.saturation}
            onValueChange={v => onAdjust({ ...adj, saturation: v })}
          />
          {(adj.brightness !== 0 || adj.contrast !== 0 || adj.saturation !== 0) && (
            <Pressable onPress={() => onAdjust(DEFAULT_ADJ)} style={styles.resetBtn}>
              <Text style={[styles.resetText, { color: colors.muted }]}>Reset all</Text>
            </Pressable>
          )}
        </View>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
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
  actionIcon: { fontSize: 18 },
  actionLabel: { fontSize: 10, marginTop: 2 },
  tabRow: {
    flexDirection: 'row',
    borderRadius: 10,
    padding: 3,
    marginBottom: 14,
  },
  tab: {
    flex: 1,
    paddingVertical: 7,
    alignItems: 'center',
    borderRadius: 8,
  },
  tabText: { fontSize: 13, fontWeight: '600' },
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
  adjustPanel: { paddingHorizontal: 4 },
  resetBtn: { alignSelf: 'center', marginTop: 8, paddingVertical: 6, paddingHorizontal: 16 },
  resetText: { fontSize: 13 },
});
