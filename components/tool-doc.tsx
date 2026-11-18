// components/tool-doc.tsx
// Tools opened on a specific document (from the viewer's … menu) get a
// `docId` route param: the document is preselected and the picker is skipped.
// Opened from the Tools tab there is no param and the user must choose —
// nothing is ever preselected for them.
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/contexts/theme-context';
import { DocThumb, pageCountLabel } from '@/components/tool-ui';
import { Radius, Spacing, Type } from '@/lib/theme';
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
    /** The document came from the route and the picker is hidden. */
    fixed,
    /** Opened from the viewer: finishing should go back to it, not open another. */
    fromViewer: !!routeDocId,
  };
}

/**
 * The document a tool is working on, shown instead of the picker. `flush`:
 * sits right under a section label, so no top margin.
 */
export function ToolDocHeader({ doc, flush }: { doc: Document; flush?: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      style={[styles.card, flush && styles.flush, { backgroundColor: colors.card }]}
      accessible
      accessibilityLabel={`Document: ${doc.name}, ${pageCountLabel(doc.pages.length)}`}
    >
      <DocThumb doc={doc} width={34} height={44} />
      <View style={styles.text}>
        <Text style={[Type.subhead, styles.name, { color: colors.text }]} numberOfLines={1}>{doc.name}</Text>
        <Text style={[Type.footnote, { color: colors.muted }]}>{pageCountLabel(doc.pages.length)}</Text>
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
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
    marginTop: Spacing.lg,
  },
  flush: { marginTop: 0 },
  text: { flex: 1 },
  name: { fontWeight: '600', marginBottom: 1 },
});
