// app/review.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Crypto from 'expo-crypto';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import DocumentScanner from 'react-native-document-scanner-plugin';
import { useScan } from '@/contexts/scan-context';
import { useTheme } from '@/contexts/theme-context';
import { PageFilter } from '@/types/document';
import { saveDocument, updateDocument, getScanSettings, getDocSettings } from '@/lib/storage';
import { copyPageWithQuality, copyPdfToStorage, deleteDocumentFiles } from '@/lib/files';
import { ocrAvailable, extractDocText } from '@/lib/ocr';
import { filterStyle } from '@/lib/filters';
import { autoName } from '@/lib/auto-name';
import { notifySuccess } from '@/lib/haptics';

const FILTERS: { label: string; value: PageFilter | 'original' }[] = [
  { label: 'Original', value: 'original' },
  { label: 'Enhanced', value: 'enhanced' },
  { label: 'Grayscale', value: 'grayscale' },
  { label: 'B&W', value: 'bw' },
];

export default function ReviewScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const { colors, isDark } = useTheme();
  const {
    pendingPages,
    pendingPdfUri,
    pendingQuality,
    pendingDefaultFilter,
    clearPending,
    bumpLastSaved,
    triggerScan,
  } = useScan();

  const [pages, setPages] = useState<string[]>(pendingPages);
  const [filters, setFilters] = useState<(PageFilter | 'original')[]>(
    pendingPages.map(() => pendingDefaultFilter)
  );
  const initialName = useMemo(() => autoName(), []);
  const [name, setName] = useState(initialName);

  useEffect(() => {
    let cancelled = false;
    getDocSettings().then(s => {
      if (cancelled) return;
      // Only override the placeholder if the user hasn't started editing yet.
      // Without this, an in-flight async settings read could stomp the user's typing.
      setName(prev => (prev === initialName ? autoName(new Date(), s.namePrefix) : prev));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [initialName]);

  // If the user backs out of review (gesture or hardware back) without saving
  // or discarding, reset reviewVisible so the tab layout doesn't re-push us
  // back into review on the next focus.
  useEffect(() => {
    return () => { clearPending(); };
  }, [clearPending]);

  const [focusedIndex, setFocused] = useState(0);
  const [rotating, setRotating] = useState(false);
  const [saving, setSaving] = useState(false);

  const pagerRef = useRef<FlatList>(null);
  const onViewableItemsChanged = useRef(({ viewableItems }: any) => {
    if (viewableItems[0]?.index != null) {
      setFocused(viewableItems[0].index);
    }
  });
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 });

  // Approximate item height: screen minus top bar (~56) minus filter strip (~90) minus action row (~72) minus insets
  const ITEM_HEIGHT = useMemo(
    () => screenHeight - 56 - insets.top - 90 - 72 - insets.bottom,
    [screenHeight, insets.top, insets.bottom]
  );

  const handleDiscard = useCallback(() => {
    clearPending();
    router.back();
  }, [clearPending, router]);

  const handleSave = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName || saving) return;
    setSaving(true);
    const id = Crypto.randomUUID();
    try {
      const now = Date.now();

      if (pendingPdfUri) {
        const storedUri = copyPdfToStorage(pendingPdfUri, id);
        await saveDocument({ id, name: trimmedName, pages: [], pdfUri: storedUri, createdAt: now, updatedAt: now });
      } else {
        // Sequential writes so a single failure surfaces the failing page and
        // keeps peak memory bounded (Promise.all manipulator runs concurrently).
        const savedPages: string[] = [];
        for (let i = 0; i < pages.length; i++) {
          try {
            const uri = await copyPageWithQuality(pages[i], id, i, pendingQuality);
            savedPages.push(uri);
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            throw new Error(`Page ${i + 1}: ${m}`);
          }
        }
        const allOriginal = filters.every(f => f === 'original');
        const savedDoc = {
          id,
          name: trimmedName,
          pages: savedPages,
          filters: allOriginal ? undefined : (filters as PageFilter[]),
          createdAt: now,
          updatedAt: now,
        };
        await saveDocument(savedDoc);

        // Fire-and-forget content index so search can match recognized text.
        // Not awaited — save/navigation stays instant. Keep updatedAt unchanged
        // so the freshly-saved doc doesn't jump in the list when indexing lands.
        if (ocrAvailable()) {
          extractDocText(savedPages)
            .then(text => { if (text) updateDocument({ ...savedDoc, ocrText: text }); })
            .catch(() => {});
        }
      }

      bumpLastSaved();
      clearPending();
      notifySuccess();
      router.replace('/(tabs)/files');
    } catch (err) {
      console.error('Save failed', err);
      // Clean up any partially-written files for this document id
      try { deleteDocumentFiles(id); } catch { /* ignore secondary failure */ }
      const msg = err instanceof Error ? err.message : 'Could not save document.';
      Alert.alert('Save Failed', msg);
      setSaving(false);
    }
  }, [name, saving, pages, filters, pendingPdfUri, pendingQuality, clearPending, bumpLastSaved, router]);

  const handleRetake = useCallback(() => {
    clearPending();
    router.back();
    setTimeout(triggerScan, 350);
  }, [clearPending, router, triggerScan]);

  const rotatingRef = useRef(false);
  const handleRotate = useCallback(async () => {
    if (rotatingRef.current) return;
    rotatingRef.current = true;
    const targetIndex = focusedIndex;
    setRotating(true);
    try {
      const result = await manipulateAsync(
        pages[targetIndex],
        [{ rotate: 90 }],
        { compress: pendingQuality, format: SaveFormat.JPEG }
      );
      setPages(prev => {
        const next = [...prev];
        next[targetIndex] = result.uri;
        return next;
      });
    } catch (err) {
      console.error('Rotate failed', err);
    } finally {
      rotatingRef.current = false;
      setRotating(false);
    }
  }, [pages, focusedIndex, pendingQuality]);

  const croppingRef = useRef(false);
  const handleCrop = useCallback(async () => {
    if (croppingRef.current) return;
    croppingRef.current = true;
    const targetIndex = focusedIndex;
    try {
      const settings = await getScanSettings();
      const { scannedImages } = await DocumentScanner.scanDocument({
        croppedImageQuality: Math.round(pendingQuality * 100),
        maxNumDocuments: 1,
        letUserAdjustCrop: settings.autoCrop,
      } as any);
      if (!scannedImages?.length) return;
      setPages(prev => {
        const next = [...prev];
        next[targetIndex] = scannedImages[0];
        return next;
      });
    } catch (err) {
      console.error('Crop failed', err);
    } finally {
      croppingRef.current = false;
    }
  }, [focusedIndex, pendingQuality]);

  const handleDeletePage = useCallback(() => {
    if (pages.length === 1) {
      clearPending();
      router.back();
      return;
    }
    const newIndex = Math.min(focusedIndex, pages.length - 2);
    setPages(prev => prev.filter((_, i) => i !== focusedIndex));
    setFilters(prev => prev.filter((_, i) => i !== focusedIndex));
    setFocused(newIndex);
    setTimeout(() => {
      pagerRef.current?.scrollToIndex({ index: newIndex, animated: true });
    }, 50);
  }, [pages.length, focusedIndex, clearPending, router]);

  const addingPageRef = useRef(false);
  const handleAddPage = useCallback(async () => {
    if (addingPageRef.current) return;
    addingPageRef.current = true;
    try {
      const settings = await getScanSettings();
      const { scannedImages } = await DocumentScanner.scanDocument({
        croppedImageQuality: Math.round(pendingQuality * 100),
        letUserAdjustCrop: settings.autoCrop,
      } as any);
      if (!scannedImages?.length) return;
      const prevLength = pages.length;
      setPages(prev => [...prev, ...scannedImages]);
      setFilters(prev => [...prev, ...scannedImages.map(() => pendingDefaultFilter)]);
      setFocused(prevLength);
      setTimeout(() => {
        pagerRef.current?.scrollToIndex({ index: prevLength, animated: true });
      }, 100);
    } catch (err) {
      console.error('Add page failed', err);
    } finally {
      addingPageRef.current = false;
    }
  }, [pages.length, pendingDefaultFilter, pendingQuality]);

  const renderPage = useCallback(({ item: uri, index }: { item: string; index: number }) => {
    const fStyle = filterStyle(filters[index] as PageFilter);
    const isFocused = index === focusedIndex;
    return (
      <View style={{ height: ITEM_HEIGHT, justifyContent: 'center', alignItems: 'center', paddingVertical: 16, paddingHorizontal: 24 }}>
        <View style={[
          styles.pageCard,
          { opacity: isFocused ? 1 : 0.35, transform: [{ scale: isFocused ? 1 : 0.88 }] },
          isFocused && { borderColor: colors.accent, borderWidth: 2 },
        ]}>
          <Image
            source={{ uri }}
            style={[styles.pageImage, fStyle ? ({ filter: fStyle } as any) : undefined]}
            resizeMode="contain"
          />
        </View>
      </View>
    );
  }, [focusedIndex, filters, colors.accent, ITEM_HEIGHT]);

  // PDF import mode: simple preview, title editable, no filters or actions
  if (pendingPdfUri) {
    return (
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={[styles.container, { backgroundColor: colors.bg }]}
      >
        <View style={[styles.topBar, { paddingTop: insets.top + 8, borderBottomColor: colors.border }]}>
          <Pressable onPress={handleDiscard} hitSlop={12} style={styles.closeBtn}>
            <Ionicons name="close" size={22} color={colors.text} />
          </Pressable>
          <TextInput
            style={[styles.titleInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.input }]}
            value={name}
            onChangeText={setName}
            selectTextOnFocus
            returnKeyType="done"
          />
          <Pressable
            onPress={handleSave}
            disabled={!name.trim() || saving}
            style={[styles.doneBtn, { backgroundColor: colors.accent }, (!name.trim() || saving) && styles.doneBtnDisabled]}
          >
            {saving
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={styles.doneBtnText}>Done</Text>
            }
          </Pressable>
        </View>
        <View style={styles.pdfPreview}>
          <Text style={[styles.pdfLabel, { color: colors.muted }]}>PDF Document</Text>
          <Text style={[styles.pdfSub, { color: colors.muted }]}>Tap Done to save</Text>
        </View>
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.container, { backgroundColor: colors.bg }]}
    >
      {/* ① Top bar */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8, borderBottomColor: colors.border }]}>
        <Pressable onPress={handleDiscard} hitSlop={12} style={styles.closeBtn}>
          <Ionicons name="close" size={22} color={colors.text} />
        </Pressable>
        <TextInput
          style={[styles.titleInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.input }]}
          value={name}
          onChangeText={setName}
          selectTextOnFocus
          returnKeyType="done"
        />
        <Pressable
          onPress={handleSave}
          disabled={!name.trim() || saving}
          style={[styles.doneBtn, { backgroundColor: colors.accent }, (!name.trim() || saving) && styles.doneBtnDisabled]}
        >
          {saving
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={styles.doneBtnText}>Done</Text>
          }
        </Pressable>
      </View>

      {/* ② Page pager */}
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <FlatList
          ref={pagerRef}
          data={pages}
          keyExtractor={(_, i) => String(i)}
          showsVerticalScrollIndicator={false}
          snapToInterval={ITEM_HEIGHT}
          decelerationRate="fast"
          onViewableItemsChanged={onViewableItemsChanged.current}
          viewabilityConfig={viewabilityConfig.current}
          getItemLayout={(_, index) => ({ length: ITEM_HEIGHT, offset: ITEM_HEIGHT * index, index })}
          renderItem={renderPage}
        />
        {/* Page counter */}
        <View style={styles.pageCounter}>
          <Text allowFontScaling={false} style={styles.pageCounterText}>{focusedIndex + 1} / {pages.length}</Text>
        </View>
      </View>

      {/* ③ Filter strip */}
      <View style={[styles.filterStrip, { backgroundColor: isDark ? 'rgba(18,18,18,0.95)' : 'rgba(248,248,248,0.95)', borderTopColor: colors.border }]}>
        <Text style={[styles.filterLabel, { color: colors.muted }]}>
          FILTER — Page {focusedIndex + 1}
        </Text>
        <FlatList
          data={FILTERS}
          keyExtractor={f => f.value}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 12, gap: 10 }}
          renderItem={({ item: f }) => {
            const isSelected = filters[focusedIndex] === f.value;
            const fStyle = filterStyle(f.value as PageFilter);
            const thumbUri = pages[focusedIndex];
            return (
              <Pressable
                onPress={() => setFilters(prev => {
                  const next = [...prev];
                  next[focusedIndex] = f.value;
                  return next;
                })}
                style={styles.filterItem}
              >
                <View style={[
                  styles.filterThumb,
                  { borderColor: isSelected ? colors.accent : colors.border, borderWidth: isSelected ? 2 : 1 },
                ]}>
                  <Image
                    source={{ uri: thumbUri }}
                    style={[styles.filterThumbImage, fStyle ? ({ filter: fStyle } as any) : undefined]}
                    resizeMode="cover"
                  />
                </View>
                <Text allowFontScaling={false} style={[styles.filterItemLabel, { color: isSelected ? colors.accent : colors.muted }]}>
                  {f.label}
                </Text>
              </Pressable>
            );
          }}
        />
      </View>

      {/* ④ Action row */}
      <View style={[styles.actionRow, { backgroundColor: isDark ? 'rgba(18,18,18,0.95)' : 'rgba(248,248,248,0.95)', borderTopColor: colors.border, paddingBottom: insets.bottom + 8 }]}>
        {/* Retake */}
        <Pressable style={styles.actionBtn} onPress={handleRetake}>
          <MaterialCommunityIcons name="camera-retake-outline" size={24} color={colors.muted} />
          <Text allowFontScaling={false} style={[styles.actionLabel, { color: colors.muted }]}>Retake</Text>
        </Pressable>

        {/* Rotate */}
        <Pressable style={styles.actionBtn} onPress={handleRotate} disabled={rotating}>
          {rotating
            ? <ActivityIndicator size="small" color={colors.muted} />
            : <MaterialCommunityIcons name="rotate-right" size={24} color={colors.muted} />
          }
          <Text allowFontScaling={false} style={[styles.actionLabel, { color: colors.muted }]}>Rotate</Text>
        </Pressable>

        {/* Crop (re-scan this page) */}
        <Pressable style={styles.actionBtn} onPress={handleCrop}>
          <Ionicons name="crop" size={24} color={colors.muted} />
          <Text allowFontScaling={false} style={[styles.actionLabel, { color: colors.muted }]}>Crop</Text>
        </Pressable>

        {/* Delete */}
        <Pressable style={styles.actionBtn} onPress={handleDeletePage}>
          <Ionicons name="trash-outline" size={24} color={colors.muted} />
          <Text allowFontScaling={false} style={[styles.actionLabel, { color: colors.muted }]}>Delete</Text>
        </Pressable>

        {/* Add Page */}
        <Pressable style={styles.actionBtn} onPress={handleAddPage}>
          <MaterialCommunityIcons name="camera-plus-outline" size={24} color={colors.muted} />
          <Text allowFontScaling={false} style={[styles.actionLabel, { color: colors.muted }]}>Add Page</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 10,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  closeBtn: { padding: 4 },
  titleInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 14,
  },
  doneBtn: {
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minWidth: 72,
    alignItems: 'center',
  },
  doneBtnDisabled: { opacity: 0.4 },
  doneBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  pdfPreview: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pdfLabel: { fontSize: 18, fontWeight: '600', marginBottom: 8 },
  pdfSub: { fontSize: 14 },
  pageCard: {
    flex: 1,
    width: '100%',
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  pageImage: {
    width: '100%',
    height: '100%',
  },
  pageCounter: {
    position: 'absolute',
    bottom: 12,
    end: 12,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  pageCounterText: {
    color: '#fff',
    fontSize: 12,
  },
  filterStrip: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    paddingBottom: 6,
  },
  filterLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
    marginStart: 14,
    marginBottom: 6,
  },
  filterItem: {
    alignItems: 'center',
    gap: 4,
  },
  filterThumb: {
    width: 52,
    height: 52,
    borderRadius: 8,
    overflow: 'hidden',
  },
  filterThumbImage: {
    width: '100%',
    height: '100%',
  },
  filterItemLabel: {
    fontSize: 10,
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 10,
  },
  actionBtn: {
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
  },
  actionLabel: {
    fontSize: 10,
  },
});
