// app/(tabs)/tools.tsx
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type Tool = {
  id: string;
  icon: string;
  label: string;
  subtitle: string;
  available: boolean;
  action?: () => void;
};

function ToolCard({ tool }: { tool: Tool }) {
  return (
    <Pressable
      style={[styles.card, !tool.available && styles.cardDisabled]}
      onPress={tool.available ? tool.action : undefined}
    >
      <Text style={styles.cardIcon}>{tool.icon}</Text>
      <Text style={[styles.cardLabel, !tool.available && styles.cardLabelDisabled]}>
        {tool.label}
      </Text>
      {!tool.available && (
        <View style={styles.soonBadge}>
          <Text style={styles.soonText}>Soon</Text>
        </View>
      )}
    </Pressable>
  );
}

export default function ToolsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const sections: { title: string; tools: Tool[] }[] = [
    {
      title: 'SCAN',
      tools: [
        { id: 'idcard', icon: '🪪', label: 'ID Card', subtitle: 'Scan front + back', available: false },
        { id: 'timestamp', icon: '⏰', label: 'Timestamp', subtitle: 'Add date/time', available: false },
      ],
    },
    {
      title: 'IMPORT',
      tools: [
        {
          id: 'import-files',
          icon: '📥',
          label: 'Import Files',
          subtitle: 'PDF or image',
          available: true,
          action: () => router.navigate({ pathname: '/(tabs)/files', params: { action: 'importFiles' } } as any),
        },
        {
          id: 'import-images',
          icon: '🖼',
          label: 'Import Images',
          subtitle: 'From library',
          available: true,
          action: () => router.navigate({ pathname: '/(tabs)/files', params: { action: 'importImages' } } as any),
        },
      ],
    },
    {
      title: 'EDIT',
      tools: [
        { id: 'sign', icon: '✍️', label: 'Sign', subtitle: 'Draw signature', available: false },
        { id: 'watermark', icon: '💧', label: 'Watermark', subtitle: 'Add text', available: false },
        { id: 'extract', icon: '✂️', label: 'Extract Pages', subtitle: 'Split document', available: false },
        { id: 'compress', icon: '🗜', label: 'Compress', subtitle: 'Reduce size', available: false },
        { id: 'lock', icon: '🔒', label: 'Lock PDF', subtitle: 'Add password', available: false },
      ],
    },
    {
      title: 'UTILITIES',
      tools: [
        {
          id: 'print',
          icon: '🖨',
          label: 'Print',
          subtitle: 'Print document',
          available: true,
          action: () =>
            Alert.alert('Print', 'Open a document and tap Export → Print to print from any doc.'),
        },
        { id: 'qr', icon: '📷', label: 'QR / Barcode', subtitle: 'Scan & copy', available: false },
      ],
    },
  ];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 80 }]}
    >
      <Text style={styles.screenTitle}>Tools</Text>

      {sections.map(section => (
        <View key={section.title} style={styles.section}>
          <Text style={styles.sectionTitle}>{section.title}</Text>
          <View style={styles.grid}>
            {section.tools.map(tool => (
              <ToolCard key={tool.id} tool={tool} />
            ))}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111' },
  content: { paddingHorizontal: 16 },
  screenTitle: {
    fontSize: 30,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: -0.5,
    marginBottom: 20,
  },
  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#666',
    letterSpacing: 1,
    marginBottom: 10,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  card: {
    width: '47%',
    backgroundColor: '#1e1e1e',
    borderRadius: 14,
    padding: 16,
    alignItems: 'center',
    position: 'relative',
  },
  cardDisabled: { opacity: 0.5 },
  cardIcon: { fontSize: 30, marginBottom: 6 },
  cardLabel: { fontSize: 13, fontWeight: '700', color: '#fff', textAlign: 'center' },
  cardLabelDisabled: { color: '#aaa' },
  soonBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: '#333',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  soonText: { fontSize: 9, color: '#888', fontWeight: '700' },
});
