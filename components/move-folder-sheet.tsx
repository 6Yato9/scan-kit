// components/move-folder-sheet.tsx
import { Pressable, StyleSheet, Text } from 'react-native';
import { BottomSheet } from '@/components/bottom-sheet';
import { Document } from '@/types/document';
import { useTheme } from '@/contexts/theme-context';

type Props = {
  visible: boolean;
  document: Document | null;
  folders: string[];
  onMove: (doc: Document, folder: string | null) => void;
  onClose: () => void;
};

export function MoveFolderSheet({ visible, document, folders, onMove, onClose }: Props) {
  const { colors } = useTheme();
  if (!document) return null;

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={[styles.heading, { color: colors.muted }]}>Move to Folder</Text>

      <Pressable
        style={[styles.option, { borderBottomColor: colors.border }, document.folder == null && { backgroundColor: colors.accentLight }]}
        onPress={() => onMove(document, null)}
      >
        <Text style={[styles.optionText, { color: colors.text }]}>No folder</Text>
        {document.folder == null && <Text style={[styles.check, { color: colors.accent }]}>✓</Text>}
      </Pressable>

      {folders.map(f => (
        <Pressable
          key={f}
          style={[styles.option, { borderBottomColor: colors.border }, document.folder === f && { backgroundColor: colors.accentLight }]}
          onPress={() => onMove(document, f)}
        >
          <Text style={[styles.optionText, { color: colors.text }]}>{f}</Text>
          {document.folder === f && <Text style={[styles.check, { color: colors.accent }]}>✓</Text>}
        </Pressable>
      ))}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 15, fontWeight: '600', marginBottom: 12 },
  option: {
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  optionText: { fontSize: 17 },
  check: { fontSize: 17 },
});
