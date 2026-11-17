import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { BottomSheet } from '@/components/bottom-sheet';
import { Document } from '@/types/document';
import { useTheme } from '@/contexts/theme-context';

type Props = {
  visible: boolean;
  document: Document | null;
  onRename: (doc: Document, newName: string) => void;
  onDelete: (doc: Document) => void;
  onClose: () => void;
};

export function RenameSheet({ visible, document, onRename, onDelete, onClose }: Props) {
  const { colors } = useTheme();
  const [name, setName] = useState('');
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible && document) {
      setName(document.name);
      const t = setTimeout(() => inputRef.current?.focus(), 400);
      return () => clearTimeout(t);
    }
  }, [visible, document]);

  function handleDelete() {
    if (!document) return;
    Alert.alert('Delete document?', `"${document.name}" will be permanently deleted.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => onDelete(document),
      },
    ]);
  }

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={[styles.heading, { color: colors.text }]}>Rename document</Text>
      <TextInput
        ref={inputRef}
        style={[styles.input, { borderColor: colors.border, color: colors.text, backgroundColor: colors.input }]}
        value={name}
        onChangeText={setName}
        selectTextOnFocus
        returnKeyType="done"
        onSubmitEditing={() => document && name.trim() && onRename(document, name.trim())}
      />
      <View style={styles.row}>
        <Pressable style={[styles.deleteBtn, { backgroundColor: colors.dangerBg, borderColor: colors.dangerBorder }]} onPress={handleDelete}>
          <Text style={[styles.deleteText, { color: colors.danger }]}>Delete</Text>
        </Pressable>
        <Pressable
          style={[styles.primaryBtn, { backgroundColor: colors.accent }, !name.trim() && styles.disabledBtn]}
          onPress={() => document && name.trim() && onRename(document, name.trim())}
        >
          <Text style={styles.primaryText}>Save</Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 17, fontWeight: '700', marginBottom: 14 },
  input: {
    borderWidth: 1.5,
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    marginBottom: 18,
  },
  row: { flexDirection: 'row', gap: 12 },
  primaryBtn: {
    flex: 1,
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
  },
  disabledBtn: { opacity: 0.4 },
  primaryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  deleteBtn: {
    flex: 1,
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
    borderWidth: 1.5,
  },
  deleteText: { fontWeight: '600', fontSize: 16 },
});
