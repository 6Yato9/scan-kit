// components/viewer-tools-sheet.tsx
// The viewer's Tools sheet (the Tools button pinned at the end of its page
// toolbar): every tool that applies to the open document, grouped and drawn
// exactly like the Tools tab — same sections, icons, labels and colours
// (lib/tool-catalog.ts). Which tools appear is documentToolSections(); what
// each does is the viewer's business (onPick), so a tool opens on this
// document and page, and the viewer refreshes when it comes back.
//
// Like the "…" sheet, the picked tool runs only after the sheet has fully
// dismissed: most tools present something else (a screen, an action sheet, an
// alert), and iOS silently drops a presentation made while a modal is still
// animating away.
import { useRef } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { BottomSheet, SheetHeader } from '@/components/bottom-sheet';
import { SectionLabel } from '@/components/section-label';
import { ToolGrid } from '@/components/tool-tile';
import type { ToolId, ToolSection } from '@/lib/tool-catalog';
import { Spacing } from '@/lib/theme';

type Props = {
  visible: boolean;
  title: string;
  subtitle?: string;
  sections: ToolSection[];
  /** Label overrides (an imported form that can only be filled in: "Fill in"). */
  labels?: Partial<Record<ToolId, string>>;
  /** Runs once the sheet has gone. */
  onPick: (id: ToolId) => void;
  onClose: () => void;
};

export function ViewerToolsSheet({ visible, title, subtitle, sections, labels, onPick, onClose }: Props) {
  const pending = useRef<ToolId | null>(null);
  return (
    <BottomSheet
      visible={visible}
      variant="grouped"
      onClose={() => { pending.current = null; onClose(); }}
      onDismissed={() => {
        const id = pending.current;
        pending.current = null;
        if (id) onPick(id);
      }}
    >
      <SheetHeader title={title} subtitle={subtitle} />
      <ScrollView bounces={false} showsVerticalScrollIndicator={false} style={styles.scroll}>
        {sections.map((section, i) => (
          <View key={section.title}>
            <SectionLabel style={i === 0 ? styles.firstLabel : styles.label}>{section.title}</SectionLabel>
            <ToolGrid
              tools={section.tools}
              labels={labels}
              onPress={id => {
                pending.current = id;
                onClose();
              }}
            />
          </View>
        ))}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  // Tighter than a screen's section gap: the sheet's header sits right above.
  firstLabel: { marginTop: 0, marginHorizontal: Spacing.xs },
  label: { marginTop: Spacing.lg, marginHorizontal: Spacing.xs },
});
