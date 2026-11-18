// components/tool-doc.tsx
// Tools opened on a specific document (from the viewer's … menu) get a
// `docId` route param: the document is preselected and can't be changed.
// Opened from the Tools tab there is no param and the user must choose —
// nothing is ever preselected for them.
//
// Choosing happens in a sheet, not in an inline list: the screen shows one
// compact "Document" row, so a tool's preview and options stay above the fold
// however many documents there are.
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/contexts/theme-context';
import { BottomSheet, SheetHeader } from '@/components/bottom-sheet';
import { SectionLabel } from '@/components/section-label';
import { DocGroup, DocRow, DocThumb, pageCountLabel } from '@/components/tool-ui';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';
import type { Document } from '@/types/document';

export function useToolDoc(docs: Document[]) {
  const params = useLocalSearchParams<{ docId?: string }>();
  const routeDocId = typeof params.docId === 'string' && params.docId ? params.docId : null;
  const [docId, setDocId] = useState<string | null>(routeDocId);
  const doc = docs.find(d => d.id === docId) ?? null;
  // Fixed only while the route's document is actually available to this tool;
  // otherwise (deleted, a PDF, too few pages) the picker comes back.
  const fixed = !!routeDocId && docs.some(d => d.id === routeDocId);
  return {
    doc,
    docId,
    setDocId,
    /** The document came from the route and can't be changed here. */
    fixed,
    /** Opened from the viewer: finishing should go back to it, not open another. */
    fromViewer: !!routeDocId,
  };
}

const docMeta = (d: Document) => (d.pdfUri ? 'PDF' : pageCountLabel(d.pages.length));

/**
 * The document a tool works on, as one row under a "Document" label: "Choose
 * a document" until one is picked, then its thumbnail, name and Change. Tapping
 * it opens a sheet listing `docs`. With `fixed` (opened from the viewer) the
 * row only shows the document.
 */
export function ToolDocPicker({
  docs,
  doc,
  fixed = false,
  disabled = false,
  onPick,
  note,
  autoOpen = false,
}: {
  docs: Document[];
  doc: Document | null;
  fixed?: boolean;
  /** While the tool is working: the row can't be tapped. */
  disabled?: boolean;
  onPick: (doc: Document) => void;
  /** One line under the list in the sheet, e.g. which documents are listed. */
  note?: string;
  /**
   * Opened from the Tools tab with nothing chosen: open the sheet by itself
   * once the screen is in, so the tool starts from choosing a document.
   */
  autoOpen?: boolean;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!autoOpen || autoOpened.current || fixed || doc || docs.length === 0) return;
    // After the screen's push animation: a sheet presented mid-push is dropped.
    const t = setTimeout(() => {
      autoOpened.current = true;
      setOpen(true);
    }, 400);
    return () => clearTimeout(t);
  }, [autoOpen, fixed, doc, docs.length]);
  const tappable = !fixed && !disabled;

  const body = doc ? (
    <>
      <DocThumb doc={doc} width={34} height={44} />
      <View style={styles.text}>
        <Text style={[Type.subhead, styles.name, { color: colors.text }]} numberOfLines={1}>
          {doc.name}
        </Text>
        <Text style={[Type.footnote, { color: colors.muted }]}>{docMeta(doc)}</Text>
      </View>
      {fixed ? null : (
        <Text style={[Type.subhead, { color: disabled ? colors.faint : colors.accent }]}>Change</Text>
      )}
    </>
  ) : (
    <>
      <View style={[styles.emptyThumb, { backgroundColor: colors.accentLight }]}>
        <Ionicons name="document-outline" size={20} color={colors.accent} />
      </View>
      <View style={styles.text}>
        <Text style={[Type.body, { color: colors.accent, fontWeight: '600' }]}>Choose a document</Text>
        <Text style={[Type.footnote, { color: colors.muted }]}>
          {docs.length === 1 ? '1 document' : `${docs.length} documents`}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.muted} />
    </>
  );

  return (
    <>
      <SectionLabel>Document</SectionLabel>
      {tappable ? (
        <Pressable
          onPress={() => setOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={doc ? `Document: ${doc.name}, ${docMeta(doc)}` : 'Choose a document'}
          accessibilityHint={doc ? 'Choose a different document' : undefined}
          style={({ pressed }) => [styles.card, { backgroundColor: colors.card }, pressed && { backgroundColor: colors.separator }]}
        >
          {body}
        </Pressable>
      ) : (
        <View
          style={[styles.card, { backgroundColor: colors.card }]}
          accessible
          accessibilityLabel={doc ? `Document: ${doc.name}, ${docMeta(doc)}` : 'No document chosen'}
        >
          {body}
        </View>
      )}

      <BottomSheet visible={open} onClose={() => setOpen(false)} variant="grouped">
        <SheetHeader title="Choose a document" subtitle={note} />
        <ScrollView style={styles.list} showsVerticalScrollIndicator={false} bounces={false}>
          <DocGroup>
            {docs.map(d => (
              <DocRow
                key={d.id}
                doc={d}
                selected={d.id === doc?.id}
                onPress={() => {
                  setOpen(false);
                  if (d.id !== doc?.id) onPick(d);
                }}
              />
            ))}
          </DocGroup>
        </ScrollView>
      </BottomSheet>
    </>
  );
}

/**
 * The document a tool is working on, shown on its own (no label, no picker).
 * `flush`: sits right under a section label, so no top margin.
 */
export function ToolDocHeader({ doc, flush }: { doc: Document; flush?: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      style={[styles.card, styles.headerCard, flush && styles.flush, { backgroundColor: colors.card }]}
      accessible
      accessibilityLabel={`Document: ${doc.name}, ${docMeta(doc)}`}
    >
      <DocThumb doc={doc} width={34} height={44} />
      <View style={styles.text}>
        <Text style={[Type.subhead, styles.name, { color: colors.text }]} numberOfLines={1}>{doc.name}</Text>
        <Text style={[Type.footnote, { color: colors.muted }]}>{docMeta(doc)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    borderRadius: Radius.md,
    paddingLeft: Spacing.md,
    paddingRight: Spacing.lg,
    paddingVertical: Spacing.sm + 2,
    minHeight: HIT + 20,
  },
  headerCard: { marginTop: Spacing.lg },
  flush: { marginTop: 0 },
  emptyThumb: { width: 34, height: 44, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1 },
  name: { fontWeight: '600', marginBottom: 1 },
  list: { flexGrow: 0, flexShrink: 1 },
});
