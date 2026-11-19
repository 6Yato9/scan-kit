// app/tools/merge.tsx
// Merge, from the Tools tab: pick two or more documents in the order they
// should appear and they become ONE new document; the originals are kept.
// Scanned documents merge page by page with their shadows (lib/doc-ops
// mergeIntoNew: each page keeps its unfiltered .orig, source photo and crop,
// so the result can still be filtered and re-cropped). When an imported PDF is
// among them, the result is one new PDF instead (lib/pdf-edit
// mergeDocumentsToPdf: PDF pages keep their text, scans are rendered on the
// paper size from Document settings) — the same two paths as Files' select
// mode and the viewer's "Merge with another document".
//
// The result opens in the viewer (it replaces this screen, so closing it goes
// back to Tools). Its Undo removes the merged copy and comes back HERE, with
// the same documents chosen in the same order (`ids`), since "undo" usually
// means the order or the choice was wrong.
import { useState } from 'react';
import { Alert, StyleSheet, Text } from 'react-native';
import { router as stackRouter, useLocalSearchParams, useRouter } from 'expo-router';
import { useScan } from '@/contexts/scan-context';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import { DocGroup, DocRow, NoDocumentsScreen, ToolNote, ToolProgress, ToolScreen, useToolDocuments } from '@/components/tool-ui';
import { mergeIntoNew } from '@/lib/doc-ops';
import { canMergePdfDocuments, mergeDocumentsToPdf, needsPdfMerge, PdfEditError, type MergeProgress } from '@/lib/pdf-edit';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import {
  MERGE_UNDO_FAILED_TITLE,
  mergedNewMessage,
  mergeUndoneMessage,
  newMergeUndo,
  newMergeUndoFailedMessage,
  undoNewMerge,
} from '@/lib/merge-undo';
import { postViewerNotice } from '@/lib/viewer-notice';
import { useToast } from '@/components/toast';
import { Spacing, Type } from '@/lib/theme';
import type { Document } from '@/types/document';

/** What Merge can take: scanned documents with pages, and imported PDFs in builds that can merge them. */
const isMergeable = (d: Document, pdfMerge = canMergePdfDocuments()) =>
  !d.trashedAt && (d.pdfUri ? pdfMerge : d.pages.length > 0);

/** The documents chosen on arrival (`ids`: comma-separated, in order), e.g. after Undo. */
function initialMergeOrder(ids: string | string[] | undefined): string[] {
  const raw = Array.isArray(ids) ? ids.join(',') : ids ?? '';
  return [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))];
}

/** The merged document's name: like Files' select mode, after the first one chosen. */
function mergedName(first: Document): string {
  return `Merged ${first.name}`.slice(0, 120);
}

export default function MergeScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ ids?: string }>();
  const { colors } = useTheme();
  const { bumpLastSaved } = useScan();
  const toast = useToast();
  const pdfMerge = canMergePdfDocuments();
  const { docs, loaded } = useToolDocuments(d => isMergeable(d, pdfMerge));
  // Chosen documents, in the order they will appear.
  // (Ids of documents that no longer exist are simply never shown as chosen.)
  const [order, setOrder] = useState<string[]>(() => initialMergeOrder(params.ids));
  const [progress, setProgress] = useState<MergeProgress | null>(null);
  const [saving, setSaving] = useState(false);

  const chosen = order.map(id => docs.find(d => d.id === id)).filter((d): d is Document => !!d);

  const toggle = (d: Document) => {
    if (saving) return;
    setOrder(prev => (prev.includes(d.id) ? prev.filter(id => id !== d.id) : [...prev, d.id]));
  };

  const merge = async () => {
    if (chosen.length < 2 || saving) return;
    setSaving(true);
    try {
      const name = mergedName(chosen[0]);
      const pdf = needsPdfMerge(chosen);
      const merged = pdf
        ? await mergeDocumentsToPdf(chosen, name, { onProgress: setProgress })
        : await mergeIntoNew(chosen, name);
      bumpLastSaved();
      notifySuccess();
      // The viewer shows the message, with Undo (it covers the app-wide toast
      // host; its "…" menu keeps the Undo too). Undo closes the viewer,
      // removes the merged copy — the originals were never touched
      // (lib/merge-undo) — and reopens Merge with the same choice.
      const undo = newMergeUndo(merged);
      const picked = chosen.map(d => d.id).join(',');
      postViewerNotice({
        docId: merged.id,
        message: mergedNewMessage(chosen.length),
        action: {
          label: 'Undo',
          onPress: () => {
            // The copy goes first, so Merge reopens without it in its list.
            undoNewMerge(undo)
              .then(outcome => {
                bumpLastSaved();
                notifySuccess();
                navigateWhenUnlocked(() => {
                  stackRouter.back();
                  stackRouter.push({ pathname: '/tools/merge', params: { ids: picked } });
                });
                toast.show(mergeUndoneMessage(outcome, pdf));
              })
              .catch(err => {
                console.error('Undo merge failed', err);
                notifyError();
                Alert.alert(MERGE_UNDO_FAILED_TITLE, newMergeUndoFailedMessage(pdf));
              });
          },
        },
      });
      navigateWhenUnlocked(() => router.replace({ pathname: '/viewer', params: { id: merged.id } }));
    } catch (err) {
      notifyError();
      if (err instanceof PdfEditError && err.kind === 'locked') {
        const who = chosen.find(d => d.id === err.docId);
        Alert.alert(`“${who?.name ?? 'A PDF'}” is password protected`, 'Open it and enter its password, then merge again.');
      } else if (err instanceof PdfEditError && err.kind === 'restricted') {
        Alert.alert('A PDF can’t be merged', 'One of these PDFs doesn’t allow changes to its pages. Leave it out and merge the others.');
      } else {
        console.error('Merge failed', err);
        Alert.alert('Couldn’t merge the documents', 'There may not be enough free space. Your documents are unchanged. Try again.');
      }
    } finally {
      setSaving(false);
      setProgress(null);
    }
  };

  if (loaded && docs.length < 2) {
    return (
      <NoDocumentsScreen
        toolTitle="Merge"
        icon="git-merge-outline"
        title={docs.length === 1 ? 'Only one document' : undefined}
        subtitle="Merge joins two or more documents into one. Scan or import another document first."
      />
    );
  }

  const withPdf = needsPdfMerge(chosen);

  return (
    <ToolScreen
      title="Merge"
      busy={saving}
      footer={
        <>
          {progress ? (
            <ToolProgress label="Merging…" current={progress.done} total={progress.total} />
          ) : null}
          <PrimaryButton
            title={chosen.length >= 2 ? `Merge ${chosen.length} documents` : 'Merge documents'}
            icon="git-merge-outline"
            onPress={merge}
            disabled={chosen.length < 2}
            loading={saving}
          />
        </>
      }
    >
      <Text style={[Type.footnote, styles.lead, { color: colors.muted }]}>
        Choose documents in the order their pages should appear. They are joined into a new document; the originals are kept.
      </Text>
      <SectionLabel>{chosen.length ? `Documents, ${chosen.length} chosen` : 'Documents'}</SectionLabel>
      <DocGroup>
        {docs.map(d => {
          const at = order.indexOf(d.id);
          return (
            <DocRow key={d.id} doc={d} multi selected={at >= 0} order={at >= 0 ? at + 1 : undefined} onPress={() => toggle(d)} />
          );
        })}
      </DocGroup>
      <ToolNote>
        {withPdf
          ? 'With a PDF among them, the result is one new PDF: its pages keep their text, and scanned pages are added at your paper size.'
          : pdfMerge
            ? 'Scanned pages keep their filters and can still be cropped. Choosing an imported PDF makes one new PDF instead.'
            : 'Scanned pages keep their filters and can still be cropped.'}
      </ToolNote>
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  lead: { marginTop: Spacing.sm, marginHorizontal: Spacing.xs },
});
