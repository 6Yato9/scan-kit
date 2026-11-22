// components/rename-sheet.tsx
// Rename a document: text field, then Cancel / Save.
//
// Deleting is not offered next to Save. Callers that still want a delete path
// here (the viewer) pass `onDelete`; it renders as a separate, confirmed row
// below, and the sheet closes before the delete runs so a stale Save can never
// bring the document back.
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { BottomSheet, SheetHeader } from '@/components/bottom-sheet';
import { PrimaryButton } from '@/components/primary-button';
import { Document } from '@/types/document';
import { useTheme } from '@/contexts/theme-context';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

type Props = {
  visible: boolean;
  document: Document | null;
  onRename: (doc: Document, newName: string) => void;
  /** Optional. Shown as a separate, confirmed "Delete document" row. */
  onDelete?: (doc: Document) => void;
  onClose: () => void;
};

export function RenameSheet({ visible, document, onRename, onDelete, onClose }: Props) {
  const { colors } = useTheme();
  const [name, setNameState] = useState('');
  // Mirrors `name` synchronously: Return can fire before the last keystroke
  // re-renders, and saving the state value would drop that character.
  const nameRef = useRef('');
  const setName = (v: string) => { nameRef.current = v; setNameState(v); };
  const inputRef = useRef<TextInput>(null);
  const pendingDelete = useRef<Document | null>(null);

  useEffect(() => {
    if (visible && document) {
      setName(document.name);
      const t = setTimeout(() => inputRef.current?.focus(), 350);
      return () => clearTimeout(t);
    }
  }, [visible, document]);

  const trimmed = name.trim();
  const canSave = !!document && trimmed.length > 0;

  function save() {
    const next = nameRef.current.trim();
    if (!document || !next) return;
    if (next === document.name) { onClose(); return; }
    onRename(document, next);
  }

  function confirmDelete() {
    if (!document || !onDelete) return;
    const doc = document;
    Alert.alert('Delete document?', `“${doc.name}” will be permanently deleted.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          // Close first; the delete runs once the sheet is gone.
          pendingDelete.current = doc;
          onClose();
        },
      },
    ]);
  }

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      onDismissed={() => {
        const doc = pendingDelete.current;
        pendingDelete.current = null;
        if (doc && onDelete) onDelete(doc);
      }}
    >
      <SheetHeader title="Rename document" />
      <View style={[styles.inputWrap, { backgroundColor: colors.input }]}>
        <TextInput
          ref={inputRef}
          style={[Type.body, styles.input, { color: colors.text }]}
          value={name}
          onChangeText={setName}
          selectTextOnFocus
          returnKeyType="done"
          placeholder="Document name"
          placeholderTextColor={colors.muted}
          onSubmitEditing={save}
          accessibilityLabel="Document name"
        />
        {name.length > 0 && (
          <Pressable onPress={() => setName('')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear name">
            <Ionicons name="close-circle" size={18} color={colors.muted} />
          </Pressable>
        )}
      </View>
      <View style={styles.row}>
        <PrimaryButton title="Cancel" variant="secondary" onPress={onClose} style={styles.flex} />
        <PrimaryButton title="Save" onPress={save} disabled={!canSave} style={styles.flex} />
      </View>
      {onDelete && (
        <Pressable
          onPress={confirmDelete}
          style={({ pressed }) => [styles.deleteRow, { borderTopColor: colors.border }, pressed && { opacity: 0.6 }]}
          accessibilityRole="button"
        >
          <Ionicons name="trash-outline" size={18} color={colors.danger} />
          <Text style={[Type.body, { color: colors.danger }]}>Delete document</Text>
        </Pressable>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.lg,
    minHeight: 50,
    gap: Spacing.sm,
    marginBottom: Spacing.lg,
  },
  input: { flex: 1, paddingVertical: Spacing.md },
  row: { flexDirection: 'row', gap: Spacing.md },
  flex: { flex: 1 },
  deleteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    minHeight: HIT,
    marginTop: Spacing.lg,
    paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
