// components/viewer-more-sheet.tsx
// The viewer's "…" menu: the secondary actions that used to crowd the header
// (rename, reorder) plus page and document housekeeping.
//
// Every action runs only after the sheet has fully dismissed: most of them
// present something else (a modal, a share sheet, an Alert), and iOS silently
// drops a presentation made while a modal is still animating away.
import { useRef } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet, SheetGroup, SheetHeader, SheetRow } from '@/components/bottom-sheet';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

export type MoreAction = {
  key: string;
  icon: IconName;
  label: string;
  detail?: string;
  destructive?: boolean;
  onPress: () => void;
};

type Props = {
  visible: boolean;
  title: string;
  subtitle?: string;
  /** Groups of rows; each group is drawn as its own card. Empty groups are skipped. */
  groups: MoreAction[][];
  onClose: () => void;
};

export function ViewerMoreSheet({ visible, title, subtitle, groups, onClose }: Props) {
  const pending = useRef<(() => void) | null>(null);
  const shown = groups.filter(g => g.length > 0);

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
              onPress={() => {
                pending.current = a.onPress;
                onClose();
              }}
            />
          ))}
        </SheetGroup>
      ))}
    </BottomSheet>
  );
}
