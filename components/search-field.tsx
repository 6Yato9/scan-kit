// components/search-field.tsx
// Search field with a leading search icon (Files, and anywhere a list is searched).
import type { Ref } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { Radius, Spacing, Type } from '@/lib/theme';

export function SearchField({
  value,
  onChangeText,
  placeholder = 'Search documents and text',
  inputRef,
}: {
  value: string;
  onChangeText: (s: string) => void;
  placeholder?: string;
  /** To focus the field from outside (Home's search button). */
  inputRef?: Ref<TextInput>;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.search, { backgroundColor: colors.input }]}>
      <Ionicons name="search" size={17} color={colors.muted} />
      <TextInput
        ref={inputRef}
        style={[Type.body, styles.input, { color: colors.text }]}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        value={value}
        onChangeText={onChangeText}
        clearButtonMode="while-editing"
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="none"
        accessibilityLabel="Search documents"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    height: 40,
  },
  input: { flex: 1, paddingVertical: 0, height: 40 },
});
