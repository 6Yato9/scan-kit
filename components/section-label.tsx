// components/section-label.tsx
// Small caps label above a grouped list or card ("APPEARANCE", "PAGES").
// Text is passed in sentence case; the style uppercases it.
import { StyleSheet, Text, TextStyle } from 'react-native';
import { useTheme } from '@/contexts/theme-context';
import { Spacing, TextScale, Type } from '@/lib/theme';

export function SectionLabel({ children, style }: { children: string; style?: TextStyle }) {
  const { colors } = useTheme();
  // Capped: at the largest text sizes an uncapped label outgrew the content it labels.
  return (
    <Text style={[Type.sectionLabel, styles.label, { color: colors.muted }, style]} maxFontSizeMultiplier={TextScale.label}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  label: { marginTop: Spacing.xxl, marginBottom: Spacing.sm, marginHorizontal: Spacing.xs },
});
