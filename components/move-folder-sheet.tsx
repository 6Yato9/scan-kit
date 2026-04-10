// components/move-folder-sheet.tsx
import { Pressable, StyleSheet, Text } from 'react-native';
import { BottomSheet } from '@/components/bottom-sheet';
import { Document } from '@/types/document';

type Props = {
  visible: boolean;
  document: Document | null;
  folders: string[];
  onMove: (doc: Document, folder: string | null) => void;
  onClose: () => void;
};

export function MoveFolderSheet({ visible, document, folders, onMove, onClose }: Props) {
  if (!document) return null;

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={styles.heading}>Move to Folder</Text>

      <Pressable
        style={[styles.option, document.folder === undefined && styles.optionActive]}
        onPress={() => onMove(document, null)}
      >
        <Text style={styles.optionText}>No folder</Text>
        {document.folder === undefined && <Text style={styles.check}>✓</Text>}
      </Pressable>

      {folders.map(f => (
        <Pressable
          key={f}
          style={[styles.option, document.folder === f && styles.optionActive]}
          onPress={() => onMove(document, f)}
        >
          <Text style={styles.optionText}>{f}</Text>
          {document.folder === f && <Text style={styles.check}>✓</Text>}
        </Pressable>
      ))}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 15, fontWeight: '600', color: '#888', marginBottom: 12 },
  option: {
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e8e8e8',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  optionActive: { backgroundColor: '#f0f8ff' },
  optionText: { fontSize: 17, color: '#1a1a1a' },
  check: { fontSize: 17, color: '#0a7ea4' },
});
