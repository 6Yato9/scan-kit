// components/doc-actions-sheet.tsx
import { Pressable, StyleSheet, Text } from 'react-native';
import { BottomSheet } from '@/components/bottom-sheet';
import { Document } from '@/types/document';

type Props = {
  visible: boolean;
  document: Document | null;
  onRename: (doc: Document) => void;
  onDuplicate: (doc: Document) => void;
  onMerge: (doc: Document) => void;
  onSelect: (doc: Document) => void;
  onDelete: (doc: Document) => void;
  onClose: () => void;
  onMoveToFolder?: (doc: Document) => void;
};

export function DocActionsSheet({
  visible,
  document,
  onRename,
  onDuplicate,
  onMerge,
  onSelect,
  onDelete,
  onClose,
}: Props) {
  if (!document) return null;

  function wrap(fn: (doc: Document) => void) {
    return () => { onClose(); fn(document!); };
  }

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={styles.docName} numberOfLines={2}>{document.name}</Text>

      <Pressable style={styles.option} onPress={wrap(onRename)}>
        <Text style={styles.optionText}>Rename</Text>
      </Pressable>

      <Pressable style={styles.option} onPress={wrap(onDuplicate)}>
        <Text style={styles.optionText}>Duplicate</Text>
      </Pressable>

      <Pressable style={styles.option} onPress={wrap(onMerge)}>
        <Text style={styles.optionText}>Merge with…</Text>
      </Pressable>

      <Pressable style={styles.option} onPress={wrap(onSelect)}>
        <Text style={styles.optionText}>Select</Text>
      </Pressable>

      <Pressable style={[styles.option, styles.optionLast]} onPress={wrap(onDelete)}>
        <Text style={[styles.optionText, styles.deleteText]}>Delete</Text>
      </Pressable>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  docName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#888',
    marginBottom: 12,
  },
  option: {
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e8e8e8',
  },
  optionLast: { borderBottomWidth: 0 },
  optionText: { fontSize: 17, color: '#1a1a1a' },
  deleteText: { color: '#cc0000' },
});
