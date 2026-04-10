// components/reorder-modal.tsx
import { Modal, Pressable, SafeAreaView, StyleSheet, Text, View, Image } from 'react-native';
import { useState } from 'react';
import DraggableFlatList, {
  ScaleDecorator,
  RenderItemParams,
} from 'react-native-draggable-flatlist';
import { PageFilter } from '@/types/document';
import { filterStyle } from '@/lib/filters';

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
  const [items, setItems] = useState<PageItem[]>([]);

  function handleShow() {
    setItems(pages.map((uri, index) => ({ index, uri, filter: filters?.[index] })));
  }

  function handleConfirm() {
    onConfirm(items.map(item => item.index));
  }

  const renderItem = ({ item, index, drag, isActive }: RenderItemParams<PageItem>) => {
    const fStyle = filterStyle(item.filter);
    return (
      <ScaleDecorator>
        <Pressable
          style={[styles.row, isActive && styles.rowActive]}
          onLongPress={drag}
          delayLongPress={100}
        >
          <Image
            source={{ uri: item.uri }}
            style={[styles.thumb, fStyle ? ({ filter: fStyle } as any) : undefined]}
            resizeMode="cover"
          />
          <Text style={styles.pageLabel}>Page {index + 1}</Text>
          <Text style={styles.dragHandle}>☰</Text>
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
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={onCancel} hitSlop={12}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>Reorder Pages</Text>
          <Pressable onPress={handleConfirm} hitSlop={12}>
            <Text style={styles.done}>Done</Text>
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
  container: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e8e8e8',
  },
  title: { fontSize: 17, fontWeight: '600', color: '#1a1a1a' },
  cancel: { fontSize: 16, color: '#888' },
  done: { fontSize: 16, color: '#0a7ea4', fontWeight: '600' },
  list: { paddingVertical: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#fff',
    gap: 14,
  },
  rowActive: { backgroundColor: '#f0f8ff' },
  thumb: {
    width: 44,
    height: 58,
    borderRadius: 4,
    backgroundColor: '#e8e8e8',
  },
  pageLabel: { flex: 1, fontSize: 15, color: '#1a1a1a' },
  dragHandle: { fontSize: 20, color: '#ccc' },
});
