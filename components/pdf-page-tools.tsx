// components/pdf-page-tools.tsx
// Page editing for an imported PDF in the viewer, without converting it to
// images: Fill & sign (app/pdf-fill.tsx, its own screen), Rotate, Blank page,
// Reorder, Split and Delete in a toolbar under the
// pages (the same toolbar image pages have, with the viewer's Tools button
// pinned at its end — `pinnedItem`), the same actions for the page on
// screen in the "…" sheet, and Merge with another document. Every edit is
// written into the PDF itself by lib/pdf-edit.ts (text stays selectable) and
// offers Undo in a toast.
//
// The viewer owns the PDF view; this hook tells it when to reload the file
// (`viewKey`) and which page to open at (`initialPage`), so an edit never
// throws the reader back to page 1.
//
// A password-protected PDF unlocked for this session (lib/pdf-session.ts) is
// read from its decrypted copy (`readableUri`, from the viewer); its edits
// stay protected (lib/pdf-edit.ts rewriteStoredPdf). Splitting it says first
// that the new documents won't need a password.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import { ActionSheet } from '@/components/action-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { useRouter } from 'expo-router';
import type { Document } from '@/types/document';
import {
  canEditPdfPages,
  canMergePdfDocuments,
  deletePlan,
  discardPdfEditUndo,
  editStoredPdf,
  insertBlankPlan,
  mergeDocumentsToPdf,
  newIndexOf,
  PdfEditError,
  reorderPlan,
  rotatePlan,
  splitStoredPdf,
  undoPdfEdit,
  type PdfEditUndo,
  type PdfPlan,
} from '@/lib/pdf-edit';
import { pdfPageThumbnails } from '@/lib/pdf-thumb';
import { SIGNED_PDF_CHANGE, canFillPdf, isDigitallySigned, pdfFillHref, subscribePdfRewrites, takePendingRewrite } from '@/lib/pdf-fill';
import { fillBlockedReason, useFillAccess } from '@/lib/fill-access';
import { getDocument, getDocuments } from '@/lib/storage';
import {
  MERGE_UNDO_FAILED_TITLE,
  mergedNewMessage,
  mergeUndoneMessage,
  newMergeUndo,
  newMergeUndoFailedMessage,
  undoNewMerge,
} from '@/lib/merge-undo';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { postViewerNotice } from '@/lib/viewer-notice';
import { LOCKED_MERGE_BODY, protectedEditRefusal, withNoPasswordNote } from '@/lib/pdf-session';
import { useTheme } from '@/contexts/theme-context';
import { Radius, Spacing, Type } from '@/lib/theme';
import { ViewerToolbar, type ToolbarItem } from '@/components/viewer-toolbar';
import type { MoreAction } from '@/components/viewer-more-sheet';
import { ReorderModal } from '@/components/reorder-modal';
import { MergeSheet } from '@/components/merge-sheet';

type Toast = { show: (message: string, options?: { action?: { label: string; onPress: () => void } }) => void };

type Busy = 'rotate' | 'blank' | 'delete' | 'reorder' | 'split' | 'merge' | 'undo';

// The PDF itself changed (or was put back) but the document's record couldn't
// be updated (lib/pdf-edit.ts kind 'partial'): never "unchanged".
const PARTIAL_EDIT = {
  title: 'Your PDF was changed',
  body: 'Scan Kit couldn’t finish saving the change, so it can’t be undone. It’s finished the next time Scan Kit opens. Check that there’s free space.',
};
const PARTIAL_UNDO = {
  title: 'The change was undone',
  body: 'Scan Kit couldn’t finish saving it. It’s finished the next time Scan Kit opens. Check that there’s free space.',
};

const BUSY_LABEL: Record<Busy, string> = {
  rotate: 'Rotating',
  blank: 'Adding a page',
  delete: 'Deleting the page',
  reorder: 'Preparing pages',
  split: 'Splitting',
  merge: 'Merging',
  undo: 'Undoing',
};

type Options = {
  /** Null while the viewer is loading. */
  document: Document | null;
  /** The file to read the PDF's content from (lib/pdf-session useReadablePdfUri); null while it is being made. */
  readableUri: string | null;
  /** The PDF is password protected and unlocked for this session. */
  unlockedForSession: boolean;
  /** The page on screen (zero-based) and the page count, from the PDF view; null until it has loaded. */
  page: number;
  pageCount: number | null;
  /** False while the PDF can't be shown (locked, damaged) or is being converted. */
  enabled: boolean;
  toast: Toast;
  router: ReturnType<typeof useRouter>;
  /** The record after an edit (the viewer shows it). */
  onDocument: (doc: Document) => void;
  /** The document is gone. */
  onMissing: () => void;
  /** The PDF needs its password: the viewer's unlock flow. */
  onLocked: () => void;
  /** A new document was saved (split, merge). */
  onCreated?: () => void;
  /** Offers an Undo in the viewer's "…" menu only (lib/last-undo.ts), for a toast whose action is Open. */
  offerUndo?: (message: string, run: () => void) => void;
  /** Pinned at the end of the toolbar (the viewer's Tools button); shown even when pages can't be edited. */
  pinnedItem?: ToolbarItem;
};

export function usePdfPageTools({
  document,
  readableUri,
  unlockedForSession,
  page,
  pageCount,
  enabled,
  toast,
  router,
  onDocument,
  onMissing,
  onLocked,
  onCreated,
  offerUndo,
  pinnedItem,
}: Options) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState<Busy | null>(null);
  const busyRef = useRef(false);
  // The user agreed to invalidate this PDF's digital signature (asked once per viewer).
  const signedOkRef = useRef(false);
  const [viewKey, setViewKey] = useState(0);
  const [initialPage, setInitialPage] = useState(0);
  const [reorderPages, setReorderPages] = useState<string[] | null>(null);
  const [reorderSaving, setReorderSaving] = useState(false);
  const [mergeDocs, setMergeDocs] = useState<Document[] | null>(null);
  const undoRef = useRef<PdfEditUndo | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Nobody can press Undo once the viewer is gone.
      discardPdfEditUndo(undoRef.current);
      undoRef.current = null;
    };
  }, []);

  const docId = document?.id ?? '';
  // What the tools read: the session copy of a protected PDF, else the stored file.
  const pdfUri = document?.pdfUri ? readableUri : null;
  const available = canEditPdfPages() && !!document?.pdfUri;
  const n = pageCount ?? 0;
  const ready = available && enabled && n > 0 && busy === null;
  const at = Math.max(0, Math.min(page, n - 1));

  /** Shows the edited PDF, opened at `showPage`. */
  const showEdited = useCallback((doc: Document, showPage: number) => {
    onDocument(doc);
    setInitialPage(Math.max(0, showPage));
    setViewKey(k => k + 1);
  }, [onDocument]);

  /** After a 'partial' edit or Undo: shows the PDF that is there now, and says what happened. */
  const showPartial = useCallback(async (showPage: number, copy: { title: string; body: string }) => {
    notifyError();
    try {
      const doc = (await getDocuments()).find(d => d.id === docId);
      if (doc && mounted.current) showEdited(doc, showPage);
    } catch {}
    // After Reorder (a Modal) has closed: an alert presented over a Modal
    // that is being dismissed goes with it.
    setTimeout(() => { if (mounted.current) Alert.alert(copy.title, copy.body); }, 600);
  }, [docId, showEdited]);

  // A viewer opened by Fill & sign (from Tools) shows the page it changed.
  useEffect(() => {
    if (!docId) return;
    const p = takePendingRewrite(docId);
    if (p != null) setInitialPage(p);
  }, [docId]);

  // Fill & sign (its own screen) rewrote this PDF, or its Undo put it back:
  // show the file that is there now, at the page it changed.
  useEffect(() => {
    if (!docId) return;
    return subscribePdfRewrites((id, showPage) => {
      if (id !== docId) return;
      takePendingRewrite(id);
      getDocument(id)
        .then(doc => { if (doc && mounted.current) showEdited(doc, showPage); })
        .catch(() => {});
    });
  }, [docId, showEdited]);

  /** Opens Fill & sign at the page on screen. */
  const openFill = useCallback(() => {
    if (!docId || busyRef.current) return;
    router.push(pdfFillHref(docId, at, true));
  }, [docId, at, router]);
  const fillAvailable = canFillPdf() && !!pdfUri;
  // What Fill & sign may do with this PDF, read before it is offered (a PDF
  // whose author forbids changes would open on a dead end). Re-read after edits.
  const fillAccess = useFillAccess(fillAvailable ? pdfUri : null, viewKey);
  const fillBlocked = fillBlockedReason(fillAccess);

  const explain = useCallback((err: unknown, what: string) => {
    const kind = err instanceof PdfEditError ? err.kind : 'failed';
    if (kind === 'missing') {
      onMissing();
      return;
    }
    notifyError();
    const refusal = protectedEditRefusal(err);
    if (refusal) {
      // A protected PDF unlocked this session that can't be written back as
      // protected (lib/pdf-session.ts): opened with its owner password.
      const ownerPassword = err instanceof Error && err.message === 'owner-password';
      Alert.alert(refusal.title, refusal.body, ownerPassword
        ? [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Unlock PDF', onPress: () => router.push({ pathname: '/tools/unrestrict', params: { docId } } as never) },
          ]
        : undefined);
    } else if (kind === 'locked') {
      onLocked();
    } else if (kind === 'restricted') {
      Alert.alert('This PDF can’t be changed', 'Its author doesn’t allow changes to its pages. You can still view, share and print it.');
    } else if (kind === 'unavailable') {
      Alert.alert(`Couldn’t ${what}`, 'This version of Scan Kit can’t edit PDF pages.');
    } else if (kind === 'unreadable') {
      Alert.alert('Couldn’t read this PDF', 'The file may be damaged. Try importing it again.');
    } else if (kind === 'changed') {
      Alert.alert(`Couldn’t ${what}`, 'The document changed in the meantime. Try again.');
    } else {
      console.error(`PDF edit (${what}) failed`, err);
      Alert.alert(`Couldn’t ${what}`, 'Your PDF is unchanged. Check that there’s free space, then try again.');
    }
  }, [onMissing, onLocked, router, docId]);

  const handleUndo = useCallback(async (undo: PdfEditUndo, showPage: number) => {
    if (busyRef.current) return;
    if (undoRef.current === undo) undoRef.current = null;
    busyRef.current = true;
    setBusy('undo');
    try {
      const doc = await undoPdfEdit(undo);
      if (!mounted.current) return;
      showEdited(doc, showPage);
    } catch (err) {
      if (!mounted.current) return;
      const kind = err instanceof PdfEditError ? err.kind : 'failed';
      if (kind === 'missing') onMissing();
      else if (kind === 'partial') await showPartial(showPage, PARTIAL_UNDO);
      else toast.show(kind === 'changed' ? 'Can’t undo: the PDF has changed since' : 'Couldn’t undo');
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    }
  }, [showEdited, onMissing, toast, showPartial]);

  /** Runs one edit: writes it, shows the result at `showPage`, offers Undo. */
  const runEdit = useCallback(async (
    kind: Busy,
    plan: PdfPlan,
    message: string,
    showPage: number,
    what: string,
    undoPage: number = at,
  ): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    // A digitally signed PDF: any change invalidates the signature; ask once (F1, round 13b).
    if (!signedOkRef.current && pdfUri && (await isDigitallySigned(pdfUri))) {
      const go = await new Promise<boolean>(resolve => {
        Alert.alert(SIGNED_PDF_CHANGE.title, SIGNED_PDF_CHANGE.body, [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: SIGNED_PDF_CHANGE.confirm, style: 'destructive', onPress: () => resolve(true) },
        ], { cancelable: false });
      });
      if (!go || !mounted.current) {
        busyRef.current = false;
        return false;
      }
      signedOkRef.current = true;
    }
    setBusy(kind);
    try {
      const { doc, undo } = await editStoredPdf(docId, plan);
      if (!mounted.current) {
        discardPdfEditUndo(undo);
        return true;
      }
      if (undoRef.current && undoRef.current !== undo) discardPdfEditUndo(undoRef.current);
      undoRef.current = undo;
      showEdited(doc, showPage);
      notifySuccess();
      toast.show(message, undo ? { action: { label: 'Undo', onPress: () => { handleUndo(undo, undoPage); } } } : undefined);
      return true;
    } catch (err) {
      if (!mounted.current) return false;
      if (err instanceof PdfEditError && err.kind === 'partial') {
        await showPartial(showPage, PARTIAL_EDIT);
        return true; // the PDF did change: e.g. Reorder closes
      }
      explain(err, what);
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    }
  }, [docId, pdfUri, at, showEdited, toast, handleUndo, explain, showPartial]);

  const rotate = useCallback((degrees: 90 | -90) => {
    if (!ready) return;
    runEdit('rotate', rotatePlan(n, at, degrees), n > 1 ? `Page ${at + 1} rotated` : 'Page rotated', at, 'rotate the page');
  }, [ready, n, at, runEdit]);

  const insertBlank = useCallback(() => {
    if (!ready) return;
    runEdit('blank', insertBlankPlan(n, at), `Blank page added after page ${at + 1}`, at + 1, 'add a page');
  }, [ready, n, at, runEdit]);

  const deletePage = useCallback(() => {
    if (!ready || n < 2) return;
    runEdit('delete', deletePlan(n, at), `Page ${at + 1} deleted`, Math.min(at, n - 2), 'delete the page');
  }, [ready, n, at, runEdit]);

  // ── Reorder ────────────────────────────────────────────────────────────────

  const openReorder = useCallback(async () => {
    if (!ready || n < 2 || !pdfUri || busyRef.current) return;
    busyRef.current = true;
    setBusy('reorder');
    try {
      const thumbs = await pdfPageThumbnails(docId, pdfUri);
      if (!mounted.current) return;
      if (thumbs.length !== n) throw new PdfEditError('changed', 'page count changed');
      setReorderPages(thumbs);
    } catch (err) {
      if (mounted.current) explain(err instanceof PdfEditError ? err : new PdfEditError('failed', String(err)), 'show the pages');
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    }
  }, [ready, n, docId, pdfUri, explain]);

  const confirmReorder = useCallback(async (order: number[]) => {
    setReorderSaving(true);
    const showPage = newIndexOf(order, at);
    const ok = await runEdit('reorder', reorderPlan(order), 'Pages reordered', showPage, 'reorder the pages');
    if (!mounted.current) return;
    setReorderSaving(false);
    if (ok) setReorderPages(null);
  }, [at, runEdit]);

  // ── Split ──────────────────────────────────────────────────────────────────

  const doSplit = useCallback(async (after: number, trashOriginal: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy('split');
    try {
      const { first, originalTrashed } = await splitStoredPdf(docId, after, { trashOriginal });
      onCreated?.();
      notifySuccess();
      if (originalTrashed) {
        // The original is in Recently deleted: carry on in the first part.
        // The new viewer shows it (this one, and its toasts, are going away).
        postViewerNotice({ docId: first.id, message: withNoPasswordNote('Split into two documents. The original is in Recently deleted.', [docId]) });
        navigateWhenUnlocked(() => router.replace({ pathname: '/viewer', params: { id: first.id } }));
      } else if (mounted.current) {
        toast.show(withNoPasswordNote('Split into two documents', [docId]), {
          action: { label: 'Open', onPress: () => router.replace({ pathname: '/viewer', params: { id: first.id } }) },
        });
      }
    } catch (err) {
      if (mounted.current) explain(err, 'split the PDF');
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    }
  }, [docId, router, toast, explain, onCreated]);

  const split = useCallback(() => {
    if (!ready || n < 2) return;
    // After the page on screen; on the last page, before it.
    const after = Math.min(at, n - 2);
    const first = after + 1;
    const range = (a: number, b: number) => (a === b ? `Page ${a}` : `Pages ${a}–${b}`);
    const title = `Split after page ${first}`;
    const message = `${range(1, first)} and ${range(first + 1, n).toLowerCase()} become two new documents.${
      unlockedForSession ? ' They won’t need a password.' : ''
    }`;
    const keep = 'Split and keep the original';
    const remove = 'Split and delete the original';
    ActionSheet.showActionSheetWithOptions(
      {
        title,
        message,
        options: [keep, remove, 'Cancel'],
        cancelButtonIndex: 2,
        destructiveButtonIndex: 1,
        userInterfaceStyle: 'dark',
        icons: ['documents-outline', 'trash-outline'],
      },
      i => {
        if (i === 0) doSplit(after, false);
        else if (i === 1) doSplit(after, true);
      },
    );
  }, [ready, n, at, doSplit, unlockedForSession]);

  // ── Merge ──────────────────────────────────────────────────────────────────

  const openMerge = useCallback(() => {
    getDocuments()
      .then(all => { if (mounted.current) setMergeDocs(all.filter(d => !d.trashedAt)); })
      .catch(() => { if (mounted.current) setMergeDocs([]); });
  }, []);

  const handleMerge = useCallback(async (target: Document, source: Document) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy('merge');
    try {
      const merged = await mergeDocumentsToPdf([target, source], `${target.name} (merged)`);
      onCreated?.();
      notifySuccess();
      if (mounted.current) {
        // The toast opens the new PDF; its Undo waits in the "…" menu (lib/merge-undo.ts:
        // the copy goes, the originals were never touched).
        const undo = newMergeUndo(merged);
        offerUndo?.(mergedNewMessage(2), () => {
          undoNewMerge(undo)
            .then(outcome => {
              onCreated?.();
              notifySuccess();
              if (mounted.current) toast.show(mergeUndoneMessage(outcome, true));
            })
            .catch(err => {
              console.error('Undo merge failed', err);
              notifyError();
              Alert.alert(MERGE_UNDO_FAILED_TITLE, newMergeUndoFailedMessage(true));
            });
        });
        toast.show(withNoPasswordNote(mergedNewMessage(2), [target.id, source.id]), {
          action: { label: 'Open', onPress: () => router.replace({ pathname: '/viewer', params: { id: merged.id } }) },
        });
      }
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof PdfEditError && err.kind === 'locked' && err.docId && err.docId !== docId) {
        notifyError();
        Alert.alert(
          `“${source.name}” is password protected`,
          LOCKED_MERGE_BODY,
        );
      } else {
        explain(err, 'merge the documents');
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    }
  }, [docId, router, toast, explain, onCreated, offerUndo]);

  // ── What the viewer shows ──────────────────────────────────────────────────

  const toolbarItems: ToolbarItem[] = [
    ...(fillAvailable
      ? [{
          key: 'fill',
          icon: 'signature' as const,
          label: 'Fill & sign',
          a11y: 'Fill and sign',
          hint: fillBlocked
            ? `Not available. ${fillBlocked}`
            : fillAccess?.kind === 'form'
              ? 'Fill in the form. Its author doesn’t allow adding text or signatures.'
              : 'Fill in the form, add text, a date, check marks or your signature',
          onPress: openFill,
          disabled: !enabled || n === 0 || busy !== null || !!fillBlocked,
        }]
      : []),
    {
      key: 'rotate',
      icon: 'refresh-outline',
      label: 'Rotate',
      a11y: n > 1 ? `Rotate page ${at + 1} clockwise` : 'Rotate page clockwise',
      hint: 'Touch and hold to rotate counterclockwise',
      onPress: () => rotate(90),
      onLongPress: () => rotate(-90),
      longPressLabel: 'Rotate counterclockwise',
      busy: busy === 'rotate',
      disabled: !ready && busy !== 'rotate',
    },
    {
      key: 'blank',
      icon: 'document-outline',
      label: 'Blank page',
      a11y: n > 1 ? `Add a blank page after page ${at + 1}` : 'Add a blank page',
      onPress: insertBlank,
      busy: busy === 'blank',
      disabled: !ready && busy !== 'blank',
    },
    {
      key: 'reorder',
      icon: 'reorder-three-outline',
      label: 'Reorder',
      a11y: 'Reorder pages',
      onPress: () => { openReorder(); },
      busy: busy === 'reorder',
      disabled: (!ready || n < 2) && busy !== 'reorder',
    },
    {
      key: 'split',
      // Not the scissors: they are Extract pages.
      icon: 'split',
      label: 'Split',
      a11y: n > 1 ? `Split after page ${Math.min(at, n - 2) + 1}` : 'Split',
      onPress: split,
      busy: busy === 'split',
      disabled: (!ready || n < 2) && busy !== 'split',
    },
    {
      key: 'delete',
      icon: 'trash-outline',
      label: 'Delete',
      a11y: n > 1 ? `Delete page ${at + 1}` : 'Delete page',
      hint: n < 2 ? 'A PDF keeps at least one page' : undefined,
      onPress: deletePage,
      busy: busy === 'delete',
      disabled: (!ready || n < 2) && busy !== 'delete',
    },
  ];

  const toolbar = available || pinnedItem ? (
    <View style={{ backgroundColor: colors.chromeRaised, paddingBottom: Math.max(insets.bottom, Spacing.sm) }}>
      <ViewerToolbar items={available ? toolbarItems : []} pinned={pinnedItem} />
      {/* The toolbar's bottom hairline separates it from the thumbnail strip on
          image pages; here only the home indicator follows, so it is covered. */}
      <View style={[styles.hideRule, { backgroundColor: colors.chromeRaised }]} />
    </View>
  ) : null;

  const pageWord = n > 1 ? `page ${at + 1}` : 'page';
  /** Rows for the "…" sheet: document-level, then the page on screen. */
  const documentRows: MoreAction[] = !available ? [] : [
    ...(ready && n > 1 ? [{ key: 'pdf-reorder', icon: 'reorder-three-outline' as const, label: 'Reorder pages', onPress: () => { openReorder(); } }] : []),
    ...(canMergePdfDocuments()
      ? [{ key: 'pdf-merge', icon: 'git-merge-outline' as const, label: 'Merge with another document', onPress: openMerge }]
      : []),
  ];
  const pageRows: MoreAction[] = !ready ? [] : [
    // The same turn as the toolbar's Rotate (clockwise; touch and hold it to turn the other way).
    { key: 'pdf-rotate', icon: 'refresh-outline', label: `Rotate ${pageWord} clockwise`, onPress: () => rotate(90) },
    { key: 'pdf-blank', icon: 'document-outline', label: `Add a blank page after ${pageWord}`, onPress: insertBlank },
    ...(n > 1
      ? [{ key: 'pdf-split', icon: 'split' as const, label: `Split after page ${Math.min(at, n - 2) + 1}`, onPress: split }]
      : []),
  ];
  const deleteRow: MoreAction | null = ready && n > 1
    ? { key: 'pdf-delete-page', icon: 'trash-outline', label: `Delete page ${at + 1}`, destructive: true, onPress: deletePage }
    : null;

  const busyOverlay: ReactNode = busy === 'split' || busy === 'merge' || busy === 'undo' ? (
    <View style={styles.overlay} pointerEvents="auto" accessibilityViewIsModal>
      <View style={[styles.busyCard, { backgroundColor: colors.chromeRaised, borderColor: colors.chromeBorder }]}>
        <ActivityIndicator color={colors.chromeText} />
        <Text style={[Type.subhead, { color: colors.chromeText }]} accessibilityLiveRegion="polite">
          {BUSY_LABEL[busy]}…
        </Text>
      </View>
    </View>
  ) : null;

  const sheets = (
    <>
      <ReorderModal
        visible={reorderPages !== null}
        pages={reorderPages ?? []}
        saving={reorderSaving}
        onConfirm={order => { confirmReorder(order); }}
        onCancel={() => { setReorderPages(null); setReorderSaving(false); }}
      />
      <MergeSheet
        visible={mergeDocs !== null}
        targetDoc={document}
        allDocs={mergeDocs ?? []}
        onMerge={(target, source) => { handleMerge(target, source); }}
        onClose={() => setMergeDocs(null)}
      />
      {busyOverlay}
    </>
  );

  /** The "…" sheet's tool tile. */
  const fillTool: MoreAction | null = fillAvailable && enabled && !fillBlocked
    ? { key: 'fill', tool: 'fill', icon: 'signature', label: fillAccess?.kind === 'form' ? 'Fill in' : 'Fill & sign', onPress: openFill }
    : null;

  return {
    available,
    busy,
    toolbar,
    documentRows,
    pageRows,
    deleteRow,
    sheets,
    viewKey,
    initialPage,
    fillTool,
    fillAccess,
    // For the viewer's Tools sheet: the same Merge and Split as the rows above,
    // offered only when they would run now.
    merge: available && canMergePdfDocuments() ? openMerge : null,
    split: ready && n > 1 ? split : null,
  };
}

const styles = StyleSheet.create({
  hideRule: { height: StyleSheet.hairlineWidth, marginTop: -StyleSheet.hairlineWidth },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  busyCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm + 2,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
