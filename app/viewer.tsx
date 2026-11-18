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
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import DocumentScanner from 'react-native-document-scanner-plugin';
import { getDocuments, updateDocument, getScanSettings, patchDocument, restoreDocument, trashDocument } from '@/lib/storage';
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
import { insertAt, restoreStashedPage, stashPage } from '@/lib/page-undo';
import { notifySuccess, notifyError } from '@/lib/haptics';
import { ocrAvailable, recognizeLines, extractDocText } from '@/lib/ocr';
import {
  exportFileName,
  makeExportDir,
  placeExportFile,
  printFile,
  shareFile,
  ShareError,
} from '@/lib/share';
import { Document, PageAdjustment, PageFilter } from '@/types/document';
import { useTheme } from '@/contexts/theme-context';
import { QUALITY_MAP, SCAN_QUALITY_MAP, useScan } from '@/contexts/scan-context';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';
import { ExportSheet } from '@/components/export-sheet';
import { EditTab, FILTER_LABELS, PageEditPanel } from '@/components/page-actions-sheet';
import { ThumbnailStrip } from '@/components/thumbnail-strip';
import { ViewerToolbar } from '@/components/viewer-toolbar';
import { MoreAction, ViewerMoreSheet } from '@/components/viewer-more-sheet';
import { ToastProvider, useToast } from '@/components/toast';
import { ReorderModal } from '@/components/reorder-modal';
import { RenameSheet } from '@/components/rename-sheet';
import { CropModal, CropRect } from '@/components/crop-modal';
import { FilterBaker } from '@/components/filter-baker';
import { BakeIndicator } from '@/components/bake-indicator';
import { BottomSheet, SheetHeader } from '@/components/bottom-sheet';
import { PrimaryButton } from '@/components/primary-button';
import { HeaderIconButton, ScreenHeader } from '@/components/screen-header';

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
  return (
    <ToastProvider onChrome offset={250}>
      <ViewerContent rootToast={rootToast} />
    </ToastProvider>
  );
}

function ViewerContent({ rootToast }: { rootToast: ReturnType<typeof useToast> }) {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { width: screenWidth } = useWindowDimensions();
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
  const [ocr, setOcr] = useState<OcrState | null>(null);
  const [copied, setCopied] = useState(false);
  const ocrIndexingRef = useRef(false);
  const flatListRef = useRef<FlatList>(null);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
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
      router.back();
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

  const handleDeletePage = useCallback(async () => {
    const doc = docRef.current;
    if (!doc) return;
    if (doc.pages.length <= 1) {
      await deleteDocAndExit();
      return;
    }
    const page = pageRef.current;
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

  const handleReorder = useCallback(async (newOrder: number[]) => {
    setReorderSaving(true);
    try {
      await editDocument({ remap: remapForReorder(newOrder) }, async fresh => {
        if (newOrder.length !== fresh.pages.length) throw new Error('page count changed');
        const pages = reorderPages(fresh.id, newOrder);
        const filters = fresh.filters ? newOrder.map(i => fresh.filters![i] ?? ('original' as PageFilter)) : undefined;
        const adjustments = fresh.adjustments ? newOrder.map(i => fresh.adjustments![i] ?? { ...DEFAULT_ADJ }) : undefined;
        return { pages, filters, adjustments };
      });
      setReorderVisible(false);
      setCurrentPage(0);
      flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
    } catch (err) {
      console.error('Reorder failed', err);
      notifyError();
      Alert.alert("Couldn't reorder the pages", 'Your pages are unchanged. Try again.');
      reload().catch(() => {});
    } finally {
      setReorderSaving(false);
    }
  }, [editDocument, reload]);

  // ── Add pages ─────────────────────────────────────────────────────────────

  const addFrom = useCallback(async (source: 'camera' | 'photos') => {
    const doc = docRef.current;
    if (!doc || adding) return;
    setAdding(true);
    try {
      const settings = await getScanSettings();
      let uris: string[] = [];
      if (source === 'camera') {
        const { scannedImages } = await DocumentScanner.scanDocument({
          croppedImageQuality: SCAN_QUALITY_MAP[settings.quality],
        });
        uris = scannedImages ?? [];
      } else {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsMultipleSelection: true,
          // Recompressed once, at the user's scan quality, when stored.
          quality: 1,
        });
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
  const confirmDeletePage = useCallback(() => {
    const doc = docRef.current;
    if (!doc) return;
    if (doc.pages.length <= 1) confirmDeleteDocument();
    else handleDeletePage();
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
    Share.share({ message: ocrText }).catch(() => {});
  }, [ocrText]);

  const handleThumbnailPress = useCallback((index: number) => {
    setCurrentPage(index);
    flatListRef.current?.scrollToIndex({ index, animated: true });
  }, []);


  // ── Render ────────────────────────────────────────────────────────────────

  const backButton = (
    <HeaderIconButton icon="chevron-back" size={28} label="Back" color={colors.chromeText} onPress={() => router.back()} />
  );

  if (status !== 'ready' || !document) {
    return (
      <View style={[styles.container, { backgroundColor: colors.chrome }]}>
        <StatusBar style="light" />
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
        <Ionicons name="pencil" size={13} color={colors.chromeMuted} style={styles.titlePencil} />
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

  // "…" menu. Rename and Reorder moved here from the header so the title has room.
  const moreGroups: MoreAction[][] = document.pdfUri
    ? [
        [
          { key: 'rename', icon: 'pencil-outline', label: 'Rename', onPress: () => setRenameVisible(true) },
          { key: 'print', icon: 'print-outline', label: 'Print', onPress: handlePrintPdf },
        ],
        [{ key: 'delete-doc', icon: 'trash-outline', label: 'Delete document', destructive: true, onPress: confirmDeleteDocument }],
      ]
    : [
        [
          { key: 'rename', icon: 'pencil-outline', label: 'Rename', onPress: () => setRenameVisible(true) },
          ...(pageCount > 1
            ? [{ key: 'reorder', icon: 'swap-vertical-outline' as const, label: 'Reorder pages', onPress: () => setReorderVisible(true) }]
            : []),
          { key: 'add', icon: 'add-circle-outline', label: 'Add pages', onPress: handleAddMore },
        ],
        [
          {
            key: 'share-page',
            icon: 'image-outline',
            label: pageCount > 1 ? `Share page ${page + 1} as image` : 'Share page as image',
            onPress: handleSharePage,
          },
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
      groups={moreGroups}
      onClose={() => setMoreVisible(false)}
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
        {/* Chrome is always dark here regardless of app theme, so the status bar
            must be light — the global one in _layout follows the theme and would
            render black glyphs on this near-black background in light mode. */}
        <StatusBar style="light" />
        <ScreenHeader
          dark
          fillLeft
          left={titleButton}
          right={
            <>
              {moreButton}
              <HeaderIconButton icon="share-outline" label="Share PDF" color={colors.chromeText} onPress={handleSharePdf} />
            </>
          }
        />
        <WebView
          source={{ uri: document.pdfUri }}
          style={[styles.webView, { backgroundColor: colors.chrome }]}
          originWhitelist={['file://*', 'blob:*']}
        />
        {renameSheet}
        {moreSheet}
      </View>
    );
  }

  const editing = editTab !== null;

  // JPEG pager mode
  return (
    <View style={[styles.container, { backgroundColor: colors.chrome }]}>
      <StatusBar style="light" />
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
      <BakeIndicator placement="top" offset={52} />

      <View style={styles.pager}>
        <FlatList
          ref={flatListRef}
          data={document.pages}
          keyExtractor={(_, i) => String(i)}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
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
        {pageCount > 1 && (
          <View style={[styles.counter, { backgroundColor: colors.chromeRaised }]} pointerEvents="none">
            <Text style={[Type.footnote, styles.counterText, { color: colors.chromeText }]}>
              {page + 1} / {pageCount}
            </Text>
          </View>
        )}
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
                icon: 'document-text-outline',
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
            <Ionicons name="document-text-outline" size={32} color={colors.muted} />
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
  titlePencil: { marginLeft: Spacing.xs + 2, marginTop: 1 },
  pager: { flex: 1 },
  page: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
  },
  pageImage: { flex: 1 },
  counter: {
    position: 'absolute',
    bottom: Spacing.md,
    alignSelf: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: Radius.pill,
    opacity: 0.92,
  },
  counterText: { fontWeight: '600', fontVariant: ['tabular-nums'] },
  webView: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, padding: Spacing.xxl },
  centeredText: { textAlign: 'center' },
  missingBtn: { alignSelf: 'stretch', marginTop: Spacing.lg },
  ocrBusy: { alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.xxl },
  ocrBody: { maxHeight: 320, borderRadius: Radius.md },
  ocrBodyContent: { padding: Spacing.lg },
  ocrText: { lineHeight: 22 },
  ocrActions: { flexDirection: 'row', gap: Spacing.md, marginTop: Spacing.lg },
  ocrBtn: { flex: 1 },
});
