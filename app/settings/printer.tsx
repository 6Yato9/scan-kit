// app/settings/printer.tsx
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';

export default function PrinterScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  return (
    <View style={[styles.container, { backgroundColor: colors.bg, paddingTop: insets.top + 20 }]}>
      <Ionicons name="print-outline" size={48} color={colors.muted} style={styles.icon} />
      <Text style={[styles.heading, { color: colors.text }]}>Printer Selection</Text>
      <Text style={[styles.body, { color: colors.subtext }]}>
        Printer selection is managed by your device. Tap{' '}
        <Text style={styles.bold}>Export → Print</Text> from any document to open
        the system print dialog and choose your printer.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', paddingHorizontal: 32 },
  icon: { marginBottom: 16 },
  heading: { fontSize: 20, fontWeight: '700', marginBottom: 12 },
  body: { fontSize: 15, textAlign: 'center', lineHeight: 22 },
  bold: { fontWeight: '700' },
});
