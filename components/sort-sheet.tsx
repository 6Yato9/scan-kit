// components/sort-sheet.tsx
import { BottomSheet, SheetGroup, SheetHeader, SheetRow } from '@/components/bottom-sheet';
import { SortKey } from '@/lib/storage';

type Props = {
  visible: boolean;
  current: SortKey;
  onSort: (key: SortKey) => void;
  onClose: () => void;
};

const OPTIONS: { key: SortKey; label: string; sub: string; icon: 'calendar-outline' | 'time-outline' | 'text-outline' }[] = [
  { key: 'dateAdded', label: 'Date added', sub: 'Newest first', icon: 'calendar-outline' },
  { key: 'dateModified', label: 'Last modified', sub: 'Recently edited first', icon: 'time-outline' },
  { key: 'nameAZ', label: 'Name', sub: 'A to Z', icon: 'text-outline' },
];

export function SortSheet({ visible, current, onSort, onClose }: Props) {
  return (
    <BottomSheet visible={visible} onClose={onClose} variant="grouped" scroll>
      <SheetHeader title="Sort by" />
      <SheetGroup style={{ marginBottom: 0 }}>
        {OPTIONS.map(({ key, label, sub, icon }, i) => (
          <SheetRow
            key={key}
            icon={icon}
            label={label}
            detail={sub}
            selected={current === key}
            last={i === OPTIONS.length - 1}
            onPress={() => { onSort(key); onClose(); }}
          />
        ))}
      </SheetGroup>
    </BottomSheet>
  );
}
