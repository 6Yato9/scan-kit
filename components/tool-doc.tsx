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
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/contexts/theme-context';
import { BottomSheet, SheetHeader } from '@/components/bottom-sheet';
import { SectionLabel } from '@/components/section-label';
import { useToast } from '@/components/toast';
import { DocGroup, DocRow, DocThumb, pageCountLabel, useToolDocuments } from '@/components/tool-ui';
import {
  canConvertPdf,
  convertPdfToPages,
  PdfConvertError,
  undoPdfConversion,
  type ConvertProgress,
} from '@/lib/convert-pdf';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';
import type { Document } from '@/types/document';

/** Imported PDFs: a page tool can't edit them until they are converted to pages. */
export const isPdfDoc = (d: Document) => !!d.pdfUri;

/**
 * The imported PDFs a page tool could offer to convert (none when this build
 * can't render PDF pages), refreshed with the screen like useToolDocuments.
 */
export function useConvertiblePdfs() {
  const { docs, loaded, reload } = useToolDocuments(isPdfDoc);
  return { pdfs: canConvertPdf() ? docs : [], loaded, reload };
}

/** Converting an imported PDF from a tool's picker (see ToolDocPicker `convert`). */
export type PickerConvert = {
  /** Imported PDFs, listed under the documents with a Convert button. */
  pdfs: Document[];
  /** What the tool does, for the sheet's note: "sign", "watermark", "timestamp". */
  verb: string;
  /** The PDF is now an image-page document: reload and choose it. */
  onConverted: (doc: Document) => void;
  /** Its conversion was undone from the toast: reload (it is a PDF again). */
  onUndone: (docId: string) => void;
  /**
   * Instead of converting: the PDF opens in a tool that works on it as it is
   * (Sign → Fill & sign). The row says `label`; `onOpen` runs once the sheet
   * has closed; `note` replaces the "convert it first" line.
   */
  open?: {
    label: string;
    hint: string;
    note: string;
    onOpen: (pdf: Document) => void;
    /** Why this PDF can't be opened there (its author forbids it): the row is shown dimmed with it, not tappable. */
    blocked?: (pdf: Document) => string | null;
  };
};

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
  convert,
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
  /**
   * Also list imported PDFs, each with Convert: the tool can't change a PDF,
   * so instead of hiding them (a dead end when that is all there is) the
   * sheet offers to turn one into pages, in place, with Undo.
   */
  convert?: PickerConvert;
}) {
  const { colors } = useTheme();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const autoOpened = useRef(false);
  const pdfs = convert?.pdfs ?? [];
  const total = docs.length + pdfs.length;
  // A PDF tapped in the sheet: asked about once the sheet has fully closed (an
  // alert presented while the sheet's modal is still dismissing never shows).
  const pendingConvert = useRef<Document | null>(null);
  const [converting, setConverting] = useState<{ doc: Document; progress: ConvertProgress } | null>(null);
  const convertingRef = useRef(false);
  const convertRef = useRef(convert);
  convertRef.current = convert;

  const runConvert = async (pdf: Document) => {
    if (convertingRef.current) return;
    convertingRef.current = true;
    setConverting({ doc: pdf, progress: { stage: 'rendering' } });
    try {
      // 'original', as in the viewer: an imported PDF is usually computer-made
      // and already clean; a scan filter would only soften its text.
      const { doc: next, pageCount: n, undo } = await convertPdfToPages(pdf.id, {
        filter: 'original',
        onProgress: p => setConverting({ doc: pdf, progress: p }),
      });
      notifySuccess();
      convertRef.current?.onConverted(next);
      toast.show(
        `Converted to ${n} ${n === 1 ? 'page' : 'pages'}`,
        undo
          ? {
              action: {
                label: 'Undo',
                onPress: () => {
                  undoPdfConversion(undo)
                    .then(restored => convertRef.current?.onUndone(restored.id))
                    .catch(() => Alert.alert('Couldn’t undo the conversion', 'The document stays as pages. Your pages are unchanged.'));
                },
              },
            }
          : undefined,
      );
    } catch (err) {
      notifyError();
      const kind = err instanceof PdfConvertError ? err.kind : 'failed';
      if (kind === 'locked') {
        Alert.alert('This PDF is password protected', 'Open it in Scan Kit and enter its password, then convert it.');
      } else if (kind === 'unreadable') {
        Alert.alert('Couldn’t read this PDF', 'The file may be damaged. Try importing it again.');
      } else if (kind === 'missing') {
        Alert.alert('This PDF is no longer here', 'It may have been deleted.');
        convertRef.current?.onUndone(pdf.id);
      } else {
        Alert.alert('Couldn’t convert the PDF', 'Your PDF is unchanged. Check that there’s free space, then try again.');
      }
    } finally {
      convertingRef.current = false;
      setConverting(null);
    }
  };

  const askConvert = (pdf: Document) => {
    Alert.alert(
      `Convert “${pdf.name}” to pages?`,
      `To ${convert?.verb ?? 'edit'} a PDF, its pages are turned into images you can also crop, filter and mark up. You can undo it right after.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Convert', isPreferred: true, onPress: () => { void runConvert(pdf); } },
      ],
    );
  };

  useEffect(() => {
    if (!autoOpen || autoOpened.current || fixed || doc || total === 0) return;
    // After the screen's push animation: a sheet presented mid-push is dropped.
    const t = setTimeout(() => {
      autoOpened.current = true;
      setOpen(true);
    }, 400);
    return () => clearTimeout(t);
  }, [autoOpen, fixed, doc, total]);
  const tappable = !fixed && !disabled && !converting;

  const body = converting ? (
    <>
      <View style={[styles.emptyThumb, { backgroundColor: colors.accentLight }]}>
        <ActivityIndicator color={colors.accent} />
      </View>
      <View style={styles.text}>
        <Text style={[Type.subhead, styles.name, { color: colors.text }]} numberOfLines={1}>
          {converting.doc.name}
        </Text>
        <Text style={[Type.footnote, { color: colors.muted }]}>
          {converting.progress.stage === 'saving'
            ? `Converting page ${converting.progress.done} of ${converting.progress.total}…`
            : 'Converting to pages…'}
        </Text>
      </View>
    </>
  ) : doc ? (
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
          {total === 1 ? '1 document' : `${total} documents`}
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

      <BottomSheet
        visible={open}
        onClose={() => setOpen(false)}
        variant="grouped"
        onDismissed={() => {
          const pdf = pendingConvert.current;
          pendingConvert.current = null;
          if (!pdf) return;
          if (convertRef.current?.open) convertRef.current.open.onOpen(pdf);
          else askConvert(pdf);
        }}
      >
        <SheetHeader title="Choose a document" subtitle={pdfs.length ? undefined : note} />
        <ScrollView style={styles.list} showsVerticalScrollIndicator={false} bounces={false}>
          {docs.length ? (
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
          ) : null}
          {pdfs.length ? (
            <>
              <SectionLabel style={docs.length ? undefined : styles.firstLabel}>Imported PDFs</SectionLabel>
              <DocGroup>
                {pdfs.map(d => (
                  <ConvertRow
                    key={d.id}
                    doc={d}
                    action={convert?.open?.label}
                    hint={convert?.open?.hint}
                    opens={!!convert?.open}
                    blocked={convert?.open?.blocked?.(d) ?? null}
                    onPress={() => {
                      pendingConvert.current = d;
                      setOpen(false);
                    }}
                  />
                ))}
              </DocGroup>
              <Text style={[Type.footnote, styles.pdfNote, { color: colors.muted }]}>
                {convert?.open?.note ?? `To ${convert?.verb ?? 'edit'} a PDF, convert it to pages first. You can undo it right after.`}
              </Text>
            </>
          ) : null}
        </ScrollView>
      </BottomSheet>
    </>
  );
}

/**
 * An imported PDF in the picker. Converting: the row ends in a Convert button.
 * Opening in another tool (`opens`, e.g. Sign → Fill & sign): a plain chevron,
 * the note under the list says where it goes. `blocked`: why it can't be used
 * (dimmed, not tappable, the reason as its second line).
 */
function ConvertRow({
  doc,
  onPress,
  action = 'Convert',
  hint = 'Converts it to pages',
  opens = false,
  blocked = null,
}: {
  doc: Document;
  onPress: () => void;
  action?: string;
  hint?: string;
  opens?: boolean;
  blocked?: string | null;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!!blocked}
      accessibilityRole="button"
      accessibilityLabel={`${doc.name}, PDF`}
      accessibilityHint={blocked ? `Not available. ${blocked}.` : hint}
      accessibilityState={{ disabled: !!blocked }}
      style={({ pressed }) => [styles.convertRow, pressed && !blocked && { backgroundColor: colors.separator }]}
    >
      <View style={blocked ? styles.dimmed : null}>
        <DocThumb doc={doc} />
      </View>
      <View style={[styles.text, blocked ? styles.dimmed : null]}>
        <Text style={[Type.body, { color: colors.text }]} numberOfLines={1}>
          {doc.name}
        </Text>
        <Text style={[Type.footnote, styles.meta, { color: colors.muted }]} numberOfLines={2}>
          {blocked ? `PDF · ${blocked}` : 'PDF'}
        </Text>
      </View>
      {blocked ? (
        <Ionicons name="lock-closed-outline" size={17} color={colors.faint} />
      ) : opens ? (
        <Ionicons name="chevron-forward" size={18} color={colors.faint} />
      ) : (
        <Text style={[Type.subhead, styles.convertAction, { color: colors.accent }]}>{action}</Text>
      )}
    </Pressable>
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
  firstLabel: { marginTop: 0 },
  pdfNote: { marginTop: Spacing.sm, marginHorizontal: Spacing.xs, lineHeight: 18 },
  meta: { marginTop: 2 },
  // Same box as DocRow (components/tool-ui.tsx), with a text action at the end.
  convertRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.sm + 2,
    paddingLeft: Spacing.md,
    paddingRight: Spacing.lg,
    minHeight: HIT + 16,
  },
  convertAction: { fontWeight: '600' },
  dimmed: { opacity: 0.45 },
});
