// app/tools/compress.tsx
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { getDocuments, updateDocument } from '@/lib/storage';
import { replacePage } from '@/lib/files';
import type { Document } from '@/types/document';

const QUALITY_OPTIONS = [
  { label: 'Low', value: 0.4, desc: 'Smallest size, lower quality' },
  { label: 'Medium', value: 0.65, desc: 'Good balance of size and quality' },
  { label: 'High', value: 0.85, desc: 'Near-original quality, moderate size saving' },
];

export default function CompressScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [docs, setDocs] = useState<Document[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);
  const [quality, setQuality] = useState(0.65);
  const [compressing, setCompressing] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    getDocuments()
      .then(all => { if (!cancelled) setDocs(all.filter(d => d.pages.length > 0 && !d.pdfUri)); })
      .catch(console.error);
    return () => { cancelled = true; };
  }, []));

  const handleCompress = async () => {
    if (!selectedDoc) return;
    Alert.alert(
      'Compress Document',
      `This will replace the images in "${selectedDoc.name}" with compressed versions. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Compress',
          style: 'destructive',
          onPress: async () => {
            setCompressing(true);
            setProgress({ current: 0, total: selectedDoc.pages.length });
            try {
              const newPages: string[] = [];
              for (let i = 0; i < selectedDoc.pages.length; i++) {
                setProgress({ current: i + 1, total: selectedDoc.pages.length });
                // Strip any cache-bust suffix before handing to manipulateAsync.
                const sourceUri = selectedDoc.pages[i].split('?')[0];
                const result = await manipulateAsync(
                  sourceUri,
                  [],
                  { compress: quality, format: SaveFormat.JPEG }
                );
                const stored = replacePage(result.uri, selectedDoc.id, i);
                newPages.push(stored);
              }
              await updateDocument({ ...selectedDoc, pages: newPages, updatedAt: Date.now() });
              Alert.alert('Done', `"${selectedDoc.name}" has been compressed.`, [
                { text: 'OK', onPress: () => router.back() },
              ]);
            } catch {
              Alert.alert('Error', 'Compression failed. Some pages may be unchanged.');
            } finally {
              setCompressing(false);
              setProgress(null);
            }
          },
        },
      ]
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      {/* Header */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>Compress</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        {/* Quality picker */}
        <Text style={[styles.sectionLabel, { color: colors.muted }]}>QUALITY</Text>
        <View style={[styles.qualityCard, { backgroundColor: colors.card }]}>
          {QUALITY_OPTIONS.map((opt, i) => (
            <Pressable
              key={opt.label}
              style={[
                styles.qualityRow,
                i < QUALITY_OPTIONS.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
              ]}
              onPress={() => setQuality(opt.value)}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.qualityLabel, { color: colors.text }]}>{opt.label}</Text>
                <Text style={[styles.qualityDesc, { color: colors.muted }]}>{opt.desc}</Text>
              </View>
              {quality === opt.value && <Ionicons name="checkmark" size={20} color={colors.accent} />}
            </Pressable>
          ))}
        </View>

        {/* Document list */}
        <Text style={[styles.sectionLabel, { color: colors.muted, marginTop: 24 }]}>SELECT DOCUMENT</Text>
        {docs.length === 0 ? (
          <Text style={[styles.emptyText, { color: colors.muted }]}>No scanned documents found. Scan a document first.</Text>
        ) : (
          docs.map(doc => (
            <Pressable
              key={doc.id}
              style={[styles.docRow, { backgroundColor: colors.card, borderColor: selectedDoc?.id === doc.id ? colors.accent : 'transparent' }]}
              onPress={() => setSelectedDoc(doc)}
            >
              <Ionicons name="document-text-outline" size={22} color={colors.muted} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.docName, { color: colors.text }]} numberOfLines={1}>{doc.name}</Text>
                <Text style={[styles.docMeta, { color: colors.muted }]}>{doc.pages.length} page{doc.pages.length !== 1 ? 's' : ''}</Text>
              </View>
              {selectedDoc?.id === doc.id && <Ionicons name="checkmark-circle" size={22} color={colors.accent} />}
            </Pressable>
          ))
        )}

        {selectedDoc && (
          <Pressable
            style={[styles.applyBtn, { backgroundColor: colors.accent, opacity: compressing ? 0.6 : 1, marginTop: 24 }]}
            onPress={handleCompress}
            disabled={compressing}
          >
            {compressing ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <ActivityIndicator color="#fff" />
                {progress && (
                  <Text style={styles.applyBtnText}>
                    Compressing {progress.current}/{progress.total}…
                  </Text>
                )}
              </View>
            ) : (
              <Text style={styles.applyBtnText}>Compress Document</Text>
            )}
          </Pressable>
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
  qualityCard: { borderRadius: 12, overflow: 'hidden' },
  qualityRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, gap: 12 },
  qualityLabel: { fontSize: 15, fontWeight: '600', marginBottom: 2 },
  qualityDesc: { fontSize: 12 },
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
  applyBtn: { borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  applyBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
