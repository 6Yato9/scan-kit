// app/viewer.tsx
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Dimensions,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import * as Sharing from 'expo-sharing';
import DocumentScanner from 'react-native-document-scanner-plugin';
import { getDocuments, updateDocument, deleteDocument } from '@/lib/storage';
import { appendPages, deleteSinglePage, reorderPages, deleteDocumentFiles } from '@/lib/files';
import { rotatePage } from '@/lib/image';
import { filterStyle } from '@/lib/filters';
import { Document, PageFilter } from '@/types/document';
import { ExportSheet } from '@/components/export-sheet';
import { PageActionsSheet } from '@/components/page-actions-sheet';
import { ThumbnailStrip } from '@/components/thumbnail-strip';
import { ReorderModal } from '@/components/reorder-modal';

const SCREEN_WIDTH = Dimensions.get('window').width;

export default function ViewerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [document, setDocument] = useState<Document | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [exportVisible, setExportVisible] = useState(false);
  const [actionsVisible, setActionsVisible] = useState(false);
  const [reorderVisible, setReorderVisible] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const insets = useSafeAreaInsets();
  const router = useRouter();

  useEffect(() => {
    getDocuments().then(docs => {
      setDocument(docs.find(d => d.id === id) ?? null);
    });
  }, [id]);

  const saveDoc = useCallback(async (updated: Document) => {
    setDocument(updated);
    await updateDocument(updated);
  }, []);

  const handleRotate = useCallback(async (direction: 'cw' | 'ccw') => {
    if (!document) return;
    const newUri = await rotatePage(
      document.pages[currentPage],
      direction,
      document.id,
      currentPage
    );
    const newPages = [...document.pages];
    newPages[currentPage] = newUri;
    await saveDoc({ ...document, pages: newPages, updatedAt: Date.now() });
  }, [document, currentPage, saveDoc]);

  const handleFilter = useCallback(async (filter: PageFilter) => {
    if (!document) return;
    const newFilters: PageFilter[] = [
      ...(document.filters ?? document.pages.map(() => 'original' as PageFilter)),
    ];
    newFilters[currentPage] = filter;
    const allOriginal = newFilters.every(f => f === 'original');
    await saveDoc({
      ...document,
      filters: allOriginal ? undefined : newFilters,
      updatedAt: Date.now(),
    });
  }, [document, currentPage, saveDoc]);

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
            onPress: async () => {
              await deleteDocument(document.id);
              deleteDocumentFiles(document.id);
              router.back();
            },
          },
        ]
      );
      return;
    }
    deleteSinglePage(document.id, currentPage, document.pages.length);
    const newPages = document.pages.filter((_, i) => i !== currentPage);
    const newFilters = document.filters?.filter((_, i) => i !== currentPage);
    const safePage = Math.min(currentPage, newPages.length - 1);
    await saveDoc({
      ...document,
      pages: newPages,
      filters: newFilters?.length ? newFilters : undefined,
      updatedAt: Date.now(),
    });
    setCurrentPage(safePage);
    setActionsVisible(false);
  }, [document, currentPage, saveDoc, router]);

  const handleSharePage = useCallback(async () => {
    if (!document) return;
    setActionsVisible(false);
    await Sharing.shareAsync(document.pages[currentPage], {
      mimeType: 'image/jpeg',
      dialogTitle: `${document.name} — Page ${currentPage + 1}`,
    });
  }, [document, currentPage]);

  const handleAddMore = useCallback(async () => {
    if (!document) return;
    try {
      const { scannedImages } = await DocumentScanner.scanDocument();
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
    }
  }, [document, saveDoc]);

  const handleReorder = useCallback(async (newOrderIndices: number[]) => {
    if (!document) return;
    const newUris = reorderPages(document.id, newOrderIndices);
    const oldFilters = document.filters ?? document.pages.map(() => 'original' as PageFilter);
    const newFilters = newOrderIndices.map(i => oldFilters[i]);
    const allOriginal = newFilters.every(f => f === 'original');
    await saveDoc({
      ...document,
      pages: newUris,
      filters: allOriginal ? undefined : newFilters,
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
    await Sharing.shareAsync(document.pdfUri, {
      mimeType: 'application/pdf',
      dialogTitle: document.name,
    });
  }, [document]);

  if (!document) return null;

  // PDF viewer mode: read-only WebView rendering
  if (document.pdfUri) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Text style={styles.back}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title} numberOfLines={1}>{document.name}</Text>
          <Pressable onPress={handleSharePdf} hitSlop={12}>
            <Text style={styles.exportBtn}>Share</Text>
          </Pressable>
        </View>
        <WebView
          source={{ uri: document.pdfUri }}
          style={styles.webView}
          originWhitelist={['file://*', 'blob:*']}
        />
      </View>
    );
  }

  // JPEG pager mode (existing behaviour)
  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>{document.name}</Text>
        <View style={styles.headerRight}>
          <Pressable onPress={() => setReorderVisible(true)} hitSlop={12} style={styles.headerBtn}>
            <Text style={styles.headerBtnText}>⇅</Text>
          </Pressable>
          <Pressable onPress={() => setActionsVisible(true)} hitSlop={12} style={styles.headerBtn}>
            <Text style={styles.headerBtnText}>•••</Text>
          </Pressable>
          <Pressable onPress={() => setExportVisible(true)} hitSlop={12}>
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
          setCurrentPage(Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH));
        }}
        onScrollToIndexFailed={() => {}}
        renderItem={({ item, index }) => {
          const fStyle = filterStyle(document.filters?.[index]);
          return (
            <View style={styles.page}>
              <Image
                source={{ uri: item }}
                style={[styles.pageImage, fStyle ? ({ filter: fStyle } as any) : undefined]}
                resizeMode="contain"
              />
            </View>
          );
        }}
      />

      <ThumbnailStrip
        pages={document.pages}
        filters={document.filters}
        currentPage={currentPage}
        onPagePress={handleThumbnailPress}
        onAddPress={handleAddMore}
        bottomInset={insets.bottom}
      />

      <ExportSheet
        visible={exportVisible}
        document={document}
        onClose={() => setExportVisible(false)}
      />

      <PageActionsSheet
        visible={actionsVisible}
        uri={document.pages[currentPage]}
        filter={document.filters?.[currentPage] ?? 'original'}
        onRotate={handleRotate}
        onFilter={handleFilter}
        onDelete={handleDeletePage}
        onShare={handleSharePage}
        onClose={() => setActionsVisible(false)}
      />

      <ReorderModal
        visible={reorderVisible}
        pages={document.pages}
        filters={document.filters}
        onConfirm={handleReorder}
        onCancel={() => setReorderVisible(false)}
      />
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
  back: { fontSize: 22, color: '#fff', fontWeight: '300' },
  title: { flex: 1, fontSize: 15, color: '#ccc', fontWeight: '600', textAlign: 'center', marginHorizontal: 8 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerBtn: { paddingHorizontal: 6 },
  headerBtnText: { fontSize: 16, color: '#fff' },
  exportBtn: { fontSize: 15, color: '#4ec6e0', fontWeight: '600' },
  page: {
    width: SCREEN_WIDTH,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  pageImage: { width: SCREEN_WIDTH - 32, flex: 1 },
  webView: { flex: 1, backgroundColor: '#111' },
});
