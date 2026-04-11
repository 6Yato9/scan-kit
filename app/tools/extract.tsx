// app/tools/extract.tsx
import { useEffect, useState } from 'react';
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
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { getDocuments, saveDocument } from '@/lib/storage';
import type { Document } from '@/types/document';

export default function ExtractScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [docs, setDocs] = useState<Document[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getDocuments().then(all => setDocs(all.filter(d => d.pages.length > 1))).catch(console.error);
  }, []);

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
    try {
      const sorted = [...selectedPages].sort((a, b) => a - b);
      const newId = Crypto.randomUUID();
      const now = Date.now();

      const destDir = new Directory(Paths.document, 'scan-kit', newId);
      destDir.create({ intermediates: true, idempotent: true });

      const newPages = sorted.map((srcIdx, destIdx) => {
        const src = new File(new Directory(Paths.document, 'scan-kit', selectedDoc.id), `page-${srcIdx}.jpg`);
        const dest = new File(destDir, `page-${destIdx}.jpg`);
        src.copy(dest);
        return dest.uri;
      });

      const newFilters = selectedDoc.filters
        ? sorted.map(i => selectedDoc.filters![i]).filter((f): f is NonNullable<typeof f> => f != null)
        : undefined;

      await saveDocument({
        id: newId,
        name: `${selectedDoc.name} (Extract)`,
        pages: newPages,
        filters: newFilters?.length ? newFilters : undefined,
        createdAt: now,
        updatedAt: now,
      });

      Alert.alert('Done', `${sorted.length} page${sorted.length !== 1 ? 's' : ''} extracted as a new document.`, [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch {
      Alert.alert('Error', 'Could not extract pages.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      {/* Header */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
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
                      <Text style={styles.pageIndexText}>{i + 1}</Text>
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
    left: 4,
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
