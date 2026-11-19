// app/(tabs)/tools.tsx
// The Tools tab: every entry opens a working flow. Labels match the title of
// the screen they open and fit on one line.
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { SectionLabel } from '@/components/section-label';
import { LargeTitle } from '@/components/screen-header';
import { ToolGrid } from '@/components/tool-tile';
import { TOOL_SECTIONS, toolHref } from '@/lib/tool-catalog';
import { Spacing, TAB_BAR_CLEARANCE } from '@/lib/theme';

// The sections, their tools, labels, icons and colours are lib/tool-catalog.ts
// (shared with Home's Tools row and the viewer's Tools sheet). Each tool has
// its own colour, on a pale tile of the same hue.

export default function ToolsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const router = useRouter();

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
            <ToolGrid tools={section.tools} onPress={id => router.push(toolHref(id))} />
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
  statusMask: { position: 'absolute', top: 0, left: 0, right: 0 },
});
