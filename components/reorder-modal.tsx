// components/reorder-modal.tsx
import { Modal, Pressable, SafeAreaView, StyleSheet, Text, View, Image } from 'react-native';
import { useEffect, useState } from 'react';
import DraggableFlatList, {
  ScaleDecorator,
  RenderItemParams,
} from 'react-native-draggable-flatlist';
import { PageFilter } from '@/types/document';
import { filterStyle } from '@/lib/filters';
import { useTheme } from '@/contexts/theme-context';

type PageItem = {
  index: number;
  uri: string;
  filter?: PageFilter;
};

type Props = {
  visible: boolean;
  pages: string[];
  filters?: PageFilter[];
  onConfirm: (newOrderIndices: number[]) => void;
  onCancel: () => void;
};

export function ReorderModal({ visible, pages, filters, onConfirm, onCancel }: Props) {
  const { colors } = useTheme();
  const [items, setItems] = useState<PageItem[]>([]);

  // Re-init whenever the modal becomes visible OR the underlying pages change.
  // (Relying solely on `onShow` left the modal showing stale state if the doc
  // changed between opens.)
  useEffect(() => {
    if (!visible) return;
    setItems(pages.map((uri, index) => ({ index, uri, filter: filters?.[index] })));
  }, [visible, pages, filters]);

  function handleShow() {
    setItems(pages.map((uri, index) => ({ index, uri, filter: filters?.[index] })));
  }

  function handleConfirm() {
    onConfirm(items.map(item => item.index));
  }

  const renderItem = ({ item, getIndex, drag, isActive }: RenderItemParams<PageItem>) => {
    const fStyle = filterStyle(item.filter);
    return (
      <ScaleDecorator>
        <Pressable
          style={[styles.row, { backgroundColor: isActive ? colors.accentLight : colors.card }]}
          onLongPress={drag}
          delayLongPress={100}
        >
          <Image
            source={{ uri: item.uri }}
            style={[styles.thumb, { backgroundColor: colors.placeholder }, fStyle ? ({ filter: fStyle } as any) : undefined]}
            resizeMode="cover"
          />
          <Text style={[styles.pageLabel, { color: colors.text }]}>Page {(getIndex() ?? 0) + 1}</Text>
          <Text style={[styles.dragHandle, { color: colors.border }]}>☰</Text>
        </Pressable>
      </ScaleDecorator>
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onShow={handleShow}
      onRequestClose={onCancel}
    >
      <SafeAreaView style={[styles.container, { backgroundColor: colors.card }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Pressable onPress={onCancel} hitSlop={12}>
            <Text style={[styles.cancel, { color: colors.muted }]}>Cancel</Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>Reorder Pages</Text>
          <Pressable onPress={handleConfirm} hitSlop={12}>
            <Text style={[styles.done, { color: colors.accent }]}>Done</Text>
          </Pressable>
        </View>
        <DraggableFlatList
          data={items}
          onDragEnd={({ data }) => setItems(data)}
          keyExtractor={item => String(item.index)}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 17, fontWeight: '600' },
  cancel: { fontSize: 16 },
  done: { fontSize: 16, fontWeight: '600' },
  list: { paddingVertical: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 14,
  },
  thumb: {
    width: 44,
    height: 58,
    borderRadius: 4,
  },
  pageLabel: { flex: 1, fontSize: 15 },
  dragHandle: { fontSize: 20 },
});
