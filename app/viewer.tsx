// app/viewer.tsx
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import * as Sharing from 'expo-sharing';
import { File } from 'expo-file-system';
import DocumentScanner from 'react-native-document-scanner-plugin';
import { getDocuments, updateDocument, deleteDocument, getScanSettings } from '@/lib/storage';
import { appendPages, deleteSinglePage, reorderPages, deleteDocumentFiles, replacePage } from '@/lib/files';
import { rotatePage, mirrorGeometryToOriginal } from '@/lib/image';
import { bakePage, invalidatePreviews, invalidateDocPreviews } from '@/lib/bake';
import { notifySuccess } from '@/lib/haptics';
import { ocrAvailable, recognizeLines, extractDocText } from '@/lib/ocr';
import { Document, PageAdjustment, PageFilter } from '@/types/document';
import { ExportSheet } from '@/components/export-sheet';
import { PageActionsSheet } from '@/components/page-actions-sheet';
import { ThumbnailStrip } from '@/components/thumbnail-strip';
import { ReorderModal } from '@/components/reorder-modal';
import { RenameSheet } from '@/components/rename-sheet';
import { CropModal } from '@/components/crop-modal';
import { FilterBaker } from '@/components/filter-baker';
import { BakeIndicator } from '@/components/bake-indicator';

export default function ViewerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { width: screenWidth } = useWindowDimensions();
  const [document, setDocument] = useState<Document | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [exportVisible, setExportVisible] = useState(false);
  const [actionsVisible, setActionsVisible] = useState(false);
  const [reorderVisible, setReorderVisible] = useState(false);
  const [renameVisible, setRenameVisible] = useState(false);
  const [cropVisible, setCropVisible] = useState(false);
  const [ocrResult, setOcrResult] = useState<string | null>(null);
  const [ocrRunning, setOcrRunning] = useState(false);
  const ocrIndexingRef = useRef(false);
  const flatListRef = useRef<FlatList>(null);
  const insets = useSafeAreaInsets();
  const router = useRouter();

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      getDocuments().then(docs => {
        if (cancelled) return;
        const fresh = docs.find(d => d.id === id) ?? null;
        // Only replace state if something actually changed — avoids needless re-renders
        // when returning from a screen that didn't touch this doc.
        setDocument(prev => {
          if (!prev || !fresh) return fresh;
          if (prev.updatedAt === fresh.updatedAt && prev.pages.length === fresh.pages.length) {
            return prev;
          }
          return fresh;
        });
      });
      return () => { cancelled = true; };
    }, [id])
  );

  const saveDoc = useCallback(async (updated: Document) => {
    setDocument(updated);
    await updateDocument(updated);
  }, []);

  const rotatingRef = useRef(false);
  const handleRotate = useCallback(async (direction: 'cw' | 'ccw') => {
    if (!document) return;
    if (rotatingRef.current) return;
    rotatingRef.current = true;
    try {
      // Use the canonical doc-page path (strip any `?v=` cache-bust suffix the
      // viewer may have applied to the Image URI).
      const sourceUri = document.pages[currentPage].split('?')[0];
      const newUri = await rotatePage(sourceUri, direction, document.id, currentPage);
      invalidatePreviews(document.id, currentPage);
      const newPages = [...document.pages];
      newPages[currentPage] = newUri;
      await saveDoc({ ...document, pages: newPages, updatedAt: Date.now() });
    } catch (err) {
      console.error('Rotate failed', err);
      Alert.alert('Rotate failed', 'Could not rotate this page.');
    } finally {
      rotatingRef.current = false;
    }
  }, [document, currentPage, saveDoc]);

  const handleCropDone = useCallback(async (
    croppedUri: string,
    rect: { originX: number; originY: number; width: number; height: number },
  ) => {
    if (!document) return;
    try {
      const stored = replacePage(croppedUri, document.id, currentPage);
      // Only clean up the manipulator's temp file when it is genuinely a different
      // file from the stored page. expo-image-manipulator can return its input path
      // (see the same guard in lib/image.ts rotatePage), and deleting `stored` here
      // would remove the page replacePage just wrote.
      const tmpPath = croppedUri.split('?')[0];
      if (tmpPath !== stored.split('?')[0]) {
        try {
          const tmp = new File(tmpPath);
          if (tmp.exists) tmp.delete();
        } catch {}
      }
      // Apply the identical crop to the unfiltered shadow. The rect is in natural
      // image pixels and .orig has the same dimensions, so the two stay the same
      // shape — otherwise the next filter change re-derives from the uncropped
      // original and silently undoes this crop.
      await mirrorGeometryToOriginal(document.id, currentPage, [{ crop: rect }]);
      invalidatePreviews(document.id, currentPage);
      const pages = [...document.pages];
      pages[currentPage] = stored;
      await saveDoc({ ...document, pages, updatedAt: Date.now() });
    } catch (err) {
      console.error('Crop failed', err);
      Alert.alert('Crop failed', 'Could not save the cropped page.');
    } finally {
      setCropVisible(false);
    }
  }, [document, currentPage, saveDoc]);

  // Refreshes `document` from storage after a successful bake so its new
  // `updatedAt` busts the `?v=` image cache and the freshly-baked pixels
  // actually become visible. Only swaps state if the doc we fetched still
  // matches what's on screen (a nav-away/delete during the bake shouldn't
  // resurrect it).
  const refreshDocumentAfterBake = useCallback(async (docId: string) => {
    const docs = await getDocuments();
    const fresh = docs.find(d => d.id === docId);
    if (fresh) setDocument(prev => (prev && prev.id === docId ? fresh : prev));
  }, []);

  const handleFilter = useCallback(async (filter: PageFilter) => {
    if (!document) return;
    try {
      // bakePage records the filter/adjustment metadata itself (setPageBaked)
      // once the baked pixels are written, so this must NOT also write
      // filters/adjustments via saveDoc — two writers would race.
      await bakePage(document.id, currentPage, filter, document.adjustments?.[currentPage]);
      await refreshDocumentAfterBake(document.id);
    } catch (err) {
      console.error('Bake failed', err);
      Alert.alert('Filter failed', 'Could not apply this filter.');
    }
  }, [document, currentPage, refreshDocumentAfterBake]);

  const adjustBakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingAdjustBake = useRef<{ docId: string; pageIndex: number; filter: PageFilter; adjustment: PageAdjustment } | null>(null);

  const runPendingAdjustBake = useCallback(() => {
    const pending = pendingAdjustBake.current;
    if (!pending) return;
    pendingAdjustBake.current = null;
    // Fire-and-forget: this fires from both a debounced timeout and an
    // unmount cleanup, neither of which can await it.
    bakePage(pending.docId, pending.pageIndex, pending.filter, pending.adjustment)
      .then(() => refreshDocumentAfterBake(pending.docId))
      .catch(err => console.error('bake pending adjustment', err));
  }, [refreshDocumentAfterBake]);

  // Flush any pending adjust bake on unmount so the last 0-250 ms of slider
  // movement isn't silently dropped.
  useEffect(() => {
    return () => {
      if (adjustBakeTimer.current) {
        clearTimeout(adjustBakeTimer.current);
        adjustBakeTimer.current = null;
        runPendingAdjustBake();
      }
    };
  }, [runPendingAdjustBake]);

  const handleAdjust = useCallback((adj: PageAdjustment) => {
    if (!document) return;
    const base = document.adjustments ?? document.pages.map(() => ({ brightness: 0, contrast: 0, saturation: 0 }));
    const newAdj = [...base];
    newAdj[currentPage] = adj;
    const allDefault = newAdj.every(a => a.brightness === 0 && a.contrast === 0 && a.saturation === 0);
    const next: Document = {
      ...document,
      adjustments: allDefault ? undefined : newAdj,
    };
    // Update visible state immediately so the slider feels responsive (it's a
    // controlled component driven by this value), but coalesce the BAKE to
    // once every 250ms — baking on every slider frame would be pathological.
    // Stash the latest pending job in a ref so the unmount cleanup can flush it.
    setDocument(next);
    pendingAdjustBake.current = {
      docId: document.id,
      pageIndex: currentPage,
      filter: document.filters?.[currentPage] ?? 'original',
      adjustment: adj,
    };
    if (adjustBakeTimer.current) clearTimeout(adjustBakeTimer.current);
    adjustBakeTimer.current = setTimeout(() => {
      adjustBakeTimer.current = null;
      runPendingAdjustBake();
    }, 250);
  }, [document, currentPage, runPendingAdjustBake]);

  // Shared by the "last page deleted" confirmation below and by the rename
  // sheet's delete action — both end a document's life the same way.
  const deleteDocAndExit = useCallback(async (docId: string) => {
    await deleteDocument(docId);
    deleteDocumentFiles(docId);
    router.back();
  }, [router]);

  const handleDeletePage = useCallback(async () => {
    if (!document) return;
    if (document.pages.length === 1) {
      Alert.alert(
        'Delete document?',
        'This is the last page. The whole document will be deleted.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => deleteDocAndExit(document.id),
          },
        ]
      );
      return;
    }
    try {
      deleteSinglePage(document.id, currentPage, document.pages.length);

      invalidateDocPreviews(document.id);
    } catch (err) {
      console.error('deleteSinglePage failed', err);
      Alert.alert('Delete failed', 'Could not delete this page. Please try again.');
      return;
    }
    const newPages = document.pages.filter((_, i) => i !== currentPage);
    const newFilters = document.filters?.filter((_, i) => i !== currentPage);
    const newAdjustments = document.adjustments?.filter((_, i) => i !== currentPage);
    const safePage = Math.min(currentPage, newPages.length - 1);
    try {
      await saveDoc({
        ...document,
        pages: newPages,
        filters: newFilters?.length ? newFilters : undefined,
        adjustments: newAdjustments?.length ? newAdjustments : undefined,
        updatedAt: Date.now(),
      });
    } catch (err) {
      console.error('saveDoc failed after deleteSinglePage', err);
      Alert.alert('Save failed', 'The page was removed but the document record could not be updated. Re-open the document to sync.');
      return;
    }
    setCurrentPage(safePage);
    setActionsVisible(false);
    notifySuccess();
  }, [document, currentPage, saveDoc, deleteDocAndExit]);

  const handleSharePage = useCallback(async () => {
    if (!document) return;
    setActionsVisible(false);
    try {
      // Strip any cache-bust suffix the viewer might have applied.
      const uri = document.pages[currentPage].split('?')[0];
      await Sharing.shareAsync(uri, {
        mimeType: 'image/jpeg',
        dialogTitle: `${document.name} — Page ${currentPage + 1}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/cancel/i.test(msg)) {
        Alert.alert('Share failed', msg);
      }
    }
  }, [document, currentPage]);

  const addingMoreRef = useRef(false);
  const handleAddMore = useCallback(async () => {
    if (!document) return;
    if (addingMoreRef.current) return;
    addingMoreRef.current = true;
    try {
      const settings = await getScanSettings();
      const { scannedImages } = await DocumentScanner.scanDocument({
        letUserAdjustCrop: settings.autoCrop,
      } as any);
      if (!scannedImages?.length) return;
      const startIndex = document.pages.length;
      const newUris = appendPages(scannedImages, document.id, startIndex);
      await saveDoc({
        ...document,
        pages: [...document.pages, ...newUris],
        updatedAt: Date.now(),
      });
    } catch (err) {
      console.error('Add pages failed', err);
      const msg = err instanceof Error ? err.message : 'Could not add pages.';
      Alert.alert('Add pages failed', msg);
    } finally {
      addingMoreRef.current = false;
    }
  }, [document, saveDoc]);

  const handleReorder = useCallback(async (newOrderIndices: number[]) => {
    if (!document) return;
    const newUris = reorderPages(document.id, newOrderIndices);

    invalidateDocPreviews(document.id);
    const defaultAdj = { brightness: 0, contrast: 0, saturation: 0 };
    const oldFilters = document.filters ?? document.pages.map(() => 'original' as PageFilter);
    const oldAdj = document.adjustments ?? document.pages.map(() => ({ ...defaultAdj }));
    // Map with fallback so a length-drift in either array can't produce
    // `undefined` entries that break filter math downstream.
    const newFilters = newOrderIndices.map(i => oldFilters[i] ?? 'original' as PageFilter);
    const newAdj = newOrderIndices.map(i => oldAdj[i] ?? { ...defaultAdj });
    const allOriginal = newFilters.every(f => f === 'original');
    const allDefault = newAdj.every(a => a.brightness === 0 && a.contrast === 0 && a.saturation === 0);
    await saveDoc({
      ...document,
      pages: newUris,
      filters: allOriginal ? undefined : newFilters,
      adjustments: allDefault ? undefined : newAdj,
      updatedAt: Date.now(),
    });
    setReorderVisible(false);
    setCurrentPage(0);
    flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [document, saveDoc]);

  const handleThumbnailPress = useCallback((index: number) => {
    setCurrentPage(index);
    flatListRef.current?.scrollToIndex({ index, animated: true });
  }, []);

  const handleSharePdf = useCallback(async () => {
    if (!document?.pdfUri) return;
    try {
      await Sharing.shareAsync(document.pdfUri, {
        mimeType: 'application/pdf',
        dialogTitle: document.name,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/cancel/i.test(msg)) {
        Alert.alert('Share failed', msg);
      }
    }
  }, [document]);

  const annotateNavRef = useRef(false);
  const handleAnnotate = useCallback(() => {
    if (!document) return;
    // Guard against tap-spam pushing two annotate screens onto the stack.
    if (annotateNavRef.current) return;
    annotateNavRef.current = true;
    router.push({ pathname: '/annotate', params: { docId: document.id, pageIndex: String(currentPage) } } as any);
    setTimeout(() => { annotateNavRef.current = false; }, 600);
  }, [document, currentPage, router]);

  const handleOcr = useCallback(async () => {
    if (!document) return;
    if (!ocrAvailable()) {
      Alert.alert(
        'OCR not available',
        'Rebuild your dev client after installing @react-native-ml-kit/text-recognition to enable text extraction.'
      );
      return;
    }
    setOcrRunning(true);
    try {
      const { text } = await recognizeLines(document.pages[currentPage]);
      setOcrResult(text || '(No text found)');
      // Refresh the full-doc content index in the background so search can match
      // this document. Guarded so rapid taps don't spawn concurrent full-doc OCR
      // passes; re-reads the doc by id so a delete/edit during indexing isn't
      // resurrected or clobbered.
      if (!ocrIndexingRef.current) {
        ocrIndexingRef.current = true;
        const targetId = document.id;
        extractDocText(document.pages)
          .then(async docText => {
            if (!docText) return;
            const docs = await getDocuments();
            const current = docs.find(d => d.id === targetId);
            if (!current) return; // deleted during indexing — don't resurrect
            await updateDocument({ ...current, ocrText: docText });
          })
          .catch(() => {})
          .finally(() => { ocrIndexingRef.current = false; });
      }
    } catch {
      Alert.alert('OCR failed', 'Could not extract text from this page.');
    } finally {
      setOcrRunning(false);
    }
  }, [document, currentPage]);

  if (!document) return null;

  // PDF viewer mode: read-only WebView rendering
  if (document.pdfUri) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Chrome is always dark here regardless of app theme, so the status bar
            must be light — the global one in _layout follows the theme and would
            render black glyphs on this near-black background in light mode. */}
        <StatusBar style="light" />
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <View style={styles.backRow}>
              <Ionicons name="chevron-back" size={24} color="#fff" />
              <Text style={styles.back}>Back</Text>
            </View>
          </Pressable>
          <Pressable
            style={{ flex: 1 }}
            onPress={() => setRenameVisible(true)}
            accessibilityRole="button"
            accessibilityLabel={`Rename ${document.name}`}
          >
            <Text style={styles.title} numberOfLines={1}>{document.name}</Text>
          </Pressable>
          <Pressable onPress={handleSharePdf} hitSlop={12}>
            <Text style={styles.exportBtn}>Share</Text>
          </Pressable>
        </View>
        <WebView
          source={{ uri: document.pdfUri }}
          style={styles.webView}
          originWhitelist={['file://*', 'blob:*']}
        />

        <RenameSheet
          visible={renameVisible}
          document={document}
          onRename={async (doc, newName) => {
            await saveDoc({ ...doc, name: newName, updatedAt: Date.now() });
            setRenameVisible(false);
          }}
          onDelete={async doc => {
            setRenameVisible(false);
            await deleteDocAndExit(doc.id);
          }}
          onClose={() => setRenameVisible(false)}
        />
      </View>
    );
  }

  // JPEG pager mode
  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar style="light" />
      {/* The viewer is a fullScreenModal in its own view controller, so the root
          baker is buried underneath and iOS never loads it. Filter/adjust bakes
          started here need a baker inside this modal. */}
      <FilterBaker />
      <BakeIndicator top={insets.top + 52} />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <View style={styles.backRow}>
            <Ionicons name="chevron-back" size={24} color="#fff" />
            <Text style={styles.back}>Back</Text>
          </View>
        </Pressable>
        <Pressable
          style={{ flex: 1 }}
          onPress={() => setRenameVisible(true)}
          accessibilityRole="button"
          accessibilityLabel={`Rename ${document.name}`}
        >
          <Text style={styles.title} numberOfLines={1}>{document.name}</Text>
        </Pressable>
        <View style={styles.headerRight}>
          <Pressable
            onPress={handleOcr}
            hitSlop={12}
            style={styles.headerBtn}
            disabled={ocrRunning}
            accessibilityRole="button"
            accessibilityLabel="Extract text"
          >
            <MaterialCommunityIcons name="text-recognition" size={22} color="#fff" style={ocrRunning && { opacity: 0.4 }} />
          </Pressable>
          {document.pages.length > 1 && (
            <Pressable
              onPress={() => setReorderVisible(true)}
              hitSlop={12}
              style={styles.headerBtn}
              accessibilityRole="button"
              accessibilityLabel="Reorder pages"
            >
              <Ionicons name="swap-vertical" size={22} color="#fff" />
            </Pressable>
          )}
          <Pressable
            onPress={() => setActionsVisible(true)}
            hitSlop={12}
            style={styles.headerBtn}
            accessibilityRole="button"
            accessibilityLabel="Page actions"
          >
            <Ionicons name="ellipsis-horizontal" size={22} color="#fff" />
          </Pressable>
          <Pressable
            onPress={() => setExportVisible(true)}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Export document"
          >
            <Text style={styles.exportBtn}>Export</Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        ref={flatListRef}
        data={document.pages}
        keyExtractor={(_, i) => String(i)}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={e => {
          setCurrentPage(Math.round(e.nativeEvent.contentOffset.x / screenWidth));
        }}
        // Every page is exactly screenWidth, so the layout is exact. Without this,
        // scrollToIndex fails for any page outside the render window and the pager
        // silently stays put while currentPage has already moved.
        getItemLayout={(_, index) => ({ length: screenWidth, offset: screenWidth * index, index })}
        renderItem={({ item }) => {
          // Append updatedAt so RN's Image cache reloads after rotate/annotate/compress overwrite the file in place.
          return (
            <View style={[styles.page, { width: screenWidth }]}>
              <Image
                source={{ uri: `${item}?v=${document.updatedAt}` }}
                style={[styles.pageImage, { width: screenWidth - 32 }]}
                resizeMode="contain"
              />
            </View>
          );
        }}
      />

      <ThumbnailStrip
        pages={document.pages}
        filters={document.filters}
        adjustments={document.adjustments}
        currentPage={currentPage}
        onPagePress={handleThumbnailPress}
        onAddPress={handleAddMore}
        bottomInset={insets.bottom}
        cacheBust={document.updatedAt}
      />

      <ExportSheet
        visible={exportVisible}
        document={document}
        onClose={() => setExportVisible(false)}
      />

      <PageActionsSheet
        visible={actionsVisible}
        uri={document.pages[currentPage]}
        docId={document.id}
        pageIndex={currentPage}
        filter={document.filters?.[currentPage] ?? 'original'}
        adjustment={document.adjustments?.[currentPage]}
        onRotate={handleRotate}
        onFilter={handleFilter}
        onAdjust={handleAdjust}
        onAnnotate={handleAnnotate}
        onCrop={() => { setActionsVisible(false); setCropVisible(true); }}
        onDelete={handleDeletePage}
        onShare={handleSharePage}
        onClose={() => setActionsVisible(false)}
      />

      {document.pages[currentPage] && (
        <CropModal
          visible={cropVisible}
          uri={document.pages[currentPage]}
          onCancel={() => setCropVisible(false)}
          onDone={handleCropDone}
        />
      )}

      <RenameSheet
        visible={renameVisible}
        document={document}
        onRename={async (doc, newName) => {
          await saveDoc({ ...doc, name: newName, updatedAt: Date.now() });
          setRenameVisible(false);
        }}
        onDelete={async doc => {
          setRenameVisible(false);
          await deleteDocAndExit(doc.id);
        }}
        onClose={() => setRenameVisible(false)}
      />

      <ReorderModal
        visible={reorderVisible}
        pages={document.pages}
        filters={document.filters}
        adjustments={document.adjustments}
        onConfirm={handleReorder}
        onCancel={() => setReorderVisible(false)}
      />

      {/* OCR result modal */}
      <Modal visible={ocrResult !== null} animationType="slide" transparent onRequestClose={() => setOcrResult(null)}>
        <View style={styles.ocrOverlay}>
          <View style={styles.ocrSheet}>
            <View style={styles.ocrHeader}>
              <Text style={styles.ocrTitle}>Extracted Text</Text>
              <Pressable onPress={() => setOcrResult(null)} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close extracted text">
                <Ionicons name="close" size={20} color="#888" />
              </Pressable>
            </View>
            <ScrollView style={styles.ocrBody}>
              <Text style={styles.ocrText} selectable>{ocrResult ?? ''}</Text>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backRow: { flexDirection: 'row', alignItems: 'center' },
  back: { fontSize: 16, color: '#fff', fontWeight: '400' },
  title: { flex: 1, fontSize: 15, color: '#ccc', fontWeight: '600', textAlign: 'center', marginHorizontal: 8 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerBtn: { paddingHorizontal: 6 },
  exportBtn: { fontSize: 15, color: '#4ec6e0', fontWeight: '600' },
  page: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  pageImage: { flex: 1 },
  webView: { flex: 1, backgroundColor: '#111' },
  // OCR modal
  ocrOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  ocrSheet: {
    backgroundColor: '#1e1e1e',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '60%',
    paddingTop: 16,
  },
  ocrHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
  },
  ocrTitle: { fontSize: 17, fontWeight: '700', color: '#f0f0f0' },
  ocrBody: { padding: 20 },
  ocrText: { fontSize: 15, color: '#ddd', lineHeight: 22 },
});
