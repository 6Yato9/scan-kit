// app/settings/help.tsx
// Short, scannable help: how to do the main things in Scan Kit.
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { SectionLabel } from '@/components/section-label';
import { Radius, Spacing, Type } from '@/lib/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];
type Tip = { icon: IconName; title: string; text: string };

const SECTIONS: { title: string; tips: Tip[] }[] = [
  {
    title: 'Getting started',
    tips: [
      { icon: 'camera-outline', title: 'Scan a document', text: 'Tap the camera button in the middle of the tab bar. Edges are detected for you, and you can scan several pages in a row.' },
      { icon: 'images-outline', title: 'Import photos or PDFs', text: 'In Files, tap the add button and choose Import from Photos or Import a file.' },
    ],
  },
  {
    title: 'Working with documents',
    tips: [
      { icon: 'hand-left-outline', title: 'More actions', text: 'Long-press any document to share, rename, duplicate, move, merge or delete it.' },
      { icon: 'checkmark-circle-outline', title: 'Select several', text: 'In Files, tap the select button to move, merge or delete many documents at once.' },
      { icon: 'color-filter-outline', title: 'Edit pages', text: 'Open a document and tap a page to crop, rotate, apply a filter or annotate it.' },
      { icon: 'share-outline', title: 'Share and export', text: 'Send a document as a PDF, a searchable PDF, images or a ZIP, or print it.' },
    ],
  },
  {
    title: 'Staying organized',
    tips: [
      { icon: 'folder-outline', title: 'Folders', text: 'Create folders in Files. Long-press a folder to rename or delete it; its documents are kept.' },
      { icon: 'search-outline', title: 'Search', text: 'Search finds documents by name and by the text recognized in their pages.' },
    ],
  },
  {
    title: 'Privacy',
    tips: [
      { icon: 'phone-portrait-outline', title: 'On your device', text: 'Your scans are stored only on this device. There is no account and no cloud upload.' },
      { icon: 'lock-closed-outline', title: 'App lock', text: 'Turn on App lock in Settings to require Face ID or your passcode whenever you return to Scan Kit.' },
    ],
  },
];

export default function HelpScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.xxxl }]}
    >
      <Stack.Screen options={{ title: 'Help' }} />
      {SECTIONS.map(section => (
        <View key={section.title}>
          <SectionLabel>{section.title}</SectionLabel>
          <View style={[styles.group, { backgroundColor: colors.card }]}>
            {section.tips.map((tip, i) => (
              <View key={tip.title} style={styles.row} accessible accessibilityLabel={`${tip.title}. ${tip.text}`}>
                <View style={[styles.iconTile, { backgroundColor: colors.accentLight }]}>
                  <Ionicons name={tip.icon} size={18} color={colors.accent} />
                </View>
                <View
                  style={[
                    styles.text,
                    i < section.tips.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
                  ]}
                >
                  <Text style={[Type.headline, { color: colors.text }]}>{tip.title}</Text>
                  <Text style={[Type.subhead, styles.body, { color: colors.muted }]}>{tip.text}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: Spacing.gutter },
  group: { borderRadius: Radius.md, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingLeft: Spacing.lg },
  iconTile: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginRight: Spacing.md, marginTop: Spacing.md },
  text: { flex: 1, paddingVertical: Spacing.md, paddingRight: Spacing.lg },
  body: { marginTop: 2, lineHeight: 20, fontWeight: '400' },
});
