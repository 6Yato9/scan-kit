// components/scan-doc-tools.tsx
// The viewer's whole-document verbs for SCANNED documents, matching what
// imported PDFs get from components/pdf-page-tools.tsx: Merge with another
// document, Split after the page on screen, and Add a blank page after it.
// The viewer puts the rows this returns in its "…" menu and renders `sheets`.
//
// - Merge: another scanned document's pages are appended here (lib/doc-ops
//   mergeInto, shadows included); picking an imported PDF makes one new PDF
//   instead (lib/pdf-edit), both kept — the same sheet and rules as Files.
// - Split: "<name> (1)" and "<name> (2)" (lib/doc-ops splitDocument), keeping
//   or trashing the original, like splitting a PDF.
// - Blank page: a white page the size of the page on screen, inserted after
//   it (lib/blank-page.ts), with Undo.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionSheetIOS, Alert, Platform } from 'react-native';
import type { useRouter } from 'expo-router';
import type { Document } from '@/types/document';
import type { PageEdit } from '@/lib/bake';
import { remapForDelete } from '@/lib/bake';
import { mergeInto, splitDocument } from '@/lib/doc-ops';
import { mergeDocumentsToPdf, needsPdfMerge, PdfEditError } from '@/lib/pdf-edit';
import {
  blankPageSize,
  blankPageUndo,
  canUndoBlankPage,
  insertBlankPageFiles,
  removeBlankPageFiles,
  type BlankPageUndo,
} from '@/lib/blank-page';
import { getImageSize } from '@/lib/image-size';
import { pageFileUri } from '@/lib/image';
import { getDocuments } from '@/lib/storage';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { postViewerNotice } from '@/lib/viewer-notice';
import type { MoreAction } from '@/components/viewer-more-sheet';
import { MergeSheet } from '@/components/merge-sheet';

type Toast = { show: (message: string, options?: { action?: { label: string; onPress: () => void } }) => void };

class BlankUndoRefused extends Error {}

type Options = {
  /** Null while loading; an imported PDF gets nothing here. */
  document: Document | null;
  /** The page on screen (zero-based). */
  page: number;
  /** The viewer's one page-edit path (reads the stored record under the page lock, then shows the result). */
  editDocument: (edit: PageEdit, fn: (fresh: Document) => Promise<Partial<Document> | null>) => Promise<Document>;
  toast: Toast;
  router: ReturnType<typeof useRouter>;
  /** Show page `index` (after an insert or its Undo). */
  showPage: (index: number) => void;
  /** Read the document again (after a merge appended pages). */
  reload: () => Promise<void>;
  /** A change that offers no Undo was made: the viewer's last Undo no longer applies. */
  onEdited: () => void;
  /** A new document was saved (split, PDF merge). */
  onCreated?: () => void;
};

export function useScanDocTools({ document, page, editDocument, toast, router, showPage, reload, onEdited, onCreated }: Options) {
  const [mergeDocs, setMergeDocs] = useState<Document[] | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const scanned = !!document && !document.pdfUri && document.pages.length > 0;
  const n = document?.pages.length ?? 0;
  const at = Math.max(0, Math.min(page, n - 1));
  const docId = document?.id ?? '';

  // ── Blank page ─────────────────────────────────────────────────────────────

  const undoBlank = useCallback(async (undo: BlankPageUndo) => {
    try {
      await editDocument({ remap: remapForDelete(undo.index) }, async fresh => {
        if (!canUndoBlankPage(undo, fresh)) throw new BlankUndoRefused();
        return removeBlankPageFiles(fresh, undo);
      });
      if (mounted.current) showPage(Math.max(0, undo.index - 1));
      notifySuccess();
    } catch (err) {
      notifyError();
      if (err instanceof BlankUndoRefused) {
        Alert.alert('Couldn’t undo', 'The pages have been moved or deleted since, so the blank page can’t be taken out.');
      } else {
        console.error('Undo blank page failed', err);
        Alert.alert('Couldn’t remove the blank page', 'Try again.');
        reload().catch(() => {});
      }
    }
  }, [editDocument, showPage, reload]);

  const addBlank = useCallback(async () => {
    if (!scanned || busy.current) return;
    busy.current = true;
    const after = at;
    try {
      // The size of the page it follows, so the document prints evenly.
      const size = blankPageSize(await getImageSize(pageFileUri(docId, after)));
      await editDocument({ remap: i => (i > after ? i + 1 : i) }, async fresh => {
        if (after >= fresh.pages.length) throw new Error('page gone');
        return insertBlankPageFiles(fresh, after, size);
      });
      const index = after + 1;
      const undo = blankPageUndo(docId, index);
      if (mounted.current) showPage(index);
      notifySuccess();
      toast.show(`Blank page added after page ${after + 1}`, {
        action: { label: 'Undo', onPress: () => { undoBlank(undo); } },
      });
    } catch (err) {
      console.error('Add blank page failed', err);
      notifyError();
      Alert.alert('Couldn’t add a blank page', 'Your pages are unchanged. Try again.');
      reload().catch(() => {});
    } finally {
      busy.current = false;
    }
  }, [scanned, at, docId, editDocument, showPage, toast, undoBlank, reload]);

  // ── Split ──────────────────────────────────────────────────────────────────

  const doSplit = useCallback(async (after: number, trashOriginal: boolean) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const { first, originalTrashed } = await splitDocument(docId, after, { trashOriginal, expectedCount: n });
      onCreated?.();
      notifySuccess();
      if (originalTrashed) {
        // The original is in Recently deleted: carry on in the first part.
        // The new viewer shows the message (this one is going away).
        postViewerNotice({ docId: first.id, message: 'Split into two documents. The original is in Recently deleted.' });
        navigateWhenUnlocked(() => router.replace({ pathname: '/viewer', params: { id: first.id } }));
      } else if (mounted.current) {
        toast.show('Split into two documents', {
          action: { label: 'Open', onPress: () => router.replace({ pathname: '/viewer', params: { id: first.id } }) },
        });
      }
    } catch (err) {
      console.error('Split failed', err);
      notifyError();
      Alert.alert('Couldn’t split the document', 'Your document is unchanged. Check that there’s free space, then try again.');
    } finally {
      busy.current = false;
    }
  }, [docId, n, onCreated, router, toast]);

  const split = useCallback(() => {
    if (!scanned || n < 2) return;
    // After the page on screen; on the last page, before it.
    const after = Math.min(at, n - 2);
    const first = after + 1;
    const range = (a: number, b: number) => (a === b ? `Page ${a}` : `Pages ${a}–${b}`);
    const title = `Split after page ${first}`;
    const message = `${range(1, first)} and ${range(first + 1, n).toLowerCase()} become two new documents.`;
    const keep = 'Split and keep the original';
    const remove = 'Split and delete the original';
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { title, message, options: [keep, remove, 'Cancel'], cancelButtonIndex: 2, destructiveButtonIndex: 1, userInterfaceStyle: 'dark' },
        i => {
          if (i === 0) doSplit(after, false);
          else if (i === 1) doSplit(after, true);
        },
      );
    } else {
      Alert.alert(title, message, [
        { text: keep, onPress: () => { doSplit(after, false); } },
        { text: remove, style: 'destructive', onPress: () => { doSplit(after, true); } },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }, [scanned, n, at, doSplit]);

  // ── Merge ──────────────────────────────────────────────────────────────────

  const openMerge = useCallback(() => {
    getDocuments()
      .then(all => { if (mounted.current) setMergeDocs(all.filter(d => !d.trashedAt)); })
      .catch(() => { if (mounted.current) setMergeDocs([]); });
  }, []);

  const handleMerge = useCallback(async (target: Document, source: Document) => {
    if (busy.current) return;
    busy.current = true;
    try {
      if (needsPdfMerge([target, source])) {
        // A PDF in the pair: one new PDF, both originals kept.
        const merged = await mergeDocumentsToPdf([target, source], `${target.name} (merged)`);
        onCreated?.();
        notifySuccess();
        if (mounted.current) {
          toast.show(`Saved “${merged.name}”`, {
            action: { label: 'Open', onPress: () => router.replace({ pathname: '/viewer', params: { id: merged.id } }) },
          });
        }
        return;
      }
      const updated = await mergeInto(target, source);
      if (!updated) return;
      onEdited();
      await reload();
      notifySuccess();
      const added = updated.pages.length - target.pages.length;
      const count = added > 0 ? added : source.pages.length;
      if (mounted.current) {
        showPage(target.pages.length);
        toast.show(`Added ${count} page${count === 1 ? '' : 's'} from “${source.name}”`);
      }
    } catch (err) {
      notifyError();
      if (err instanceof PdfEditError && err.kind === 'locked') {
        const who = [target, source].find(d => d.id === err.docId);
        Alert.alert(`“${who?.name ?? 'This PDF'}” is password protected`, 'Open it and enter its password, then merge again.');
      } else if (err instanceof PdfEditError && err.kind === 'restricted') {
        Alert.alert('This PDF can’t be merged', 'Its author doesn’t allow changes to its pages.');
      } else {
        console.error('Merge failed', err);
        Alert.alert('Couldn’t merge the documents', 'There may not be enough free space. Try again.');
      }
    } finally {
      busy.current = false;
    }
  }, [onCreated, onEdited, reload, router, showPage, toast]);

  const pageWord = n > 1 ? `page ${at + 1}` : 'page';
  /** Document-level rows for the "…" menu. */
  const documentRows: MoreAction[] = !scanned ? [] : [
    { key: 'merge', icon: 'git-merge-outline', label: 'Merge with another document', onPress: openMerge },
    ...(n > 1 ? [{ key: 'split', icon: 'split' as const, label: `Split after page ${Math.min(at, n - 2) + 1}`, onPress: split }] : []),
  ];
  /** Rows for the page on screen. */
  const pageRows: MoreAction[] = !scanned ? [] : [
    { key: 'blank', icon: 'document-outline', label: `Add a blank page after ${pageWord}`, onPress: () => { addBlank(); } },
  ];

  const sheets = (
    <MergeSheet
      visible={mergeDocs !== null}
      targetDoc={document}
      allDocs={mergeDocs ?? []}
      onMerge={(target, source) => { handleMerge(target, source); }}
      onClose={() => setMergeDocs(null)}
    />
  );

  return { documentRows, pageRows, sheets };
}
