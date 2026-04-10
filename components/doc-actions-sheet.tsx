// components/doc-actions-sheet.tsx
import { Pressable, StyleSheet, Text } from 'react-native';
import { BottomSheet } from '@/components/bottom-sheet';
import { Document } from '@/types/document';
import { useTheme } from '@/contexts/theme-context';

type Props = {
  visible: boolean;
  document: Document | null;
  onRename: (doc: Document) => void;
  onDuplicate: (doc: Document) => void;
  onMerge: (doc: Document) => void;
  onMoveToFolder: (doc: Document) => void;
  onSelect: (doc: Document) => void;
  onDelete: (doc: Document) => void;
  onClose: () => void;
};

export function DocActionsSheet({
  visible,
  document,
  onRename,
  onDuplicate,
  onMerge,
  onMoveToFolder,
  onSelect,
  onDelete,
  onClose,
}: Props) {
  const { colors } = useTheme();
  if (!document) return null;

  function wrap(fn: (doc: Document) => void) {
    return () => { onClose(); fn(document!); };
  }

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={[styles.docName, { color: colors.muted }]} numberOfLines={2}>{document.name}</Text>

      <Pressable style={[styles.option, { borderBottomColor: colors.border }]} onPress={wrap(onRename)}>
        <Text style={[styles.optionText, { color: colors.text }]}>Rename</Text>
      </Pressable>

      <Pressable style={[styles.option, { borderBottomColor: colors.border }]} onPress={wrap(onDuplicate)}>
        <Text style={[styles.optionText, { color: colors.text }]}>Duplicate</Text>
      </Pressable>

      <Pressable style={[styles.option, { borderBottomColor: colors.border }]} onPress={wrap(onMerge)}>
        <Text style={[styles.optionText, { color: colors.text }]}>Merge with…</Text>
      </Pressable>

      <Pressable style={[styles.option, { borderBottomColor: colors.border }]} onPress={wrap(onMoveToFolder)}>
        <Text style={[styles.optionText, { color: colors.text }]}>Move to Folder…</Text>
      </Pressable>

      <Pressable style={[styles.option, { borderBottomColor: colors.border }]} onPress={wrap(onSelect)}>
        <Text style={[styles.optionText, { color: colors.text }]}>Select</Text>
      </Pressable>

      <Pressable style={[styles.option, styles.optionLast]} onPress={wrap(onDelete)}>
        <Text style={[styles.optionText, { color: colors.danger }]}>Delete</Text>
      </Pressable>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  docName: { fontSize: 15, fontWeight: '600', marginBottom: 12 },
  option: {
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  optionLast: { borderBottomWidth: 0 },
  optionText: { fontSize: 17 },
});
