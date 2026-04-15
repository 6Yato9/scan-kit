// app/(tabs)/tools.tsx
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';

type Tool = {
  id: string;
  icon: string;
  label: string;
  color: string;
  soon?: boolean;
  action?: () => void;
};

function ToolItem({ tool }: { tool: Tool }) {
  const { colors, isDark } = useTheme();
  const bg = tool.color + (isDark ? '28' : '1A');

  return (
    <Pressable
      style={styles.toolItem}
      onPress={!tool.soon && tool.action ? tool.action : undefined}
    >
      <View style={[styles.iconWrap, { backgroundColor: bg }, tool.soon && styles.iconSoon]}>
        <MaterialCommunityIcons
          name={tool.icon as any}
          size={26}
          color={tool.soon ? '#555' : tool.color}
        />
        {tool.soon && (
          <View style={styles.soonBadge}>
            <Text style={styles.soonText}>Soon</Text>
          </View>
        )}
      </View>
      <Text
        style={[styles.toolLabel, { color: tool.soon ? colors.faint : colors.text }]}
        numberOfLines={2}
      >
        {tool.label}
      </Text>
    </Pressable>
  );
}

export default function ToolsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const router = useRouter();

  const sections: { title: string; tools: Tool[] }[] = [
    {
      title: 'Scan',
      tools: [
        {
          id: 'idcard',
          icon: 'card-account-details-outline',
          label: 'ID Card',
          color: '#26C6A6',
          action: () => router.push('/tools/id-card'),
        },
        {
          id: 'ocr',
          icon: 'text-recognition',
          label: 'Extract Text',
          color: '#66BB6A',
          action: () =>
            Alert.alert(
              'Extract Text',
              'Open any document in the viewer and tap the T button in the header to extract text with OCR.',
            ),
        },
        {
          id: 'qr',
          icon: 'qrcode-scan',
          label: 'QR / Barcode',
          color: '#42A5F5',
          action: () => router.push('/tools/qr'),
        },
        {
          id: 'timestamp',
          icon: 'calendar-clock',
          label: 'Timestamp',
          color: '#CE93D8',
          action: () => router.push('/tools/timestamp'),
        },
        {
          id: 'whiteboard',
          icon: 'presentation',
          label: 'Whiteboard',
          color: '#4FC3F7',
          action: () => router.push('/tools/whiteboard'),
        },
        {
          id: 'book',
          icon: 'book-open-page-variant',
          label: 'Book Mode',
          color: '#FFA726',
          soon: true,
        },
      ],
    },
    {
      title: 'Import',
      tools: [
        {
          id: 'import-images',
          icon: 'image-multiple-outline',
          label: 'Import Images',
          color: '#26C6A6',
          action: () =>
            router.navigate({
              pathname: '/(tabs)/files',
              params: { action: 'importImages' },
            } as any),
        },
        {
          id: 'import-files',
          icon: 'file-import-outline',
          label: 'Import Files',
          color: '#42A5F5',
          action: () =>
            router.navigate({
              pathname: '/(tabs)/files',
              params: { action: 'importFiles' },
            } as any),
        },
      ],
    },
    {
      title: 'Convert',
      tools: [
        {
          id: 'pdf-to-images',
          icon: 'file-image-outline',
          label: 'PDF to Images',
          color: '#FFA726',
          action: () =>
            Alert.alert(
              'PDF to Images',
              'Open a document and tap Export → Export as ZIP to save all pages as JPEG images.',
            ),
        },
        {
          id: 'pdf-to-long',
          icon: 'arrow-expand-vertical',
          label: 'PDF to Long Image',
          color: '#AB47BC',
          action: () => router.push('/tools/long-image'),
        },
      ],
    },
    {
      title: 'Edit',
      tools: [
        {
          id: 'sign',
          icon: 'draw',
          label: 'Sign',
          color: '#CE93D8',
          action: () => router.push('/tools/sign'),
        },
        {
          id: 'watermark',
          icon: 'watermark',
          label: 'Add Watermark',
          color: '#42A5F5',
          action: () => router.push('/tools/watermark'),
        },
        {
          id: 'merge',
          icon: 'merge',
          label: 'Merge Files',
          color: '#26C6A6',
          action: () => router.push('/tools/merge'),
        },
        {
          id: 'extract',
          icon: 'content-cut',
          label: 'Extract Pages',
          color: '#FFA726',
          action: () => router.push('/tools/extract'),
        },
        {
          id: 'reorder',
          icon: 'reorder-horizontal',
          label: 'Reorder Pages',
          color: '#66BB6A',
          action: () =>
            Alert.alert(
              'Reorder Pages',
              'Open a document in the viewer and tap the reorder icon to drag and rearrange pages.',
            ),
        },
        {
          id: 'compress',
          icon: 'zip-box-outline',
          label: 'Compress PDF',
          color: '#90A4AE',
          action: () => router.push('/tools/compress'),
        },
        {
          id: 'lock',
          icon: 'file-lock-outline',
          label: 'Lock PDF',
          color: '#90A4AE',
          action: () =>
            Alert.alert(
              'Lock PDF',
              'PDF password protection is not supported natively on iOS. Export your PDF and use a PDF editor app to add a password.',
            ),
        },
        {
          id: 'erase-marks',
          icon: 'eraser-variant',
          label: 'Erase Marks',
          color: '#FF8A65',
          soon: true,
        },
      ],
    },
    {
      title: 'Utilities',
      tools: [
        {
          id: 'print',
          icon: 'printer-outline',
          label: 'Print',
          color: '#90A4AE',
          action: () =>
            Alert.alert('Print', 'Open a document and tap Export → Print to send to a printer.'),
        },
        {
          id: 'ask-ai',
          icon: 'robot-outline',
          label: 'Ask AI',
          color: '#CE93D8',
          soon: true,
        },
      ],
    },
  ];

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.bg }]}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 110 },
      ]}
    >
      <Text style={[styles.screenTitle, { color: colors.text }]}>Tools</Text>

      {sections.map(section => (
        <View key={section.title} style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>{section.title}</Text>
          <View style={styles.grid}>
            {section.tools.map(tool => (
              <ToolItem key={tool.id} tool={tool} />
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
  section: { marginBottom: 28 },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 16,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  toolItem: {
    width: '25%',
    alignItems: 'center',
    marginBottom: 20,
  },
  iconWrap: {
    width: 60,
    height: 60,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  iconSoon: { opacity: 0.45 },
  toolLabel: {
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 15,
    paddingHorizontal: 2,
  },
  soonBadge: {
    position: 'absolute',
    top: -5,
    right: -5,
    backgroundColor: '#FFA726',
    borderRadius: 5,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  soonText: { fontSize: 8, fontWeight: '800', color: '#000' },
});
