// app/(tabs)/tools.tsx
// The Tools tab: every entry opens a working flow. Labels match the title of
// the screen they open.
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { SectionLabel } from '@/components/section-label';
import { Radius, Spacing } from '@/lib/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

type Tool = {
  id: string;
  icon: IconName;
  label: string;
  href: Href;
};

const TOOL_SECTIONS: { title: string; tools: Tool[] }[] = [
  {
    title: 'Scan',
    tools: [
      { id: 'whiteboard', icon: 'easel-outline', label: 'Whiteboard', href: '/tools/whiteboard' },
      { id: 'book', icon: 'book-outline', label: 'Book mode', href: '/tools/book' },
      { id: 'id-card', icon: 'id-card-outline', label: 'ID card', href: '/tools/id-card' },
      { id: 'extract-text', icon: 'text-outline', label: 'Extract text', href: '/tools/extract-text' },
      { id: 'qr', icon: 'qr-code-outline', label: 'QR code', href: '/tools/qr' },
    ],
  },
  {
    title: 'Import',
    tools: [
      {
        id: 'import-photos',
        icon: 'images-outline',
        label: 'Import photos',
        href: { pathname: '/(tabs)/files', params: { action: 'importImages' } } as Href,
      },
      {
        id: 'import-files',
        icon: 'folder-open-outline',
        label: 'Import files',
        href: { pathname: '/(tabs)/files', params: { action: 'importFiles' } } as Href,
      },
    ],
  },
  {
    title: 'Organize',
    tools: [
      { id: 'merge', icon: 'layers-outline', label: 'Merge documents', href: '/tools/merge' },
      { id: 'extract', icon: 'cut-outline', label: 'Extract pages', href: '/tools/extract' },
      { id: 'reorder', icon: 'swap-vertical-outline', label: 'Reorder pages', href: '/tools/reorder' },
      { id: 'compress', icon: 'contract-outline', label: 'Compress', href: '/tools/compress' },
    ],
  },
  {
    title: 'Edit',
    tools: [
      { id: 'sign', icon: 'create-outline', label: 'Sign', href: '/tools/sign' },
      { id: 'watermark', icon: 'water-outline', label: 'Watermark', href: '/tools/watermark' },
      { id: 'timestamp', icon: 'time-outline', label: 'Timestamp', href: '/tools/timestamp' },
      { id: 'erase-marks', icon: 'color-wand-outline', label: 'Erase marks', href: '/tools/erase-marks' },
    ],
  },
  {
    title: 'Share',
    tools: [
      { id: 'long-image', icon: 'image-outline', label: 'Long image', href: '/tools/long-image' },
      { id: 'save-images', icon: 'file-tray-stacked-outline', label: 'Save as images', href: '/tools/save-images' },
      { id: 'print', icon: 'print-outline', label: 'Print', href: '/tools/print' },
    ],
  },
];

function ToolTile({ tool }: { tool: Tool }) {
  const { colors } = useTheme();
  const router = useRouter();
  const isTab = typeof tool.href === 'object';
  return (
    <Pressable
      style={({ pressed }) => [styles.tile, pressed && { opacity: 0.6 }]}
      onPress={() => (isTab ? router.navigate(tool.href) : router.push(tool.href))}
      accessibilityRole="button"
      accessibilityLabel={tool.label}
    >
      <View style={[styles.iconWrap, { backgroundColor: colors.accentLight }]}>
        <Ionicons name={tool.icon} size={26} color={colors.accent} />
      </View>
      <Text style={[styles.label, { color: colors.text }]} numberOfLines={2}>
        {tool.label}
      </Text>
    </Pressable>
  );
}

export default function ToolsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ paddingTop: insets.top + 14, paddingBottom: insets.bottom + 110 }}
      >
        <Text style={[styles.screenTitle, { color: colors.text }]} accessibilityRole="header">
          Tools
        </Text>

        {TOOL_SECTIONS.map(section => (
          <View key={section.title} style={styles.section}>
            <SectionLabel style={styles.sectionLabel}>{section.title}</SectionLabel>
            <View style={[styles.card, { backgroundColor: colors.card }]}>
              {section.tools.map(tool => (
                <ToolTile key={tool.id} tool={tool} />
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
      {/* Opaque mask over the status bar so the scrolling title and section
          labels never pass under the clock and battery. */}
      <View
        style={[styles.statusMask, { height: insets.top, backgroundColor: colors.bg }]}
        pointerEvents="none"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  screenTitle: {
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: -0.5,
    paddingHorizontal: 20,
    marginBottom: Spacing.xs,
  },
  section: { paddingHorizontal: Spacing.gutter },
  sectionLabel: { marginHorizontal: Spacing.xs },
  card: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderRadius: Radius.lg,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.xs,
  },
  tile: {
    width: '25%',
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.xxs,
  },
  iconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  label: { fontSize: 12, lineHeight: 15, textAlign: 'center', fontWeight: '500' },
  statusMask: { position: 'absolute', top: 0, left: 0, right: 0 },
});
