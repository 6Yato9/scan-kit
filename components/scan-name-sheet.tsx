import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { BottomSheet } from '@/components/bottom-sheet';
import { autoName } from '@/lib/auto-name';

type Props = {
  visible: boolean;
  pageCount: number;
  onSave: (name: string) => void;
  onRetake: () => void;
  onClose: () => void;
};

export function ScanNameSheet({ visible, pageCount, onSave, onRetake, onClose }: Props) {
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
      <Text style={styles.label}>
        {pageCount} page{pageCount !== 1 ? 's' : ''} scanned
      </Text>
      <TextInput
        ref={inputRef}
        style={styles.input}
        value={name}
        onChangeText={setName}
        selectTextOnFocus
        returnKeyType="done"
        onSubmitEditing={() => name.trim() && onSave(name.trim())}
      />
      <View style={styles.row}>
        <Pressable style={styles.secondaryBtn} onPress={onRetake}>
          <Text style={styles.secondaryText}>Retake</Text>
        </Pressable>
        <Pressable
          style={[styles.primaryBtn, !name.trim() && styles.disabledBtn]}
          onPress={() => name.trim() && onSave(name.trim())}
        >
          <Text style={styles.primaryText}>Save</Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, color: '#888', marginBottom: 10 },
  input: {
    borderWidth: 1.5,
    borderColor: '#ddd',
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    marginBottom: 18,
    color: '#1a1a1a',
  },
  row: { flexDirection: 'row', gap: 12 },
  primaryBtn: {
    flex: 1,
    backgroundColor: '#0a7ea4',
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
  },
  disabledBtn: { opacity: 0.4 },
  primaryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  secondaryBtn: {
    flex: 1,
    backgroundColor: '#f0f0f0',
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
  },
  secondaryText: { color: '#1a1a1a', fontWeight: '600', fontSize: 16 },
});
