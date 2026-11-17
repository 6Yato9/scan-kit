// components/section-label.tsx
// Small caps label above a grouped list or card ("APPEARANCE", "PAGES").
// Text is passed in sentence case; the style uppercases it.
import { StyleSheet, Text, TextStyle } from 'react-native';
import { useTheme } from '@/contexts/theme-context';
import { Spacing, Type } from '@/lib/theme';

export function SectionLabel({ children, style }: { children: string; style?: TextStyle }) {
  const { colors } = useTheme();
  return <Text style={[Type.sectionLabel, styles.label, { color: colors.muted }, style]}>{children}</Text>;
}

const styles = StyleSheet.create({
  label: { marginTop: Spacing.xxl, marginBottom: Spacing.sm, marginHorizontal: Spacing.xs },
});
