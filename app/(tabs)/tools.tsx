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
// import (Files "+"), reorder / rotate / text (viewer), print / save as images /
// smaller PDF (Export), merge (Files: select or long-press). Every section is a
// full row of four.
const TOOL_SECTIONS: { title: string; tools: Tool[] }[] = [
  {
    title: 'Scan',
    tools: [
      { id: 'whiteboard', icon: 'easel-outline', label: 'Whiteboard', href: '/tools/whiteboard' },
      { id: 'book', icon: 'book-outline', label: 'Book mode', href: '/tools/book' },
      { id: 'id-card', icon: 'id-card', label: 'ID card', href: '/tools/id-card' },
      { id: 'qr', icon: 'qr-code-outline', label: 'QR code', href: '/tools/qr' },
    ],
  },
  {
    title: 'Convert',
    tools: [
      { id: 'extract-text', icon: 'reader-outline', label: 'Extract text', href: '/tools/extract-text' },
      { id: 'extract', icon: 'cut-outline', label: 'Extract pages', href: '/tools/extract' },
      { id: 'long-image', icon: 'long-image', label: 'Long image', href: '/tools/long-image' },
      // Not "Compress": it shrinks the stored pages for good, unlike Export's Smaller PDF.
      { id: 'compress', icon: 'contract-outline', label: 'Free up space', href: '/tools/compress' },
    ],
  },
  {
    title: 'Edit',
    tools: [
      { id: 'sign', icon: 'signature', label: 'Sign', href: '/tools/sign' },
      { id: 'watermark', icon: 'watermark', label: 'Watermark', href: '/tools/watermark' },
      { id: 'timestamp', icon: 'time-outline', label: 'Timestamp', href: '/tools/timestamp' },
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
