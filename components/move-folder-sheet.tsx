// components/move-folder-sheet.tsx
// Pick a destination folder for one document (or several, via `documents`),
// or create a new folder on the spot.
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { BottomSheet, SheetGroup, SheetHeader, SheetRow } from '@/components/bottom-sheet';
import { PrimaryButton } from '@/components/primary-button';
import { Document } from '@/types/document';
import { useTheme } from '@/contexts/theme-context';
import { Radius, Spacing, Type } from '@/lib/theme';

type Props = {
  visible: boolean;
  document: Document | null;
  /** Bulk mode: move several documents. `onMoveMany` is called instead of `onMove`. */
  documents?: Document[];
  folders: string[];
  onMove: (doc: Document, folder: string | null) => void;
  onMoveMany?: (docs: Document[], folder: string | null) => void;
  /** When provided, offers "New folder" inline; resolves once the folder exists. */
  onCreateFolder?: (name: string) => Promise<void>;
  onClose: () => void;
};

export function MoveFolderSheet({ visible, document, documents, folders, onMove, onMoveMany, onCreateFolder, onClose }: Props) {
  const { colors } = useTheme();
  const bulk = !!documents && documents.length > 0;
  // Keep the last target while the sheet animates out.
  const [shownDoc, setShownDoc] = useState<Document | null>(document);
  useEffect(() => { if (document) setShownDoc(document); }, [document]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewNameState] = useState('');
  const newNameRef = useRef('');
  const setNewName = (v: string) => { newNameRef.current = v; setNewNameState(v); };
  const inputRef = useRef<TextInput>(null);

  useEffect(() => { if (!visible) { setCreating(false); setNewName(''); } }, [visible]);

  if (!bulk && !shownDoc) return null;

  const current = bulk
    ? (documents!.every(d => d.folder === documents![0].folder) ? documents![0].folder ?? null : undefined)
    : shownDoc!.folder ?? null;

  function choose(folder: string | null) {
    if (bulk) onMoveMany?.(documents!, folder);
    else if (shownDoc) onMove(shownDoc, folder);
  }

  async function create() {
    const name = newNameRef.current.trim();
    if (!name || !onCreateFolder) return;
    await onCreateFolder(name);
    choose(name);
  }

  const title = bulk
    ? `Move ${documents!.length} document${documents!.length === 1 ? '' : 's'}`
    : 'Move to folder';

  return (
    <BottomSheet visible={visible} onClose={onClose} variant="grouped">
      <SheetHeader title={title} subtitle={bulk ? undefined : shownDoc!.name} />
      {creating ? (
        <View>
          <TextInput
            ref={inputRef}
            autoFocus
            style={[Type.body, styles.input, { backgroundColor: colors.card, color: colors.text }]}
            value={newName}
            onChangeText={setNewName}
            placeholder="Folder name"
            placeholderTextColor={colors.muted}
            returnKeyType="done"
            onSubmitEditing={create}
            accessibilityLabel="New folder name"
          />
          <View style={styles.row}>
            <PrimaryButton title="Cancel" variant="secondary" onPress={() => setCreating(false)} style={styles.flex} />
            <PrimaryButton title="Create and move" onPress={create} disabled={!newName.trim()} style={styles.flex} />
          </View>
        </View>
      ) : (
        <ScrollView style={styles.scroll} bounces={false}>
          <SheetGroup>
            <SheetRow
              icon="file-tray-outline"
              label="No folder"
              selected={current === null}
              onPress={() => choose(null)}
              last={folders.length === 0}
            />
            {folders.map((f, i) => (
              <SheetRow
                key={f}
                icon="folder-outline"
                label={f}
                selected={current === f}
                onPress={() => choose(f)}
                last={i === folders.length - 1}
              />
            ))}
          </SheetGroup>
          {onCreateFolder && (
            <SheetGroup style={{ marginBottom: 0 }}>
              <SheetRow icon="add" label="New folder" onPress={() => setCreating(true)} last />
            </SheetGroup>
          )}
        </ScrollView>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  input: { borderRadius: Radius.md, paddingHorizontal: Spacing.lg, minHeight: 50, marginBottom: Spacing.lg },
  row: { flexDirection: 'row', gap: Spacing.md },
  flex: { flex: 1 },
});
