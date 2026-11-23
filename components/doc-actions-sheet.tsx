// components/doc-actions-sheet.tsx
// Long-press actions for a document.
//
// Every action runs only after this sheet has fully dismissed (BottomSheet
// onDismissed): the follow-up is usually another modal, a share sheet or an
// Alert, and iOS silently drops a presentation made while a modal is still
// animating away.
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PageThumb } from '@/components/page-thumb';
import Ionicons from '@expo/vector-icons/Ionicons';
import { BottomSheet, SheetGroup, SheetRow } from '@/components/bottom-sheet';
import { formatDocDate, formatPageCount } from '@/lib/format';
import { Document } from '@/types/document';
import { useTheme } from '@/contexts/theme-context';
import { Spacing, Type } from '@/lib/theme';
import { documentBytes } from '@/lib/doc-size';
import { formatBytes } from '@/components/tool-ui';
import { canEditPdfPages, canMergePdfDocuments } from '@/lib/pdf-edit';

type Props = {
  visible: boolean;
  document: Document | null;
  onRename: (doc: Document) => void;
  onDuplicate: (doc: Document) => void;
  onMerge: (doc: Document) => void;
  /** Optional — opens Split for this document (two or more pages, or an editable PDF). */
  onSplit?: (doc: Document) => void;
  onMoveToFolder: (doc: Document) => void;
  /** Optional — opens the export / share sheet. */
  onShare?: (doc: Document) => void;
  /** Optional — when omitted the "Select" row is hidden (e.g. on Home, which has no multi-select mode). */
  onSelect?: (doc: Document) => void;
  onDelete: (doc: Document) => void;
  onClose: () => void;
};

export function DocActionsSheet({
  visible,
  document,
  onRename,
  onDuplicate,
  onMerge,
  onSplit,
  onMoveToFolder,
  onShare,
  onSelect,
  onDelete,
  onClose,
}: Props) {
  const { colors } = useTheme();
  // Keep showing the last document while the sheet animates out (the parent
  // clears `document` as soon as it closes).
  const [shown, setShown] = useState<Document | null>(document);
  useEffect(() => { if (document) setShown(document); }, [document]);
  const pending = useRef<(() => void) | null>(null);
  // Size on disk, so "Smaller PDF" / Compress have a number to judge by.
  const size = useMemo(
    () => (shown ? documentBytes(shown) : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown?.id, shown?.updatedAt],
  );

  if (!shown) return null;
  const doc = shown;

  function run(fn: (d: Document) => void) {
    return () => {
      pending.current = () => fn(doc);
      onClose();
    };
  }

  // An imported PDF merges into a new PDF (lib/pdf-edit) in builds that can.
  const canMerge = !doc.pdfUri || canMergePdfDocuments();
  // Split needs two pages; a PDF's page count is checked by the Split screen.
  const canSplit = !!onSplit && (doc.pdfUri ? canEditPdfPages() : doc.pages.length > 1);

  return (
    <BottomSheet
      visible={visible}
      onClose={() => { pending.current = null; onClose(); }}
      variant="grouped"
      scroll
      onDismissed={() => {
        const next = pending.current;
        pending.current = null;
        next?.();
      }}
    >
      <View style={styles.header}>
        {doc.pdfUri ? (
          <View style={[styles.thumb, styles.pdfThumb, { backgroundColor: colors.placeholder }]}>
            <Ionicons name="document-text-outline" size={20} color={colors.muted} />
          </View>
        ) : doc.pages[0] ? (
          <PageThumb uri={`${doc.pages[0]}?v=${doc.updatedAt}`} style={[styles.thumb, { backgroundColor: colors.placeholder }]} />
        ) : (
          <View style={[styles.thumb, { backgroundColor: colors.placeholder }]} />
        )}
        <View style={styles.headerText}>
          <Text style={[Type.headline, { color: colors.text }]} numberOfLines={2}>{doc.name}</Text>
          <Text style={[Type.footnote, { color: colors.muted, marginTop: 2 }]} numberOfLines={1}>{size > 0 ? `${formatPageCount(doc)}, ${formatBytes(size)}` : formatPageCount(doc)}</Text>
          <Text style={[Type.footnote, { color: colors.muted }]} numberOfLines={1}>{formatDocDate(doc.updatedAt)}</Text>
        </View>
      </View>

      <SheetGroup>
        {onShare && <SheetRow icon="share-outline" label="Share or export" onPress={run(onShare)} />}
        <SheetRow icon="rename" label="Rename" onPress={run(onRename)} />
        <SheetRow icon="duplicate-outline" label="Duplicate" onPress={run(onDuplicate)} />
        <SheetRow icon="folder-outline" label="Move to folder" onPress={run(onMoveToFolder)} />
        <SheetRow
          icon="git-merge-outline"
          label="Merge with another document"
          detail={canMerge ? undefined : 'Not available for PDFs'}
          disabled={!canMerge}
          onPress={run(onMerge)}
          last={!onSelect && !canSplit}
        />
        {canSplit && onSplit ? <SheetRow icon="split" label="Split" onPress={run(onSplit)} last={!onSelect} /> : null}
        {onSelect && <SheetRow icon="checkmark-circle-outline" label="Select" onPress={run(onSelect)} last />}
      </SheetGroup>

      <SheetGroup style={styles.lastGroup}>
        <SheetRow icon="trash-outline" label="Delete" destructive onPress={run(onDelete)} last />
      </SheetGroup>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginBottom: Spacing.lg, paddingHorizontal: Spacing.xs },
  thumb: { width: 40, height: 52, borderRadius: 6 },
  pdfThumb: { alignItems: 'center', justifyContent: 'center' },
  headerText: { flex: 1 },
  lastGroup: { marginBottom: 0 },
});
