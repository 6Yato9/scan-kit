import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { BottomSheet } from '@/components/bottom-sheet';
import { autoName } from '@/lib/auto-name';
import { useTheme } from '@/contexts/theme-context';

type Props = {
  visible: boolean;
  pageCount: number;
  onSave: (name: string) => void;
  onRetake: () => void;
  onClose: () => void;
};

export function ScanNameSheet({ visible, pageCount, onSave, onRetake, onClose }: Props) {
  const { colors } = useTheme();
  const [name, setName] = useState('');
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible) {
      setName(autoName());
      // delay focus until sheet animation completes
      const t = setTimeout(() => inputRef.current?.focus(), 400);
      return () => clearTimeout(t);
    }
  }, [visible]);

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={[styles.label, { color: colors.muted }]}>
        {pageCount} page{pageCount !== 1 ? 's' : ''} scanned
      </Text>
      <TextInput
        ref={inputRef}
        style={[styles.input, { borderColor: colors.border, color: colors.text, backgroundColor: colors.input }]}
        value={name}
        onChangeText={setName}
        selectTextOnFocus
        returnKeyType="done"
        onSubmitEditing={() => name.trim() && onSave(name.trim())}
      />
      <View style={styles.row}>
        <Pressable style={[styles.secondaryBtn, { backgroundColor: colors.secondary }]} onPress={onRetake}>
          <Text style={[styles.secondaryText, { color: colors.text }]}>Retake</Text>
        </Pressable>
        <Pressable
          style={[styles.primaryBtn, { backgroundColor: colors.accent }, !name.trim() && styles.disabledBtn]}
          onPress={() => name.trim() && onSave(name.trim())}
        >
          <Text style={styles.primaryText}>Save</Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, marginBottom: 10 },
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
  secondaryBtn: {
    flex: 1,
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
  },
  secondaryText: { fontWeight: '600', fontSize: 16 },
});
