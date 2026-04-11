// app/(tabs)/tools.tsx
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';

type Tool = {
  id: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  subtitle: string;
  available: boolean;
  action?: () => void;
};

function ToolCard({ tool }: { tool: Tool }) {
  const { colors, isDark } = useTheme();
  const iconColor = tool.available
    ? (isDark ? '#e0e0e0' : '#1a1a1a')
    : (isDark ? '#555' : '#bbb');
  return (
    <Pressable
      style={[styles.card, { backgroundColor: colors.card }, !tool.available && styles.cardDisabled]}
      onPress={tool.available ? tool.action : undefined}
    >
      <Ionicons name={tool.icon} size={28} color={iconColor} style={styles.cardIcon} />
      <Text style={[styles.cardLabel, { color: tool.available ? colors.text : colors.faint }]}>
        {tool.label}
      </Text>
      <Text style={[styles.cardSub, { color: colors.faint }]}>{tool.subtitle}</Text>
      {!tool.available && (
        <View style={[styles.soonBadge, { backgroundColor: colors.secondary }]}>
          <Text style={[styles.soonText, { color: colors.muted }]}>Soon</Text>
        </View>
      )}
    </Pressable>
  );
}

export default function ToolsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const router = useRouter();

  const sections: { title: string; tools: Tool[] }[] = [
    {
      title: 'IMPORT',
      tools: [
        {
          id: 'import-images',
          icon: 'images-outline',
          label: 'Import Images',
          subtitle: 'From photo library',
          available: true,
          action: () => router.navigate({ pathname: '/(tabs)/files', params: { action: 'importImages' } } as any),
        },
        {
          id: 'import-files',
          icon: 'cloud-download-outline',
          label: 'Import Files',
          subtitle: 'PDF or image',
          available: true,
          action: () => router.navigate({ pathname: '/(tabs)/files', params: { action: 'importFiles' } } as any),
        },
      ],
    },
    {
      title: 'EXPORT',
      tools: [
        {
          id: 'export-pdf',
          icon: 'document-text-outline',
          label: 'Export PDF',
          subtitle: 'Save as PDF file',
          available: true,
          action: () => Alert.alert('Export PDF', 'Open any document, then tap Export → Export as PDF.'),
        },
        {
          id: 'export-jpeg',
          icon: 'image-outline',
          label: 'Export JPEG',
          subtitle: 'Save as images',
          available: true,
          action: () => Alert.alert('Export JPEG', 'Open any document, then tap Export → Export as JPEG.'),
        },
        {
          id: 'print',
          icon: 'print-outline',
          label: 'Print',
          subtitle: 'Send to printer',
          available: true,
          action: () => Alert.alert('Print', 'Open any document, then tap Export → Print.'),
        },
        {
          id: 'share',
          icon: 'share-social-outline',
          label: 'Share',
          subtitle: 'Share document',
          available: true,
          action: () => Alert.alert('Share', 'Open any document and tap Export to share.'),
        },
      ],
    },
    {
      title: 'SCAN',
      tools: [
        {
          id: 'idcard',
          icon: 'card-outline',
          label: 'ID Card',
          subtitle: 'Scan front + back',
          available: true,
          action: () => router.push('/tools/id-card'),
        },
        {
          id: 'qr',
          icon: 'qr-code-outline',
          label: 'QR / Barcode',
          subtitle: 'Scan & copy',
          available: true,
          action: () => router.push('/tools/qr'),
        },
        {
          id: 'timestamp',
          icon: 'time-outline',
          label: 'Timestamp',
          subtitle: 'Add date/time',
          available: true,
          action: () => router.push('/tools/timestamp'),
        },
      ],
    },
    {
      title: 'EDIT',
      tools: [
        {
          id: 'sign',
          icon: 'create-outline',
          label: 'Sign',
          subtitle: 'Draw signature',
          available: true,
          action: () => router.push('/tools/sign'),
        },
        {
          id: 'watermark',
          icon: 'water-outline',
          label: 'Watermark',
          subtitle: 'Add text overlay',
          available: true,
          action: () => router.push('/tools/watermark'),
        },
        {
          id: 'extract',
          icon: 'cut-outline',
          label: 'Extract Pages',
          subtitle: 'Split document',
          available: true,
          action: () => router.push('/tools/extract'),
        },
        {
          id: 'compress',
          icon: 'archive-outline',
          label: 'Compress',
          subtitle: 'Reduce file size',
          available: true,
          action: () => router.push('/tools/compress'),
        },
        {
          id: 'lock',
          icon: 'lock-closed-outline',
          label: 'Lock PDF',
          subtitle: 'Password protect',
          available: true,
          action: () => Alert.alert(
            'Lock PDF',
            'PDF password protection is not supported natively on iOS/Android. To password-protect a PDF, use "Export PDF" to save it, then open it in Files and use a PDF editor app.'
          ),
        },
      ],
    },
  ];

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.bg }]}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 110 }]}
    >
      <Text style={[styles.screenTitle, { color: colors.text }]}>Tools</Text>

      {sections.map(section => (
        <View key={section.title} style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.muted }]}>{section.title}</Text>
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
  container: { flex: 1 },
  content: { paddingHorizontal: 16 },
  screenTitle: {
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: -0.5,
    marginBottom: 20,
  },
  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
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
    borderRadius: 14,
    padding: 16,
    alignItems: 'center',
    position: 'relative',
  },
  cardDisabled: { opacity: 0.45 },
  cardIcon: { marginBottom: 8 },
  cardLabel: { fontSize: 13, fontWeight: '700', textAlign: 'center' },
  cardSub: { fontSize: 11, marginTop: 2, textAlign: 'center' },
  soonBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  soonText: { fontSize: 9, fontWeight: '700' },
});
