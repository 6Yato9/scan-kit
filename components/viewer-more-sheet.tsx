// components/viewer-more-sheet.tsx
// The viewer's "…" menu: tools that work on the open document (Sign,
// Watermark, …) as a row of tiles, then page and document actions as rows.
//
// Every action runs only after the sheet has fully dismissed: most of them
// present something else (a modal, a share sheet, an Alert, a pushed screen),
// and iOS silently drops a presentation made while a modal is still animating
// away.
import { useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BottomSheet, SheetGroup, SheetHeader, SheetRow } from '@/components/bottom-sheet';
import { AppIcon, type AppIconName } from '@/components/app-icon';
import { useTheme } from '@/contexts/theme-context';
import { Radius, Spacing, Type } from '@/lib/theme';

/** Tool tiles per row: the scanned-document menu's four (Sign, Redact, Watermark, Timestamp). */
const TILES_PER_ROW = 4;

export type MoreAction = {
  key: string;
  /** Ionicons, or one of AppIcon's SF Symbol glyphs (Sign's signature, Rename's pencil). */
  icon: AppIconName;
  label: string;
  detail?: string;
  destructive?: boolean;
  onPress: () => void;
};

type Props = {
  visible: boolean;
  title: string;
  subtitle?: string;
  /** Tools for this document, drawn as a row of tiles above the groups. */
  tools?: MoreAction[];
  /** Groups of rows; each group is drawn as its own card. Empty groups are skipped. */
  groups: MoreAction[][];
  onClose: () => void;
};

export function ViewerMoreSheet({ visible, title, subtitle, tools, groups, onClose }: Props) {
  const { colors } = useTheme();
  const pending = useRef<(() => void) | null>(null);
  const shown = groups.filter(g => g.length > 0);
  const run = (fn: () => void) => {
    pending.current = fn;
    onClose();
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={() => { pending.current = null; onClose(); }}
      variant="grouped"
      onDismissed={() => {
        const next = pending.current;
        pending.current = null;
        next?.();
      }}
    >
      <SheetHeader title={title} subtitle={subtitle} />
      <ScrollView bounces={false} showsVerticalScrollIndicator={false} style={styles.scroll}>
        {tools && tools.length > 0 ? (
          <View style={styles.tools}>
            {/* Always a row of four equal tiles, left-aligned: one tool (an imported
                PDF's Fill & sign) is a tile, not a bar stretched across the sheet. */}
            {tools.map(t => (
              <Pressable
                key={t.key}
                onPress={() => run(t.onPress)}
                accessibilityRole="button"
                accessibilityLabel={t.label}
                style={({ pressed }) => [styles.tool, { backgroundColor: colors.card }, pressed && { opacity: 0.6 }]}
              >
                <AppIcon name={t.icon} size={24} color={colors.accent} />
                <Text
                  style={[Type.caption, styles.toolLabel, { color: colors.text }]}
                  numberOfLines={1}
                  maxFontSizeMultiplier={1.1}
                >
                  {t.label}
                </Text>
              </Pressable>
            ))}
            {Array.from({ length: Math.max(0, TILES_PER_ROW - (tools.length % TILES_PER_ROW || TILES_PER_ROW)) }, (_, i) => (
              <View key={`spacer-${i}`} style={styles.spacer} importantForAccessibility="no" accessibilityElementsHidden />
            ))}
          </View>
        ) : null}
        {shown.map((group, gi) => (
          <SheetGroup key={gi} style={gi === shown.length - 1 ? { marginBottom: 0 } : undefined}>
            {group.map((a, i) => (
              <SheetRow
                key={a.key}
                icon={a.icon}
                label={a.label}
                detail={a.detail}
                destructive={a.destructive}
                last={i === group.length - 1}
                onPress={() => run(a.onPress)}
              />
            ))}
          </SheetGroup>
        ))}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  tools: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs + 2, marginBottom: Spacing.md },
  tool: {
    flexGrow: 1,
    flexBasis: '20%',
    minHeight: 72,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs + 2,
    paddingHorizontal: 0,
  },
  spacer: { flexGrow: 1, flexBasis: '20%' },
  toolLabel: { fontWeight: '600', letterSpacing: -0.2 },
});
