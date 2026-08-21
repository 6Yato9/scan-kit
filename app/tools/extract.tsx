// app/tools/extract.tsx
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { getDocuments, saveDocument } from '@/lib/storage';
import { deleteDocumentFiles } from '@/lib/files';
import { notifySuccess, notifyError } from '@/lib/haptics';
import type { Document } from '@/types/document';

export default function ExtractScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [docs, setDocs] = useState<Document[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    getDocuments()
      .then(all => {
        if (cancelled) return;
        const filtered = all.filter(d => d.pages.length > 1 && !d.pdfUri);
        setDocs(filtered);
        setSelectedDoc(prev => (prev && filtered.some(d => d.id === prev.id) ? prev : null));
      })
      .catch(console.error);
    return () => { cancelled = true; };
  }, []));

  const togglePage = (index: number) => {
    setSelectedPages(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const pickDoc = (doc: Document) => {
    setSelectedDoc(doc);
    setSelectedPages(new Set());
  };

  const handleExtract = async () => {
    if (!selectedDoc || selectedPages.size === 0) return;
    setSaving(true);
    const newId = Crypto.randomUUID();
    try {
      const sorted = [...selectedPages].sort((a, b) => a - b);
      const now = Date.now();

      const destDir = new Directory(Paths.document, 'scan-kit', newId);
      destDir.create({ intermediates: true, idempotent: true });

      // Copy from the actual page URIs stored on the doc (not a reconstructed path)
      // so we don't assume the on-disk layout matches the doc.pages array order.
      const newPages = sorted.map((srcIdx, destIdx) => {
        const sourceUri = selectedDoc.pages[srcIdx];
        if (!sourceUri) throw new Error(`Source page ${srcIdx} missing in document`);
        // Strip any cache-bust query suffix before constructing File()
        const srcPath = sourceUri.split('?')[0];
        const src = new File(srcPath);
        if (!src.exists) throw new Error(`Source file missing: ${srcPath}`);
        const dest = new File(destDir, `page-${destIdx}.jpg`);
        src.copy(dest);
        return dest.uri;
      });

      const newFilters = selectedDoc.filters
        ? sorted.map(i => selectedDoc.filters![i] ?? 'original')
        : undefined;
      const allOriginal = !newFilters || newFilters.every(f => f === 'original');

      const newAdjustments = selectedDoc.adjustments
        ? sorted.map(i => selectedDoc.adjustments![i] ?? { brightness: 0, contrast: 0, saturation: 0 })
        : undefined;
      const allDefault = !newAdjustments || newAdjustments.every(
        a => a.brightness === 0 && a.contrast === 0 && a.saturation === 0,
      );

      await saveDocument({
        id: newId,
        name: `${selectedDoc.name} (Extract)`,
        pages: newPages,
        filters: allOriginal ? undefined : newFilters,
        adjustments: allDefault ? undefined : newAdjustments,
        folder: selectedDoc.folder,
        createdAt: now,
        updatedAt: now,
      });

      notifySuccess();
      Alert.alert('Done', `${sorted.length} page${sorted.length !== 1 ? 's' : ''} extracted as a new document.`, [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch (err) {
      // Roll back any half-copied files so we don't leave an orphan directory.
      try { deleteDocumentFiles(newId); } catch {}
      notifyError();
      const msg = err instanceof Error ? err.message : 'Could not extract pages.';
      Alert.alert('Error', msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      {/* Header */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
          <Ionicons name="close" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>Extract Pages</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        {/* Step 1: pick document */}
        <Text style={[styles.sectionLabel, { color: colors.muted }]}>SELECT DOCUMENT</Text>
        {docs.length === 0 ? (
          <Text style={[styles.emptyText, { color: colors.muted }]}>No multi-page documents found. Documents need at least 2 pages.</Text>
        ) : (
          docs.map(doc => (
            <Pressable
              key={doc.id}
              style={[styles.docRow, { backgroundColor: colors.card, borderColor: selectedDoc?.id === doc.id ? colors.accent : 'transparent' }]}
              onPress={() => pickDoc(doc)}
            >
              <Ionicons name="document-text-outline" size={22} color={colors.muted} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.docName, { color: colors.text }]} numberOfLines={1}>{doc.name}</Text>
                <Text style={[styles.docMeta, { color: colors.muted }]}>{doc.pages.length} pages</Text>
              </View>
              {selectedDoc?.id === doc.id && <Ionicons name="checkmark-circle" size={22} color={colors.accent} />}
            </Pressable>
          ))
        )}

        {/* Step 2: pick pages */}
        {selectedDoc && (
          <>
            <Text style={[styles.sectionLabel, { color: colors.muted, marginTop: 24 }]}>
              SELECT PAGES TO EXTRACT ({selectedPages.size} selected)
            </Text>
            <View style={styles.pageGrid}>
              {selectedDoc.pages.map((uri, i) => {
                const isSelected = selectedPages.has(i);
                return (
                  <Pressable
                    key={i}
                    style={[styles.pageCard, { borderColor: isSelected ? colors.accent : colors.border, borderWidth: isSelected ? 2 : 1 }]}
                    onPress={() => togglePage(i)}
                  >
                    <Image source={{ uri }} style={styles.pageThumb} resizeMode="cover" />
                    <View style={[styles.pageIndex, { backgroundColor: isSelected ? colors.accent : 'rgba(0,0,0,0.4)' }]}>
                      <Text allowFontScaling={false} style={styles.pageIndexText}>{i + 1}</Text>
                    </View>
                    {isSelected && (
                      <View style={styles.checkOverlay}>
                        <Ionicons name="checkmark-circle" size={28} color={colors.accent} />
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </View>

            {selectedPages.size > 0 && (
              <Pressable
                style={[styles.applyBtn, { backgroundColor: colors.accent, opacity: saving ? 0.6 : 1, marginTop: 24 }]}
                onPress={handleExtract}
                disabled={saving}
              >
                {saving
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={styles.applyBtnText}>Extract {selectedPages.size} Page{selectedPages.size !== 1 ? 's' : ''}</Text>
                }
              </Pressable>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  title: { fontSize: 17, fontWeight: '700' },
  content: { paddingHorizontal: 16 },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginBottom: 8 },
  emptyText: { fontSize: 14, fontStyle: 'italic' },
  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 12,
    marginBottom: 8,
    borderWidth: 1.5,
  },
  docName: { fontSize: 15, fontWeight: '600' },
  docMeta: { fontSize: 12, marginTop: 2 },
  pageGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  pageCard: {
    width: '30%',
    aspectRatio: 0.75,
    borderRadius: 8,
    overflow: 'hidden',
    position: 'relative',
  },
  pageThumb: { width: '100%', height: '100%' },
  pageIndex: {
    position: 'absolute',
    top: 4,
    start: 4,
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  pageIndexText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  checkOverlay: {
    position: 'absolute',
    inset: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  applyBtn: { borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  applyBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
