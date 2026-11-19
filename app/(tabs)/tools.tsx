// app/(tabs)/tools.tsx
// The Tools tab: every entry opens a working flow. Labels match the title of
// the screen they open and fit on one line.
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { SectionLabel } from '@/components/section-label';
import { LargeTitle } from '@/components/screen-header';
import { AppIcon, type AppIconName } from '@/components/app-icon';
import { Radius, Spacing, TAB_BAR_CLEARANCE } from '@/lib/theme';

type Tool = {
  id: string;
  icon: AppIconName;
  label: string;
  href: Href;
};

// Genuine tools only. Anything the core screens already do lives there instead:
// import (Files "+"), reorder / rotate / text (viewer) and print / save as
// images (Export). Every section is one or two full rows of four, so icons
// line up down the screen. Pages holds what makes or takes apart documents
// (Merge, Create PDF, Split, Extract pages); PDF holds what changes the file
// itself (Compress, Unlock, Protect, Flatten). The whole-document verbs also
// live in Files' select mode and the viewer's "…" menu, so they can be found
// without knowing those places. Flatten uses the layers glyph of Share's
// "Flattened PDF"; Create PDF a document with files attached.
// QR code sits in Convert beside Extract text: both read what is printed on a
// page or photo (a camera or a photo), while Scan holds the capture modes.
const TOOL_SECTIONS: { title: string; tools: Tool[] }[] = [
  {
    title: 'Scan',
    tools: [
      { id: 'whiteboard', icon: 'easel-outline', label: 'Whiteboard', href: '/tools/whiteboard' },
      { id: 'book', icon: 'book-outline', label: 'Book mode', href: '/tools/book' },
      { id: 'id-card', icon: 'id-card', label: 'ID card', href: '/tools/id-card' },
      { id: 'business-card', icon: 'person-add-outline', label: 'Business card', href: '/tools/business-card' },
    ],
  },
  {
    title: 'Edit',
    tools: [
      { id: 'sign', icon: 'signature', label: 'Sign', href: '/tools/sign' },
      { id: 'redact', icon: 'eye-off-outline', label: 'Redact', href: '/tools/redact' },
      { id: 'watermark', icon: 'watermark', label: 'Watermark', href: '/tools/watermark' },
      { id: 'timestamp', icon: 'time-outline', label: 'Timestamp', href: '/tools/timestamp' },
    ],
  },
  {
    title: 'Pages',
    tools: [
      { id: 'merge', icon: 'git-merge-outline', label: 'Merge', href: '/tools/merge' },
      { id: 'create-pdf', icon: 'document-attach-outline', label: 'Create PDF', href: '/tools/create-pdf' },
      { id: 'split', icon: 'split', label: 'Split', href: '/tools/split' },
      { id: 'extract', icon: 'cut-outline', label: 'Extract pages', href: '/tools/extract' },
    ],
  },
  {
    title: 'PDF',
    tools: [
      { id: 'compress', icon: 'contract-outline', label: 'Compress', href: { pathname: '/tools/compress', params: { mode: 'pdf' } } },
      { id: 'unrestrict', icon: 'lock-open-outline', label: 'Unlock PDF', href: '/tools/unrestrict' },
      { id: 'protect', icon: 'lock-closed-outline', label: 'Protect PDF', href: '/tools/protect' },
      { id: 'flatten', icon: 'layers-outline', label: 'Flatten PDF', href: '/tools/flatten' },
    ],
  },
  {
    title: 'Convert',
    tools: [
      { id: 'extract-text', icon: 'reader-outline', label: 'Extract text', href: '/tools/extract-text' },
      { id: 'qr', icon: 'qr-code-outline', label: 'QR code', href: '/tools/qr' },
      { id: 'long-image', icon: 'long-image', label: 'Long image', href: '/tools/long-image' },
      { id: 'erase-marks', icon: 'color-wand-outline', label: 'Erase marks', href: '/tools/erase-marks' },
    ],
  },
];

function ToolTile({ tool }: { tool: Tool }) {
  const { colors } = useTheme();
  const router = useRouter();
  return (
    <Pressable
      style={({ pressed }) => [styles.tile, pressed && { opacity: 0.6 }]}
      onPress={() => router.push(tool.href)}
      accessibilityRole="button"
      accessibilityLabel={tool.label}
    >
      <View style={[styles.iconWrap, { backgroundColor: colors.accentLight }]}>
        <AppIcon name={tool.icon} size={26} color={colors.accent} />
      </View>
      <Text
        style={[styles.label, { color: colors.text }]}
        numberOfLines={1}
        maxFontSizeMultiplier={1.2}
      >
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
        contentContainerStyle={{ paddingTop: insets.top, paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}
      >
        <LargeTitle title="Tools" />

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
