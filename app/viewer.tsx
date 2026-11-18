// app/viewer.tsx
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import DocumentScanner from 'react-native-document-scanner-plugin';
import {
  getDocuments,
  getFolders,
  getScanSettings,
  patchDocument,
  restoreDocument,
  saveFolder,
  subscribeDocumentChanges,
  trashDocument,
  updateDocument,
} from '@/lib/storage';
import { deleteSinglePage, reorderPages } from '@/lib/files';
import { cropPage, pageFileUri, rotatePage } from '@/lib/image';
import {
  bakePage,
  PageEdit,
  pendingBakesFor,
  remapForDelete,
  remapForReorder,
  runPageEdit,
  subscribeBakeChanges,
  withDocLock,
} from '@/lib/bake';
import { addPagesToDocument, finishAddedPages } from '@/lib/add-pages';
import { RetakeError, retakePage, undoRetake, type RetakeUndo } from '@/lib/retake-page';
import { duplicateDocument } from '@/lib/doc-ops';
import {
  canConvertPdf,
  convertPdfToPages,
  discardConvertUndo,
  PdfConvertError,
  undoPdfConversion,
  type ConvertProgress,
  type ConvertUndo,
} from '@/lib/convert-pdf';
import { indexDocText } from '@/lib/save-scan';
import { indexPdfText, needsPdfText } from '@/lib/pdf-text';
import { PdfUnlockError, pdfUnlockAvailable, unlockStoredPdf } from '@/lib/pdf-unlock';
import { subscribeViewerNotices, takeViewerNotice } from '@/lib/viewer-notice';
import { takeNewDocumentNote, uncroppedMessage } from '@/lib/new-doc-note';
import { alertScanError, deleteTempFiles, pickPhotos, scanWithCamera, ToolScanError } from '@/lib/tool-scan';
import { withSystemUI } from '@/lib/system-ui';
import { insertAt, restoreStashedPage, stashPage } from '@/lib/page-undo';
import { notifySuccess, notifyError } from '@/lib/haptics';
import { ocrAvailable, recognizeLines, extractDocText } from '@/lib/ocr';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import {
  exportFileName,
  makeExportDir,
  placeExportFile,
  printFile,
  shareFile,
  ShareError,
  shareText,
} from '@/lib/share';
import { Document, PageAdjustment, PageFilter } from '@/types/document';
import { DarkThemeScope, useTheme } from '@/contexts/theme-context';
import { QUALITY_MAP, SCAN_QUALITY_MAP, useScan } from '@/contexts/scan-context';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';
import { ExportSheet } from '@/components/export-sheet';
import { EditTab, FILTER_LABELS, PageEditPanel } from '@/components/page-actions-sheet';
import { movedOrder, ThumbnailStrip } from '@/components/thumbnail-strip';
import { ViewerToolbar } from '@/components/viewer-toolbar';
import { AppIcon } from '@/components/app-icon';
import { MoreAction, ViewerMoreSheet } from '@/components/viewer-more-sheet';
import { ToastProvider, useToast } from '@/components/toast';
import { ReorderModal } from '@/components/reorder-modal';
import { RenameSheet } from '@/components/rename-sheet';
import { MoveFolderSheet } from '@/components/move-folder-sheet';
import { CropModal, CropRect } from '@/components/crop-modal';
import { FilterBaker } from '@/components/filter-baker';
import { EmptyState } from '@/components/empty-state';
import { BakeIndicator } from '@/components/bake-indicator';
import { PdfConvertBanner, useConvertBannerDismissed } from '@/components/pdf-convert-banner';
import { PdfDocumentView } from '@/modules/vision-ocr/src/PdfDocumentView';
import { BottomSheet, SheetHeader } from '@/components/bottom-sheet';
import { PrimaryButton } from '@/components/primary-button';
import { HeaderIconButton, ScreenHeader } from '@/components/screen-header';
import { LockScreen, useAppLocked } from '@/components/lock-gate';

const DEFAULT_ADJ: PageAdjustment = { brightness: 0, contrast: 0, saturation: 0 };
const isDefaultAdj = (a: PageAdjustment | undefined) =>
  !a || (a.brightness === 0 && a.contrast === 0 && a.saturation === 0);

type OcrState = { status: 'running' } | { status: 'done'; text: string };

/**
 * The viewer is a fullScreenModal, which covers the app-wide toast host, so it
 * hosts its own: toasts raised in here (export, Save to Photos, Apply to all)
 * show on top of the page. `rootToast` is for messages that must outlive this
 * screen, such as "Moved to Recently deleted" with Undo after leaving it.
 */
export default function ViewerScreen() {
  const rootToast = useToast();
  // App Lock: normally the /lock route covers this screen. Should the viewer
  // ever end up above it (work that finished while locked), it draws the lock
  // itself, so a document is never usable without unlocking (lock-gate.tsx).
  const locked = useAppLocked();
  // Toasts sit just above the toolbar, over the page counter in the margin
  // under the page: never on the toolbar, where they'd hide its labels and
  // swallow its taps. Distance of their bottom edge above the screen's bottom
  // (null until the counter row is laid out).
  const [toastBottom, setToastBottom] = useState<number | null>(null);
  // The viewer is always dark, so everything it presents (the … menu, export,
  // move to folder, recognized text) uses the dark palette too: a bright sheet
  // sliding over the dark page reads as a different app.
  return (
    <DarkThemeScope>
      <ToastProvider onChrome offset={266} bottom={toastBottom}>
        <ViewerContent rootToast={rootToast} onToastAnchor={setToastBottom} />
      </ToastProvider>
      {locked && (
        <View style={StyleSheet.absoluteFill} testID="viewer-lock">
          <LockScreen />
        </View>
      )}
    </DarkThemeScope>
  );
}

function ViewerContent({
  rootToast,
  onToastAnchor,
}: {
  rootToast: ReturnType<typeof useToast>;
  onToastAnchor: (bottom: number) => void;
}) {
  // `notice`: a message from the screen that opened this one (a tool's "Signed
  // copy saved"). The viewer covers the app-wide toast host, so it shows it.
  const { id, notice } = useLocalSearchParams<{ id: string; notice?: string }>();
  const { width: screenWidth, height: windowH } = useWindowDimensions();
  const { colors } = useTheme();
  const [document, setDocument] = useState<Document | null>(null);
  // 'loading' until the first read; 'missing' when the document is gone.
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [currentPage, setCurrentPage] = useState(0);
  const [exportVisible, setExportVisible] = useState(false);
  // The inline edit panel (Filters / Adjust); null shows the toolbar instead.
  const [editTab, setEditTab] = useState<EditTab | null>(null);
  const [moreVisible, setMoreVisible] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [reorderVisible, setReorderVisible] = useState(false);
  const [reorderSaving, setReorderSaving] = useState(false);
  const [renameVisible, setRenameVisible] = useState(false);
  const [cropVisible, setCropVisible] = useState(false);
  const [adding, setAdding] = useState(false);
  const [retaking, setRetaking] = useState(false);
  const [moveVisible, setMoveVisible] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  const [ocr, setOcr] = useState<OcrState | null>(null);
  const [copied, setCopied] = useState(false);
  // "Convert to pages" on an imported PDF: null when idle.
  const [converting, setConverting] = useState<ConvertProgress | null>(null);
  // This PDF can't be converted (locked or damaged): stop offering the banner.
  const [convertRefused, setConvertRefused] = useState(false);
  // Imported PDFs in the native view: the page on screen (zero-based) and the
  // page count, or why the PDF can't be shown.
  const [pdfPage, setPdfPage] = useState<{ page: number; count: number } | null>(null);
  const [pdfError, setPdfError] = useState<'locked' | 'unreadable' | null>(null);
  // Bumped after a locked PDF is unlocked: the PDF view loads the new file.
  const [pdfReload, setPdfReload] = useState(0);
  const [unlocking, setUnlocking] = useState(false);
  const [bannerDismissed, dismissBanner] = useConvertBannerDismissed(id);
  const ocrIndexingRef = useRef(false);
  const flatListRef = useRef<FlatList>(null);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  // The page counter row (image pages or PDF), directly above the toolbar:
  // ViewerScreen rests toasts on its bottom padding, so a toast covers the
  // counter (and at most the foot of the page) while the toolbar under it
  // stays fully visible and tappable.
  const counterRowRef = useRef<View>(null);
  const anchorToast = useCallback(() => {
    counterRowRef.current?.measureInWindow((_x, y, _w, h) => {
      if (!Number.isFinite(y) || !Number.isFinite(h) || y <= 0) return;
      // The row's own bottom padding: Spacing.sm over the toolbar, or the
      // home indicator's inset under a PDF (which has no toolbar).
      const pad = docRef.current?.pdfUri ? insets.bottom + Spacing.xs : Spacing.sm;
      onToastAnchor(Math.max(0, windowH - (y + h)) + pad);
    });
  }, [onToastAnchor, windowH, insets.bottom]);
  const { bumpLastSaved } = useScan();

  const docRef = useRef<Document | null>(null);
  docRef.current = document;
  const pageRef = useRef(0);
  pageRef.current = currentPage;

  // An adjustment the user is still dragging (debounced, not yet handed to
  // bakePage). Overlaid on every reload so the slider never jumps back.
  const pendingAdjust = useRef<{ pageIndex: number; adjustment: PageAdjustment } | null>(null);
  const adjustTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * The stored document with the user's not-yet-baked choices laid over it, so
   * the picker and sliders show what was just chosen while the pixels catch up.
   */
  const withPendingChoices = useCallback((fresh: Document): Document => {
    const pending = pendingBakesFor(fresh.id);
    const local = pendingAdjust.current;
    if (pending.size === 0 && !local) return fresh;
    const filters = fresh.pages.map((_, i) => fresh.filters?.[i] ?? ('original' as PageFilter));
    const adjustments = fresh.pages.map((_, i) => fresh.adjustments?.[i] ?? { ...DEFAULT_ADJ });
    pending.forEach((choice, i) => {
      if (i >= fresh.pages.length) return;
      filters[i] = choice.filter;
      if (choice.adjustment) adjustments[i] = choice.adjustment;
    });
    if (local && local.pageIndex < fresh.pages.length) adjustments[local.pageIndex] = local.adjustment;
    return {
      ...fresh,
      filters: filters.every(f => f === 'original') ? undefined : filters,
      adjustments: adjustments.every(isDefaultAdj) ? undefined : adjustments,
    };
  }, []);

  /** Re-reads the document. Runs under the page lock so it can't interleave with an edit. */
  const reload = useCallback(async () => {
    await withDocLock(id, async () => {
      const docs = await getDocuments();
      const fresh = docs.find(d => d.id === id) ?? null;
      if (!fresh) {
        setStatus('missing');
        return;
      }
      setDocument(withPendingChoices(fresh));
      setStatus('ready');
      setCurrentPage(p => Math.min(p, Math.max(0, fresh.pages.length - 1)));
    });
  }, [id, withPendingChoices]);

  useFocusEffect(
    useCallback(() => {
      reload().catch(err => console.error('viewer reload', err));
    }, [reload]),
  );

  const shownNotice = useRef<string | null>(null);
  useEffect(() => {
    if (!notice || status !== 'ready' || shownNotice.current === notice) return;
    shownNotice.current = notice;
    toast.show(notice);
  }, [notice, status, toast]);

  // A document just created (a scan, imported photos or a file) is confirmed
  // by name, with Rename; a photo whose page edges auto-crop couldn't find is
  // said so instead, with Crop on that page (lib/new-doc-note). Once.
  useEffect(() => {
    if (status !== 'ready' || !id) return;
    const doc = docRef.current;
    if (!doc) return;
    const note = takeNewDocumentNote(id);
    if (!note) return;
    const count = doc.pages.length;
    if (note.uncropped.length && count) {
      const target = Math.min(note.uncropped[0], count - 1);
      toast.show(uncroppedMessage(note.uncropped, count), {
        action: {
          label: 'Crop',
          onPress: () => {
            setCurrentPage(target);
            flatListRef.current?.scrollToOffset({ offset: target * screenWidth, animated: false });
            setCropVisible(true);
          },
        },
      });
    } else {
      toast.show(`Saved as “${doc.name}”`, { action: { label: 'Rename', onPress: () => setRenameVisible(true) } });
    }
  }, [status, id, toast, screenWidth]);

  // The page a notice asked for, while the pager may not have laid out yet.
  const jumpTo = useRef<number | null>(null);
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (jumpTimer.current) clearTimeout(jumpTimer.current); }, []);
  const applyJump = useCallback(() => {
    const target = jumpTo.current;
    if (target != null) flatListRef.current?.scrollToOffset({ offset: target * screenWidth, animated: false });
  }, [screenWidth]);

  // A tool that changed this document in place (Sign, Watermark, Timestamp)
  // leaves its message, often with Undo, for whichever viewer shows the
  // document next (lib/viewer-notice). Taken only while this screen is on top,
  // so it isn't spent under the tool's own modal.
  useFocusEffect(
    useCallback(() => {
      if (status !== 'ready') return;
      const show = () => {
        const n = takeViewerNotice(id);
        if (!n) return;
        const count = docRef.current?.pages.length ?? 0;
        if (n.page != null && n.page >= 0 && n.page < count) {
          const target = n.page;
          setCurrentPage(target);
          // Kept until the pager has laid out far enough to show it (a viewer
          // just opened has no layout yet, and a scroll asked for then is
          // dropped): tried now, and again as the pager's content arrives.
          jumpTo.current = target;
          if (jumpTimer.current) clearTimeout(jumpTimer.current);
          jumpTimer.current = setTimeout(() => { jumpTo.current = null; }, 1500);
          requestAnimationFrame(() => applyJump());
        }
        toast.show(n.message, n.action ? { action: n.action } : undefined);
      };
      show();
      return subscribeViewerNotices(show);
    }, [id, status, toast, applyJump]),
  );

  // Imported PDFs: read their embedded text into the search index the first
  // time they are shown without one (lib/pdf-text; image-only PDFs have none).
  const pdfIndexTarget = document && needsPdfText(document) ? document.id : null;
  useEffect(() => {
    if (pdfIndexTarget) indexPdfText(pdfIndexTarget).catch(() => {});
  }, [pdfIndexTarget]);

  // Background writes to this document (OCR indexing renames a new scan from
  // its first line of text) must show up without leaving the screen.
  useEffect(() => {
    let scheduled = false;
    return subscribeDocumentChanges(docId => {
      if (docId !== id || scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        reload().catch(err => console.error('viewer reload', err));
      }, 50);
    });
  }, [id, reload]);

  // Show each page as soon as its bake lands (a fresh scan's "Enhancing 3
  // pages…", or a filter picked here). Coalesced so a burst of events is one read.
  useEffect(() => {
    let scheduled = false;
    return subscribeBakeChanges(docId => {
      if (docId !== id || scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        reload().catch(err => console.error('viewer reload', err));
      }, 50);
    });
  }, [id, reload]);

  /**
   * Runs one page edit against the CURRENT stored document (not this screen's
   * possibly-stale copy) under the page lock, then shows the result. `fn`
   * returns the fields to change, or null for none.
   */
  const editDocument = useCallback(async (
    edit: PageEdit,
    fn: (fresh: Document) => Promise<Partial<Document> | null>,
  ): Promise<Document> => {
    return runPageEdit(id, edit, async () => {
      const docs = await getDocuments();
      const fresh = docs.find(d => d.id === id);
      if (!fresh) throw new Error('document missing');
      const patch = await fn(fresh);
      const next = patch ? { ...fresh, ...patch, updatedAt: Date.now() } : fresh;
      if (patch) await updateDocument(next);
      return next;
    }).then(next => {
      // runPageEdit has re-targeted pending bakes by now, so the overlay maps
      // onto the new page order.
      setDocument(withPendingChoices(next));
      return next;
    });
  }, [id, withPendingChoices]);

  // ── Page edits ────────────────────────────────────────────────────────────

  const rotatingRef = useRef(false);
  const handleRotate = useCallback(async (direction: 'cw' | 'ccw') => {
    // One rotation at a time: each rewrites the page file.
    if (rotatingRef.current) return;
    rotatingRef.current = true;
    setRotating(true);
    const page = pageRef.current;
    try {
      await editDocument({ pages: [page] }, async fresh => {
        const uri = await rotatePage(pageFileUri(fresh.id, page), direction, fresh.id, page);
        const pages = [...fresh.pages];
        pages[page] = uri;
        return { pages };
      });
    } catch (err) {
      console.error('Rotate failed', err);
      notifyError();
      Alert.alert("Couldn't rotate the page", 'Try again.');
    } finally {
      rotatingRef.current = false;
      setRotating(false);
    }
  }, [editDocument]);

  const handleCropDone = useCallback(async (rect: CropRect) => {
    const page = pageRef.current;
    await editDocument({ pages: [page] }, async fresh => {
      const uri = await cropPage(fresh.id, page, rect);
      const pages = [...fresh.pages];
      pages[page] = uri;
      return { pages };
    });
    setCropVisible(false);
  }, [editDocument]);

  const handleFilter = useCallback((filter: PageFilter) => {
    const doc = docRef.current;
    if (!doc) return;
    const page = pageRef.current;
    const adjustment = doc.adjustments?.[page];
    const promise = bakePage(doc.id, page, filter, adjustment, { priority: 'high' });
    // bakePage registered the choice synchronously; show it right away.
    setDocument(prev => (prev ? withPendingChoices(prev) : prev));
    promise.catch(err => {
      console.error('Bake failed', err);
      notifyError();
      Alert.alert("Couldn't apply the filter", 'Try again, or choose a different filter.');
      reload().catch(() => {});
    });
  }, [withPendingChoices, reload]);

  const handleApplyToAll = useCallback(() => {
    const doc = docRef.current;
    if (!doc) return;
    const shown = withPendingChoices(doc);
    const filter = shown.filters?.[pageRef.current] ?? 'original';
    const others = doc.pages.map((_, i) => i).filter(i => (shown.filters?.[i] ?? 'original') !== filter);
    if (others.length === 0) {
      toast.show(`All pages already use ${FILTER_LABELS[filter]}`);
      return;
    }
    const jobs = others.map(i => bakePage(doc.id, i, filter, shown.adjustments?.[i]));
    setDocument(prev => (prev ? withPendingChoices(prev) : prev));
    notifySuccess();
    toast.show(`${FILTER_LABELS[filter]} applied to ${doc.pages.length === 2 ? 'both pages' : `all ${doc.pages.length} pages`}`);
    Promise.all(jobs).catch(err => {
      console.error('Apply to all failed', err);
      notifyError();
      Alert.alert("Couldn't apply the filter to every page", 'Try again.');
      reload().catch(() => {});
    });
  }, [withPendingChoices, reload, toast]);

  const flushAdjust = useCallback(() => {
    if (adjustTimer.current) {
      clearTimeout(adjustTimer.current);
      adjustTimer.current = null;
    }
    const pending = pendingAdjust.current;
    const doc = docRef.current;
    if (!pending || !doc) return;
    // Read the page's filter NOW, not when the slider started moving, so a
    // filter picked a moment ago isn't reverted by this bake.
    const filter = withPendingChoices(doc).filters?.[pending.pageIndex] ?? 'original';
    const promise = bakePage(doc.id, pending.pageIndex, filter, pending.adjustment, { priority: 'high' });
    pendingAdjust.current = null;
    promise.catch(err => console.error('bake adjustment', err));
  }, [withPendingChoices]);

  // Flush any pending adjust bake on unmount so the last 0-250 ms of slider
  // movement isn't dropped. The root baker picks it up once this screen's goes.
  useEffect(() => () => flushAdjust(), [flushAdjust]);

  const handleAdjust = useCallback((adj: PageAdjustment) => {
    const doc = docRef.current;
    if (!doc) return;
    const page = pageRef.current;
    if (pendingAdjust.current && pendingAdjust.current.pageIndex !== page) flushAdjust();
    pendingAdjust.current = { pageIndex: page, adjustment: adj };
    // Update visible state immediately so the slider feels responsive, but
    // coalesce the BAKE: baking on every slider frame would be pathological.
    setDocument(prev => (prev ? withPendingChoices(prev) : prev));
    if (adjustTimer.current) clearTimeout(adjustTimer.current);
    adjustTimer.current = setTimeout(flushAdjust, 250);
  }, [flushAdjust, withPendingChoices]);

  // Soft delete: the document moves to Recently deleted (record and files kept),
  // and the toast on the screen underneath offers Undo.
  const deleteDocAndExit = useCallback(async () => {
    try {
      flushAdjust();
      await trashDocument(id);
      notifySuccess();
      navigateWhenUnlocked(() => router.back());
      rootToast.show('Moved to Recently deleted', {
        action: {
          label: 'Undo',
          onPress: () => {
            restoreDocument(id)
              .then(() => bumpLastSaved())
              .catch(err => {
                console.error('Restore failed', err);
                Alert.alert("Couldn't restore the document", 'Find it in Settings, Recently deleted.');
              });
          },
        },
      });
    } catch (err) {
      console.error('Delete document failed', err);
      notifyError();
      Alert.alert("Couldn't delete the document", 'Try again.');
    }
  }, [id, router, rootToast, bumpLastSaved, flushAdjust]);

  /** Undo for a page delete: puts the stashed page back where it was. */
  const restorePage = useCallback(async (
    index: number,
    saved: { stash: string; filter: PageFilter; adjustment: PageAdjustment },
  ) => {
    try {
      await editDocument({ remap: i => (i >= index ? i + 1 : i) }, async fresh => {
        const n = fresh.pages.length;
        const pages = restoreStashedPage(fresh.id, saved.stash, n, index);
        const filters = insertAt(fresh.pages.map((_, i) => fresh.filters?.[i] ?? ('original' as PageFilter)), index, saved.filter);
        const adjustments = insertAt(fresh.pages.map((_, i) => fresh.adjustments?.[i] ?? { ...DEFAULT_ADJ }), index, saved.adjustment);
        return {
          pages,
          filters: filters.some(f => f !== 'original') ? filters : undefined,
          adjustments: adjustments.some(a => !isDefaultAdj(a)) ? adjustments : undefined,
        };
      });
      setCurrentPage(index);
      flatListRef.current?.scrollToOffset({ offset: index * screenWidth, animated: false });
      notifySuccess();
    } catch (err) {
      console.error('Restore page failed', err);
      notifyError();
      Alert.alert("Couldn't restore the page", 'Try again.');
      reload().catch(() => {});
    }
  }, [editDocument, reload, screenWidth]);

  const handleDeletePage = useCallback(async (at?: number) => {
    const doc = docRef.current;
    if (!doc) return;
    if (doc.pages.length <= 1) {
      await deleteDocAndExit();
      return;
    }
    const page = at ?? pageRef.current;
    if (page < 0 || page >= doc.pages.length) return;
    let undo: { stash: string; filter: PageFilter; adjustment: PageAdjustment } | null = null;
    try {
      const next = await editDocument({ remap: remapForDelete(page) }, async fresh => {
        const n = fresh.pages.length;
        // Keep a copy for Undo. If that fails, the delete still goes ahead without it.
        try {
          undo = {
            stash: stashPage(fresh.id, page),
            filter: fresh.filters?.[page] ?? 'original',
            adjustment: fresh.adjustments?.[page] ?? { ...DEFAULT_ADJ },
          };
        } catch (err) {
          console.warn('Page undo stash failed', err);
        }
        deleteSinglePage(fresh.id, page, n);
        // Pages are stored by position, so after the shift the files are
        // page-0 … page-(n-2): the list is the canonical names, not a filter of
        // the old ones (which would point at a file that no longer exists).
        const pages = Array.from({ length: n - 1 }, (_, i) => pageFileUri(fresh.id, i));
        const filters = fresh.filters?.filter((_, i) => i !== page);
        const adjustments = fresh.adjustments?.filter((_, i) => i !== page);
        return {
          pages,
          filters: filters && filters.some(f => f !== 'original') ? filters : undefined,
          adjustments: adjustments && adjustments.some(a => !isDefaultAdj(a)) ? adjustments : undefined,
          // Recognised text still includes the deleted page; refreshed on the next text pass.
        };
      });
      const safe = Math.min(page, next.pages.length - 1);
      setCurrentPage(safe);
      flatListRef.current?.scrollToOffset({ offset: safe * screenWidth, animated: false });
      notifySuccess();
      const saved = undo as { stash: string; filter: PageFilter; adjustment: PageAdjustment } | null;
      toast.show(`Page ${page + 1} deleted`, saved ? {
        action: { label: 'Undo', onPress: () => { restorePage(page, saved); } },
      } : undefined);
    } catch (err) {
      console.error('Delete page failed', err);
      notifyError();
      Alert.alert("Couldn't delete the page", 'Try again.');
      reload().catch(() => {});
    }
  }, [editDocument, deleteDocAndExit, reload, screenWidth, toast, restorePage]);

  /**
   * Puts the pages in `newOrder` (old indices, new positions) through the one
   * reorder path, which moves each page's unfiltered .orig with it and
   * re-targets pending bakes. `focus` is the old index of the page to show
   * afterwards. Resolves false when nothing changed.
   */
  const applyOrder = useCallback(async (newOrder: number[], focus: number): Promise<boolean> => {
    try {
      flushAdjust();
      await editDocument({ remap: remapForReorder(newOrder) }, async fresh => {
        if (newOrder.length !== fresh.pages.length) throw new Error('page count changed');
        const pages = reorderPages(fresh.id, newOrder);
        const filters = fresh.filters ? newOrder.map(i => fresh.filters![i] ?? ('original' as PageFilter)) : undefined;
        const adjustments = fresh.adjustments ? newOrder.map(i => fresh.adjustments![i] ?? { ...DEFAULT_ADJ }) : undefined;
        return { pages, filters, adjustments };
      });
      const shown = Math.max(0, newOrder.indexOf(focus));
      setCurrentPage(shown);
      flatListRef.current?.scrollToOffset({ offset: shown * screenWidth, animated: false });
      return true;
    } catch (err) {
      console.error('Reorder failed', err);
      notifyError();
      Alert.alert("Couldn't reorder the pages", 'Your pages are unchanged. Try again.');
      reload().catch(() => {});
      return false;
    }
  }, [editDocument, reload, flushAdjust, screenWidth]);

  const handleReorder = useCallback(async (newOrder: number[]) => {
    setReorderSaving(true);
    try {
      if (await applyOrder(newOrder, newOrder[0])) setReorderVisible(false);
    } finally {
      setReorderSaving(false);
    }
  }, [applyOrder]);

  /** A page dragged in the strip, or moved one place from its menu. The page you are reading stays in view. */
  const movePage = useCallback((from: number, to: number, focus = pageRef.current) => {
    const doc = docRef.current;
    if (!doc || from === to) return;
    applyOrder(movedOrder(doc.pages.length, from, to), focus).then(ok => {
      if (ok) notifySuccess();
    });
  }, [applyOrder]);

  // ── Add pages ─────────────────────────────────────────────────────────────

  const addFrom = useCallback(async (source: 'camera' | 'photos') => {
    const doc = docRef.current;
    if (!doc || adding) return;
    setAdding(true);
    try {
      const settings = await getScanSettings();
      let uris: string[] = [];
      if (source === 'camera') {
        // withSystemUI: the app lock covers an open picker instead of closing
        // it, and an abandoned one resolves as cancelled so `adding` resets.
        const { scannedImages } = await withSystemUI(
          () => DocumentScanner.scanDocument({ croppedImageQuality: SCAN_QUALITY_MAP[settings.quality] }),
          () => ({ scannedImages: [] as string[] }),
        );
        uris = scannedImages ?? [];
      } else {
        const result = await withSystemUI(
          () => ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsMultipleSelection: true,
            // Recompressed once, at the user's scan quality, when stored.
            quality: 1,
          }),
          (): ImagePicker.ImagePickerResult => ({ canceled: true, assets: null }),
        );
        // addPagesToDocument finds and straightens the page in each photo.
        uris = result.canceled ? [] : result.assets.map(a => a.uri);
      }
      if (!uris.length) return;
      const { doc: next, added } = await addPagesToDocument(doc.id, uris, QUALITY_MAP[settings.quality]);
      setDocument(withPendingChoices(next));
      finishAddedPages(next, added, settings.defaultFilter);
      notifySuccess();
      const first = added[0];
      setCurrentPage(first);
      setTimeout(() => flatListRef.current?.scrollToIndex({ index: first, animated: true }), 100);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/cancel/i.test(msg)) return;
      console.error('Add pages failed', err);
      notifyError();
      Alert.alert("Couldn't add pages", source === 'camera'
        ? 'The scanner couldn’t be opened. Try again.'
        : 'The photos couldn’t be added. Try again.');
    } finally {
      setAdding(false);
    }
  }, [adding, withPendingChoices]);

  const handleAddMore = useCallback(() => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: 'Add pages',
          options: ['Scan with camera', 'Choose from Photos', 'Cancel'],
          cancelButtonIndex: 2,
          userInterfaceStyle: 'dark',
        },
        index => {
          if (index === 0) addFrom('camera');
          else if (index === 1) addFrom('photos');
        },
      );
    } else {
      Alert.alert('Add pages', undefined, [
        { text: 'Scan with camera', onPress: () => addFrom('camera') },
        { text: 'Choose from Photos', onPress: () => addFrom('photos') },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }, [addFrom]);

  // ── Retake page ───────────────────────────────────────────────────────────

  /** Puts the page a retake replaced back, with its filter, adjustment and text. */
  const undoRetakePage = useCallback(async (index: number, undo: RetakeUndo) => {
    try {
      const next = await undoRetake(id, index, undo);
      // A default-filter bake started for the new page would otherwise land on
      // the restored one; re-choosing its own look supersedes it.
      if (pendingBakesFor(id).has(index)) {
        bakePage(id, index, undo.filter, undo.adjustment).catch(err => console.error('bake after undo', err));
      }
      setDocument(withPendingChoices(next));
      notifySuccess();
      indexDocText(next.id, next.pages).catch(() => {});
    } catch (err) {
      notifyError();
      // Refused because the pages moved since (or the saved copy is gone):
      // nothing changed, and trying again won't help.
      if (err instanceof RetakeError) {
        Alert.alert("Couldn't undo", err.message);
        return;
      }
      console.error('Undo retake failed', err);
      Alert.alert("Couldn't restore the page", 'Try again.');
      reload().catch(() => {});
    }
  }, [id, withPendingChoices, reload]);

  const retakingRef = useRef(false);
  /** Replaces page `index` with the image at `uri` and offers Undo. */
  const applyRetake = useCallback(async (docId: string, index: number, uri: string) => {
    retakingRef.current = true;
    setRetaking(true);
    try {
      flushAdjust();
      const settings = await getScanSettings();
      const { doc: next, undo } = await retakePage(docId, index, uri, QUALITY_MAP[settings.quality]);
      setDocument(withPendingChoices(next));
      // Same finish as a new page: the default filter, then the text index.
      finishAddedPages(next, [index], settings.defaultFilter);
      notifySuccess();
      toast.show(
        next.pages.length > 1 ? `Page ${index + 1} replaced` : 'Page replaced',
        undo ? { action: { label: 'Undo', onPress: () => { undoRetakePage(index, undo); } } } : undefined,
      );
    } catch (err) {
      console.error('Retake failed', err);
      notifyError();
      Alert.alert("Couldn't replace the page", 'Your page is unchanged. Try again.');
      reload().catch(() => {});
    } finally {
      retakingRef.current = false;
      setRetaking(false);
    }
  }, [flushAdjust, withPendingChoices, toast, undoRetakePage, reload]);

  const retakeFrom = useCallback(async (source: 'camera' | 'photos', index: number) => {
    const doc = docRef.current;
    if (!doc || retakingRef.current) return;
    let uris: string[] | null = null;
    try {
      // Photos are auto-cropped by retakePage, so the picker hands them over as is.
      uris = source === 'camera' ? await scanWithCamera() : await pickPhotos(false, { autoCrop: false });
    } catch (err) {
      if (err instanceof ToolScanError && err.kind === 'unavailable') {
        Alert.alert(
          'Camera not available',
          'The document camera can’t be opened on this device. You can replace the page with a photo instead.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Choose from Photos', onPress: () => { retakeFrom('photos', index); } },
          ],
        );
      } else {
        alertScanError(err);
      }
      return;
    }
    if (!uris?.length) return;
    // The camera can capture several pages in one go; a retake uses the first.
    const [first, ...extra] = uris;
    deleteTempFiles(extra);
    await applyRetake(doc.id, index, first);
  }, [applyRetake]);

  const handleRetake = useCallback((at?: number) => {
    const doc = docRef.current;
    if (!doc) return;
    const index = at ?? pageRef.current;
    const title = doc.pages.length > 1 ? `Retake page ${index + 1}` : 'Retake page';
    const message = 'The new page replaces this one, in the same place.';
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { title, message, options: ['Scan with camera', 'Choose from Photos', 'Cancel'], cancelButtonIndex: 2, userInterfaceStyle: 'dark' },
        i => {
          if (i === 0) retakeFrom('camera', index);
          else if (i === 1) retakeFrom('photos', index);
        },
      );
    } else {
      Alert.alert(title, message, [
        { text: 'Scan with camera', onPress: () => retakeFrom('camera', index) },
        { text: 'Choose from Photos', onPress: () => retakeFrom('photos', index) },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }, [retakeFrom]);

  // ── Document actions (… menu) ─────────────────────────────────────────────

  /** Opens a tool on this document; the tool skips its document picker. */
  const openTool = useCallback((pathname: string) => {
    const doc = docRef.current;
    if (!doc) return;
    flushAdjust();
    router.push({ pathname, params: { docId: doc.id } } as any);
  }, [router, flushAdjust]);

  const handleDuplicate = useCallback(async () => {
    const doc = docRef.current;
    if (!doc) return;
    try {
      flushAdjust();
      const copy = await duplicateDocument(doc);
      bumpLastSaved();
      notifySuccess();
      toast.show(`Saved “${copy.name}”`, {
        action: { label: 'Open', onPress: () => router.replace({ pathname: '/viewer', params: { id: copy.id } }) },
      });
    } catch (err) {
      console.error('Duplicate failed', err);
      notifyError();
      Alert.alert("Couldn't duplicate the document", 'There may not be enough free space. Try again.');
    }
  }, [flushAdjust, bumpLastSaved, toast, router]);

  const openMove = useCallback(() => {
    getFolders()
      .then(f => { setFolders(f); setMoveVisible(true); })
      .catch(() => setMoveVisible(true));
  }, []);

  const handleMove = useCallback(async (doc: Document, folder: string | null) => {
    setMoveVisible(false);
    if ((doc.folder ?? null) === folder) return;
    try {
      const ok = await patchDocument(doc.id, { folder: folder ?? undefined });
      if (!ok) { setStatus('missing'); return; }
      setDocument(prev => (prev ? { ...prev, folder: folder ?? undefined } : prev));
      bumpLastSaved();
      toast.show(folder ? `Moved to “${folder}”` : 'Removed from folder');
    } catch (err) {
      console.error('Move to folder failed', err);
      Alert.alert("Couldn't move the document", 'Try again.');
    }
  }, [bumpLastSaved, toast]);

  const createFolder = useCallback(async (name: string) => {
    await saveFolder(name);
    setFolders(await getFolders());
  }, []);

  // ── Share / annotate / text ───────────────────────────────────────────────

  // Runs after the "…" sheet has fully closed (ViewerMoreSheet waits for it),
  // so the share sheet can present.
  const handleSharePage = useCallback(async () => {
    const doc = docRef.current;
    if (!doc) return;
    const page = pageRef.current;
    try {
      // Share under a readable name ("Invoice page 2.jpg"), not "page-1.jpg".
      const dir = await makeExportDir();
      const named = await placeExportFile(
        pageFileUri(doc.id, page),
        dir,
        exportFileName(doc.pages.length > 1 ? `${doc.name} page ${page + 1}` : doc.name, 'jpg'),
        'copy',
      );
      await shareFile(named, { mimeType: 'image/jpeg', UTI: 'public.jpeg', dialogTitle: doc.name });
    } catch (err) {
      Alert.alert('Couldn’t share the page', err instanceof ShareError ? err.message : 'Try again.');
    }
  }, []);

  const confirmDeleteDocument = useCallback(() => {
    const doc = docRef.current;
    if (!doc) return;
    Alert.alert(
      `Delete “${doc.name}”?`,
      'It moves to Recently deleted, where you can restore it for 30 days.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => { deleteDocAndExit(); } },
      ],
    );
  }, [deleteDocAndExit]);

  // No confirmation: the toast offers Undo. A one-page document is deleted as a
  // whole, which does ask (it leaves the viewer).
  const confirmDeletePage = useCallback((at?: number) => {
    const doc = docRef.current;
    if (!doc) return;
    if (doc.pages.length <= 1) confirmDeleteDocument();
    else handleDeletePage(at);
  }, [confirmDeleteDocument, handleDeletePage]);

  const handleSharePdf = useCallback(async () => {
    const doc = docRef.current ?? document;
    if (!doc?.pdfUri) return;
    try {
      // Share a copy named after the document, not the stored "<id>.pdf".
      const named = await placeExportFile(doc.pdfUri, await makeExportDir(), exportFileName(doc.name, 'pdf'), 'copy');
      await shareFile(named, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: doc.name });
    } catch (err) {
      Alert.alert('Couldn’t share the PDF', err instanceof ShareError ? err.message : 'Try again.');
    }
  }, [document]);

  const printingPdfRef = useRef(false);
  const handlePrintPdf = useCallback(async () => {
    const doc = docRef.current ?? document;
    if (!doc?.pdfUri || printingPdfRef.current) return;
    printingPdfRef.current = true;
    try {
      await printFile(doc.pdfUri); // cancel resolves quietly
    } catch (err) {
      Alert.alert('Couldn’t print', err instanceof ShareError ? err.message : 'Try again.');
    } finally {
      printingPdfRef.current = false;
    }
  }, [document]);

  // ── Convert an imported PDF to pages ──────────────────────────────────────

  const convertingRef = useRef(false);
  // The original PDF kept for Undo; dropped when a newer one replaces it or
  // the viewer closes (the startup sweep removes any left behind).
  const convertUndoRef = useRef<ConvertUndo | null>(null);
  // False once the viewer has closed: a conversion that finishes after that
  // discards its Undo copy at once instead of leaving it in Caches.
  const viewerOpenRef = useRef(true);
  useEffect(() => {
    viewerOpenRef.current = true;
    return () => {
      viewerOpenRef.current = false;
      discardConvertUndo(convertUndoRef.current);
      convertUndoRef.current = null;
    };
  }, []);

  const handleUndoConvert = useCallback(async (undo: ConvertUndo) => {
    if (convertingRef.current) return;
    convertingRef.current = true;
    try {
      const restored = await undoPdfConversion(undo);
      if (convertUndoRef.current === undo) convertUndoRef.current = null;
      setEditTab(null);
      setOcr(null);
      setDocument(restored);
      bumpLastSaved();
    } catch (err) {
      console.error('Undo convert failed', err);
      notifyError();
      Alert.alert('Couldn’t restore the PDF', 'The pages are kept, and you can still export them as a PDF.');
    } finally {
      convertingRef.current = false;
    }
  }, [bumpLastSaved]);

  // ── Locked PDFs ────────────────────────────────────────────────────────────

  const unlockingRef = useRef(false);
  /** Asks for the PDF's password; the unlocked copy replaces the stored PDF (lib/pdf-unlock). */
  const handleUnlockPdf = useCallback((retry = false) => {
    const doc = docRef.current;
    if (!doc?.pdfUri || unlockingRef.current) return;
    const unlockWith = async (password: string) => {
      if (unlockingRef.current) return;
      unlockingRef.current = true;
      setUnlocking(true);
      try {
        await unlockStoredPdf(doc.id, password);
        setPdfError(null);
        setConvertRefused(false);
        setPdfPage(null);
        setPdfReload(n => n + 1);
        await reload();
        notifySuccess();
        toast.show('PDF unlocked');
      } catch (err) {
        const kind = err instanceof PdfUnlockError ? err.kind : 'failed';
        notifyError();
        if (kind === 'wrong-password') {
          Alert.alert('That password isn’t right', 'Check it and try again. Passwords are case-sensitive.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Try again', onPress: () => handleUnlockPdf(true) },
          ]);
        } else if (kind === 'missing') {
          reload().catch(() => {});
        } else {
          console.error('Unlock PDF failed', err);
          Alert.alert('Couldn’t unlock the PDF', 'Your PDF is unchanged. Check that there’s free space, then try again.');
        }
      } finally {
        unlockingRef.current = false;
        setUnlocking(false);
      }
    };
    Alert.prompt(
      retry ? 'Enter the password again' : 'Enter the PDF’s password',
      `“${doc.name}” is protected. Scan Kit keeps an unlocked copy, so you only need the password once.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Unlock', isPreferred: true, onPress: (value?: string) => { unlockWith(value ?? ''); } },
      ],
      'secure-text',
    );
  }, [reload, toast]);

  const handleConvertPdf = useCallback(async () => {
    const doc = docRef.current;
    if (!doc?.pdfUri || convertingRef.current) return;
    convertingRef.current = true;
    setConverting({ stage: 'rendering' });
    try {
      // 'original': an imported PDF is usually computer-made and already clean;
      // a scan filter would only soften its text and grey its colours.
      const { doc: next, pageCount: n, undo } = await convertPdfToPages(doc.id, { filter: 'original', onProgress: setConverting });
      if (!viewerOpenRef.current) {
        // Closed during the conversion: nobody can tap Undo any more.
        discardConvertUndo(undo);
        return;
      }
      discardConvertUndo(convertUndoRef.current);
      convertUndoRef.current = undo;
      setCurrentPage(0);
      setDocument(withPendingChoices(next));
      bumpLastSaved();
      notifySuccess();
      toast.show(
        `Converted to ${n} ${n === 1 ? 'page' : 'pages'}`,
        undo ? { action: { label: 'Undo', onPress: () => { handleUndoConvert(undo); } } } : undefined,
      );
    } catch (err) {
      const kind = err instanceof PdfConvertError ? err.kind : 'failed';
      if (kind === 'missing') {
        setStatus('missing');
        return;
      }
      notifyError();
      if (kind === 'locked' || kind === 'unreadable') setConvertRefused(true);
      else console.error('Convert to pages failed', err);
      if (kind === 'locked') {
        if (pdfUnlockAvailable() && Platform.OS === 'ios') {
          Alert.alert('This PDF is password protected', 'Enter its password to unlock it, then convert it.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Enter password', onPress: () => handleUnlockPdf() },
          ]);
        } else {
          Alert.alert(
            'This PDF is password protected',
            'Scan Kit can’t convert a locked PDF. Remove its password in the app it came from, then import it again.',
          );
        }
      } else if (kind === 'unreadable') {
        Alert.alert('Couldn’t read this PDF', 'The file may be damaged. Try importing it again.');
      } else {
        Alert.alert('Couldn’t convert the PDF', 'Your PDF is unchanged. Check that there’s free space, then try again.');
      }
    } finally {
      convertingRef.current = false;
      setConverting(null);
    }
  }, [withPendingChoices, bumpLastSaved, toast, handleUndoConvert, handleUnlockPdf]);

  const annotateNavRef = useRef(false);
  const handleAnnotate = useCallback(() => {
    const doc = docRef.current;
    if (!doc) return;
    // Guard against tap-spam pushing two annotate screens onto the stack.
    if (annotateNavRef.current) return;
    annotateNavRef.current = true;
    flushAdjust();
    router.push({ pathname: '/annotate', params: { docId: doc.id, pageIndex: String(pageRef.current) } } as any);
    setTimeout(() => { annotateNavRef.current = false; }, 600);
  }, [router, flushAdjust]);

  const handleOcr = useCallback(async () => {
    const doc = docRef.current;
    if (!doc || ocr?.status === 'running') return;
    if (!ocrAvailable()) {
      Alert.alert('Text recognition isn’t available', 'This device can’t recognize text in images.');
      return;
    }
    setCopied(false);
    setOcr({ status: 'running' });
    try {
      const { text } = await recognizeLines(pageFileUri(doc.id, pageRef.current));
      setOcr({ status: 'done', text: text.trim() });
      // Refresh the full-doc content index in the background so search can match
      // this document. patchDocument merges onto the current record, so a delete
      // or edit made while it runs is neither resurrected nor overwritten.
      if (!ocrIndexingRef.current) {
        ocrIndexingRef.current = true;
        extractDocText(doc.pages)
          .then(docText => (docText ? patchDocument(doc.id, { ocrText: docText }) : undefined))
          .catch(() => {})
          .finally(() => { ocrIndexingRef.current = false; });
      }
    } catch (err) {
      console.error('OCR failed', err);
      setOcr(null);
      Alert.alert('Couldn’t recognize text', 'Try again, or crop the page closer to the text.');
    }
  }, [ocr]);

  const ocrText = ocr?.status === 'done' ? ocr.text : '';

  const handleCopyText = useCallback(async () => {
    if (!ocrText) return;
    await Clipboard.setStringAsync(ocrText);
    setCopied(true);
    notifySuccess();
  }, [ocrText]);

  const handleShareText = useCallback(() => {
    if (!ocrText) return;
    shareText(ocrText);
  }, [ocrText]);

  const handleThumbnailPress = useCallback((index: number) => {
    if (index !== pageRef.current) flushAdjust();
    setCurrentPage(index);
    flatListRef.current?.scrollToIndex({ index, animated: true });
  }, [flushAdjust]);

  /** Touch and hold a thumbnail, let go: that page's actions. */
  const handlePageMenu = useCallback((index: number) => {
    const doc = docRef.current;
    if (!doc || index < 0 || index >= doc.pages.length) return;
    handleThumbnailPress(index);
    const n = doc.pages.length;
    const actions: { label: string; run: () => void; destructive?: boolean }[] = [
      { label: n > 1 ? `Retake page ${index + 1}` : 'Retake page', run: () => handleRetake(index) },
    ];
    if (index > 0) actions.push({ label: 'Move left', run: () => movePage(index, index - 1, index) });
    if (index < n - 1) actions.push({ label: 'Move right', run: () => movePage(index, index + 1, index) });
    if (n > 2) actions.push({ label: 'Reorder pages…', run: () => setReorderVisible(true) });
    actions.push(
      n > 1
        ? { label: `Delete page ${index + 1}`, run: () => confirmDeletePage(index), destructive: true }
        : { label: 'Delete document', run: () => confirmDeletePage(index), destructive: true },
    );
    const title = n > 1 ? `Page ${index + 1} of ${n}` : undefined;
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title,
          options: [...actions.map(a => a.label), 'Cancel'],
          cancelButtonIndex: actions.length,
          destructiveButtonIndex: actions.findIndex(a => a.destructive),
          // The viewer is always dark; so are the menus it opens.
          userInterfaceStyle: 'dark',
        },
        i => actions[i]?.run(),
      );
    } else {
      Alert.alert(title ?? 'Page', undefined, [
        ...actions.map(a => ({ text: a.label, style: a.destructive ? ('destructive' as const) : undefined, onPress: a.run })),
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    }
  }, [handleThumbnailPress, handleRetake, movePage, confirmDeletePage]);


  // ── Render ────────────────────────────────────────────────────────────────

  const backButton = (
    <HeaderIconButton icon="chevron-back" size={28} label="Back" color={colors.chromeText} onPress={() => router.back()} />
  );

  if (status !== 'ready' || !document) {
    return (
      <View style={[styles.container, { backgroundColor: colors.chrome }]}>
        <ScreenHeader dark left={backButton} />
        {status === 'missing' ? (
          <View style={styles.centered}>
            <Ionicons name="document-outline" size={44} color={colors.chromeMuted} />
            <Text style={[Type.headline, { color: colors.chromeText }]}>This document isn’t available</Text>
            <Text style={[Type.footnote, styles.centeredText, { color: colors.chromeMuted }]}>
              It may have been deleted.
            </Text>
            <PrimaryButton title="Go back" onPress={() => router.back()} style={styles.missingBtn} />
          </View>
        ) : (
          <View style={styles.centered}>
            <ActivityIndicator color={colors.chromeText} />
          </View>
        )}
      </View>
    );
  }

  const titleButton = (
    <View style={styles.titleRow}>
      {backButton}
      <Pressable
        style={({ pressed }) => [styles.titlePress, pressed && { opacity: 0.6 }]}
        onPress={() => setRenameVisible(true)}
        hitSlop={{ top: 4, bottom: 4 }}
        accessibilityRole="button"
        accessibilityLabel={document.name}
        accessibilityHint="Double-tap to rename"
      >
        <Text style={[Type.headline, styles.titleText, { color: colors.chromeText }]} numberOfLines={1}>
          {document.name}
        </Text>
        {/* 16pt at the regular weight, a step brighter than muted text: at
            14pt light it read as a stray slash after the title. */}
        <View style={styles.titlePencil}>
          <AppIcon name="rename" size={16} color={colors.chromeText} weight="regular" />
        </View>
      </Pressable>
    </View>
  );

  const renameSheet = (
    <RenameSheet
      visible={renameVisible}
      document={document}
      onRename={async (_doc, newName) => {
        const next = { ...document, name: newName, updatedAt: Date.now() };
        await patchDocument(document.id, { name: newName, updatedAt: next.updatedAt });
        setDocument(next);
        setRenameVisible(false);
      }}
      onClose={() => setRenameVisible(false)}
    />
  );

  const pageCount = document.pages.length;
  const page = Math.min(currentPage, Math.max(0, pageCount - 1));

  // "…" menu: tools for this document as tiles, then document, page and
  // delete actions. Image documents only for the tools (they work on pages).
  const pageLabel = pageCount > 1 ? `page ${page + 1}` : 'page';
  const moreTools: MoreAction[] = document.pdfUri
    ? []
    : [
        { key: 'sign', icon: 'signature', label: 'Sign', onPress: () => openTool('/tools/sign') },
        { key: 'watermark', icon: 'watermark', label: 'Watermark', onPress: () => openTool('/tools/watermark') },
        { key: 'timestamp', icon: 'time-outline', label: 'Timestamp', onPress: () => openTool('/tools/timestamp') },
        ...(pageCount > 1
          ? [{ key: 'extract', icon: 'cut-outline' as const, label: 'Extract', onPress: () => openTool('/tools/extract') }]
          : []),
      ];
  const convertAvailable = !!document.pdfUri && canConvertPdf();
  // Alert.prompt (the password field) is iOS-only.
  const canUnlock = Platform.OS === 'ios' && pdfUnlockAvailable();
  const moreGroups: MoreAction[][] = document.pdfUri
    ? [
        convertAvailable
          ? [{ key: 'convert', icon: 'images-outline', label: 'Convert to pages', onPress: handleConvertPdf }]
          : [],
        [
          { key: 'rename', icon: 'rename', label: 'Rename', onPress: () => setRenameVisible(true) },
          { key: 'move', icon: 'folder-outline', label: 'Move to folder', detail: document.folder, onPress: openMove },
          { key: 'duplicate', icon: 'duplicate-outline', label: 'Duplicate', onPress: handleDuplicate },
          { key: 'print', icon: 'print-outline', label: 'Print', onPress: handlePrintPdf },
        ],
        [{ key: 'delete-doc', icon: 'trash-outline', label: 'Delete document', destructive: true, onPress: confirmDeleteDocument }],
      ]
    : [
        [
          { key: 'rename', icon: 'rename', label: 'Rename', onPress: () => setRenameVisible(true) },
          ...(pageCount > 1
            ? [{ key: 'reorder', icon: 'reorder-three-outline' as const, label: 'Reorder pages', onPress: () => setReorderVisible(true) }]
            : []),
          { key: 'move', icon: 'folder-outline', label: 'Move to folder', detail: document.folder, onPress: openMove },
          { key: 'duplicate', icon: 'duplicate-outline', label: 'Duplicate', onPress: handleDuplicate },
        ],
        [
          // Page actions name the page they act on, like Delete page N below
          // (the same actions are in the thumbnail's touch-and-hold menu).
          { key: 'retake', icon: 'camera-reverse-outline', label: pageCount > 1 ? `Retake page ${page + 1}` : 'Retake page', onPress: () => handleRetake(page) },
          // A one-page document as an image is Export, JPEG image.
          ...(pageCount > 1
            ? [{ key: 'share-page', icon: 'image-outline' as const, label: `Share ${pageLabel} as image`, onPress: handleSharePage }]
            : []),
        ],
        [
          ...(pageCount > 1
            ? [{ key: 'delete-page', icon: 'remove-circle-outline' as const, label: `Delete page ${page + 1}`, destructive: true, onPress: confirmDeletePage }]
            : []),
          { key: 'delete-doc', icon: 'trash-outline', label: 'Delete document', destructive: true, onPress: confirmDeleteDocument },
        ],
      ];

  const moreSheet = (
    <ViewerMoreSheet
      visible={moreVisible}
      title={document.name}
      subtitle={document.pdfUri ? 'PDF' : `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}`}
      tools={moreTools}
      groups={moreGroups}
      onClose={() => setMoreVisible(false)}
    />
  );

  const moveSheet = (
    <MoveFolderSheet
      visible={moveVisible}
      document={document}
      folders={folders}
      onMove={handleMove}
      onCreateFolder={createFolder}
      onClose={() => setMoveVisible(false)}
    />
  );

  const moreButton = (
    <HeaderIconButton
      icon="ellipsis-horizontal"
      label="More actions"
      color={colors.chromeText}
      onPress={() => { flushAdjust(); setMoreVisible(true); }}
    />
  );

  // PDF viewer mode: read-only WebView rendering
  if (document.pdfUri) {
    return (
      <View style={[styles.container, { backgroundColor: colors.chrome }]}>
        <ScreenHeader
          dark
          fillLeft
          left={titleButton}
          right={
            <>
              {converting ? (
                <HeaderIconButton icon="ellipsis-horizontal" label="More actions" color={colors.chromeText} disabled onPress={() => {}} />
              ) : moreButton}
              <HeaderIconButton
                icon="share-outline"
                label="Share PDF"
                color={colors.chromeText}
                disabled={!!converting}
                onPress={handleSharePdf}
              />
            </>
          }
        />
        {convertAvailable && !convertRefused && !pdfError && (converting || bannerDismissed === false) ? (
          <PdfConvertBanner
            converting={converting}
            onConvert={handleConvertPdf}
            onDismiss={() => {
              dismissBanner();
              toast.show('Convert to pages is still in More actions');
            }}
          />
        ) : null}
        {pdfError ? (
          // The app's one empty state, on the dark chrome (round 8 design #6).
          <View style={styles.pdfEmpty} accessibilityLiveRegion="polite">
            <EmptyState
              chrome
              placement="center"
              icon={pdfError === 'locked' ? 'lock-closed-outline' : 'document-text-outline'}
              title={pdfError === 'locked' ? 'This PDF is password protected' : 'Couldn’t open this PDF'}
              subtitle={
                pdfError === 'locked'
                  ? canUnlock
                    ? 'Enter its password to open it. Scan Kit then keeps an unlocked copy, so you won’t need the password again.'
                    : 'Scan Kit can’t show a locked PDF. You can still share it, or remove the password in the app it came from and import it again.'
                  : 'The file may be damaged. You can still share it, or try importing it again.'
              }
              {...(pdfError === 'locked' && canUnlock
                ? { actionLabel: 'Enter password', actionIcon: 'key-outline' as const, actionLoading: unlocking, onAction: () => handleUnlockPdf() }
                : {})}
            />
          </View>
        ) : PdfDocumentView ? (
          <>
            <PdfDocumentView
              key={pdfReload}
              source={document.pdfUri.split('?')[0]}
              backgroundHex={colors.chrome}
              style={styles.pdfView}
              accessibilityLabel={pdfPage ? `PDF, page ${pdfPage.page + 1} of ${pdfPage.count}` : 'PDF'}
              onPageChange={e => setPdfPage({ page: e.nativeEvent.page, count: e.nativeEvent.count })}
              onLoadError={e => {
                const kind = e.nativeEvent.message === 'locked' ? 'locked' : 'unreadable';
                setPdfError(kind);
                setConvertRefused(true);
              }}
            />
            {/* The same counter as image pages, in its own row under the pages. */}
            <View
              ref={counterRowRef}
              onLayout={anchorToast}
              style={[styles.counterRow, styles.counterRowFixed, { paddingBottom: insets.bottom + Spacing.xs }]}
              pointerEvents="none"
            >
              {pdfPage && pdfPage.count > 1 ? (
                <View style={[styles.counter, { backgroundColor: colors.chromeRaised }]}>
                  <Text style={[Type.footnote, styles.counterText, { color: colors.chromeText }]}>
                    {pdfPage.page + 1} / {pdfPage.count}
                  </Text>
                </View>
              ) : null}
            </View>
          </>
        ) : (
          // Builds without the native PDF view.
          <WebView
            source={{ uri: document.pdfUri }}
            style={[styles.webView, { backgroundColor: colors.chrome }]}
            originWhitelist={['file://*', 'blob:*']}
          />
        )}
        {renameSheet}
        {moreSheet}
        {moveSheet}
      </View>
    );
  }

  const editing = editTab !== null;

  // JPEG pager mode
  return (
    <View style={[styles.container, { backgroundColor: colors.chrome }]}>
      {/* The status bar is light here because /viewer is a chrome route in
          lib/status-bar-style.ts. No <StatusBar> of its own: it would stay
          mounted under a tool opened from here and keep the bar white over
          that tool's light screen. */}
      {/* The viewer is a fullScreenModal in its own view controller, so the root
          baker is buried underneath and iOS never runs it. Bakes started while
          this screen is up run in this one. */}
      <FilterBaker />
      <ScreenHeader
        dark
        fillLeft
        left={titleButton}
        right={
          <>
            {moreButton}
            <HeaderIconButton
              icon="share-outline"
              label="Share or export"
              color={colors.chromeText}
              onPress={() => { flushAdjust(); setExportVisible(true); }}
            />
          </>
        }
      />

      <View style={styles.pager}>
        <FlatList
          ref={flatListRef}
          data={document.pages}
          keyExtractor={(_, i) => String(i)}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          // A notice's page (see applyJump), once the content is wide enough to show it.
          onContentSizeChange={w => {
            if (jumpTo.current != null && w >= (jumpTo.current + 1) * screenWidth - 1) applyJump();
          }}
          onScrollBeginDrag={() => { jumpTo.current = null; }}
          onMomentumScrollEnd={e => {
            const next = Math.round(e.nativeEvent.contentOffset.x / screenWidth);
            if (next !== pageRef.current) flushAdjust();
            setCurrentPage(next);
          }}
          // Every page is exactly screenWidth, so the layout is exact. Without this,
          // scrollToIndex fails for any page outside the render window and the pager
          // silently stays put while currentPage has already moved.
          getItemLayout={(_, index) => ({ length: screenWidth, offset: screenWidth * index, index })}
          renderItem={({ item, index }) => (
            <View style={[styles.page, { width: screenWidth }]}>
              {/* updatedAt busts RN's image cache after an in-place rewrite of the file. */}
              <Image
                source={{ uri: `${item}?v=${document.updatedAt}` }}
                style={[styles.pageImage, { width: screenWidth - Spacing.xxxl }]}
                resizeMode="contain"
                accessibilityLabel={`Page ${index + 1} of ${pageCount}`}
              />
            </View>
          )}
        />
        {retaking && (
          <View style={[styles.retakeBusy, { backgroundColor: colors.scrim }]} pointerEvents="none">
            <ActivityIndicator color={colors.onScrim} />
            <Text style={[Type.footnote, { color: colors.onScrim }]}>Replacing the page…</Text>
          </View>
        )}
      </View>
      {/* Its own row under the page, never on top of it: the page counter and,
          while pages are being enhanced, the "Enhancing…" pill beside it. The
          row keeps its height when both are hidden, so the page never jumps. */}
      <View ref={counterRowRef} onLayout={anchorToast} style={[styles.counterRow, styles.counterRowFixed]} pointerEvents="none">
        <BakeIndicator placement="inline" />
        {pageCount > 1 ? (
          <View style={[styles.counter, { backgroundColor: colors.chromeRaised }]}>
            <Text style={[Type.footnote, styles.counterText, { color: colors.chromeText }]}>
              {page + 1} / {pageCount}
            </Text>
          </View>
        ) : null}
      </View>

      {editing ? (
        <PageEditPanel
          tab={editTab}
          onTabChange={setEditTab}
          uri={document.pages[page]}
          docId={document.id}
          pageIndex={page}
          pageCount={pageCount}
          cacheBust={document.updatedAt}
          filter={document.filters?.[page] ?? 'original'}
          adjustment={document.adjustments?.[page]}
          onFilter={handleFilter}
          onApplyToAll={handleApplyToAll}
          onAdjust={handleAdjust}
          onAdjustCommit={flushAdjust}
          onDone={() => { flushAdjust(); setEditTab(null); }}
          bottomInset={insets.bottom}
        />
      ) : (
        <>
          <ViewerToolbar
            items={[
              { key: 'crop', icon: 'crop-outline', label: 'Crop', a11y: 'Crop page', onPress: () => { flushAdjust(); setCropVisible(true); } },
              { key: 'filters', icon: 'color-filter-outline', label: 'Filters', a11y: 'Filters and adjustments', onPress: () => setEditTab('filters') },
              {
                key: 'rotate',
                icon: 'refresh-outline',
                label: 'Rotate',
                a11y: 'Rotate page clockwise',
                hint: 'Touch and hold to rotate counterclockwise',
                onPress: () => { handleRotate('cw'); },
                onLongPress: () => { handleRotate('ccw'); },
                longPressLabel: 'Rotate counterclockwise',
                busy: rotating,
              },
              { key: 'markup', icon: 'brush-outline', label: 'Mark up', a11y: 'Mark up page', onPress: handleAnnotate },
              {
                key: 'text',
                icon: 'reader-outline',
                label: 'Text',
                a11y: 'Recognize text on this page',
                onPress: handleOcr,
                busy: ocr?.status === 'running',
              },
            ]}
          />
          <ThumbnailStrip
            pages={document.pages}
            currentPage={page}
            onPagePress={handleThumbnailPress}
            onPageMenu={handlePageMenu}
            onReorder={(from, to) => movePage(from, to)}
            onAddPress={handleAddMore}
            adding={adding}
            bottomInset={insets.bottom}
            cacheBust={document.updatedAt}
          />
        </>
      )}

      <ExportSheet
        visible={exportVisible}
        document={document}
        onClose={() => setExportVisible(false)}
      />

      {moreSheet}
      {moveSheet}

      <CropModal
        visible={cropVisible}
        uri={document.pages[page]}
        cacheBust={document.updatedAt}
        onCancel={() => setCropVisible(false)}
        onDone={handleCropDone}
      />

      {renameSheet}

      <ReorderModal
        visible={reorderVisible}
        pages={document.pages}
        cacheBust={document.updatedAt}
        saving={reorderSaving}
        onConfirm={handleReorder}
        onCancel={() => setReorderVisible(false)}
      />

      <BottomSheet visible={ocr !== null} onClose={() => setOcr(null)}>
        <SheetHeader
          title="Recognized text"
          subtitle={pageCount > 1 ? `Page ${page + 1}` : undefined}
        />
        {ocr?.status === 'running' ? (
          <View style={styles.ocrBusy}>
            <ActivityIndicator color={colors.muted} />
            <Text style={[Type.footnote, { color: colors.muted }]}>Reading the page…</Text>
          </View>
        ) : ocrText ? (
          <>
            <ScrollView style={[styles.ocrBody, { backgroundColor: colors.bg }]} contentContainerStyle={styles.ocrBodyContent}>
              <Text style={[Type.callout, styles.ocrText, { color: colors.text }]} selectable>{ocrText}</Text>
            </ScrollView>
            <View style={styles.ocrActions}>
              <PrimaryButton
                title={copied ? 'Copied' : 'Copy'}
                icon={copied ? 'checkmark' : 'copy-outline'}
                variant="secondary"
                style={styles.ocrBtn}
                onPress={handleCopyText}
              />
              <PrimaryButton title="Share" icon="share-outline" style={styles.ocrBtn} onPress={handleShareText} />
            </View>
          </>
        ) : (
          <View style={styles.ocrBusy}>
            <Ionicons name="reader-outline" size={32} color={colors.muted} />
            <Text style={[Type.subhead, { color: colors.text }]}>No text found on this page</Text>
            <Text style={[Type.footnote, styles.centeredText, { color: colors.muted }]}>
              Try cropping closer to the text, or a sharper scan.
            </Text>
          </View>
        )}
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0 },
  // Left-aligned next to the back button; the pencil says "tap to rename".
  titlePress: { flexShrink: 1, minHeight: HIT, flexDirection: 'row', alignItems: 'center', paddingRight: Spacing.sm },
  titleText: { flexShrink: 1 },
  titlePencil: { marginLeft: Spacing.sm, marginTop: 1, opacity: 0.72 },
  pager: { flex: 1 },
  page: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
  },
  pageImage: { flex: 1 },
  counterRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: Spacing.sm, paddingBottom: Spacing.sm },
  // Counter pill height (footnote line + padding) plus the row's padding.
  counterRowFixed: { minHeight: 22 + Spacing.sm },
  counter: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xxs + 1,
    borderRadius: Radius.pill,
  },
  retakeBusy: {
    position: 'absolute',
    alignSelf: 'center',
    top: '42%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm + 2,
    borderRadius: Radius.pill,
  },
  counterText: { fontWeight: '600', fontVariant: ['tabular-nums'] },
  webView: { flex: 1 },
  pdfView: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, padding: Spacing.xxl },
  centeredText: { textAlign: 'center' },
  pdfEmpty: { flex: 1 },
  missingBtn: { alignSelf: 'stretch', marginTop: Spacing.lg },
  ocrBusy: { alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.xxl },
  ocrBody: { maxHeight: 320, borderRadius: Radius.md },
  ocrBodyContent: { padding: Spacing.lg },
  ocrText: { lineHeight: 22 },
  ocrActions: { flexDirection: 'row', gap: Spacing.md, marginTop: Spacing.lg },
  ocrBtn: { flex: 1 },
});
