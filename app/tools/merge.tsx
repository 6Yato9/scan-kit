// app/tools/merge.tsx
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Crypto from 'expo-crypto';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { getDocuments, saveDocument } from '@/lib/storage';
import { appendPages, deleteDocumentFiles } from '@/lib/files';
import { autoName } from '@/lib/auto-name';
import type { Document, PageAdjustment, PageFilter } from '@/types/document';

export default function MergeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [docs, setDocs] = useState<Document[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState(autoName(new Date(), 'Merged'));
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    getDocuments()
      .then(all => setDocs(all.filter(d => d.pages.length > 0)))
      .catch(console.error);
  }, []);

  const toggle = (id: string) => {
    setSelected(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const selectedDocs = selected
    .map(id => docs.find(d => d.id === id))
    .filter(Boolean) as Document[];

  const totalPages = selectedDocs.reduce((sum, d) => sum + d.pages.length, 0);

  const handleMerge = async () => {
    if (selectedDocs.length < 2) return;
    if (!name.trim()) return;

    setMerging(true);
    const id = Crypto.randomUUID();
    try {
      const now = Date.now();

      const pages: string[] = [];
      const filters: PageFilter[] = [];
      const adjustments: PageAdjustment[] = [];

      let pageIdx = 0;
      for (const doc of selectedDocs) {
        const newUris = appendPages(doc.pages, id, pageIdx);
        pages.push(...newUris);
        for (let i = 0; i < doc.pages.length; i++) {
          filters.push(doc.filters?.[i] ?? 'original');
          adjustments.push(doc.adjustments?.[i] ?? { brightness: 0, contrast: 0, saturation: 0 });
        }
        pageIdx += doc.pages.length;
      }

      const allOriginal = filters.every(f => f === 'original');
      const allDefault = adjustments.every(
        a => a.brightness === 0 && a.contrast === 0 && a.saturation === 0,
      );

      await saveDocument({
        id,
        name: name.trim(),
        pages,
        filters: allOriginal ? undefined : filters,
        adjustments: allDefault ? undefined : adjustments,
        createdAt: now,
        updatedAt: now,
      });

      Alert.alert('Done', `"${name.trim()}" saved with ${totalPages} pages.`, [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch {
      // Roll back any files we copied so we don't leave orphans.
      try { deleteDocumentFiles(id); } catch {}
      Alert.alert('Error', 'Could not merge documents.');
    } finally {
      setMerging(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      {/* Header */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>Merge Documents</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* Output name */}
        <Text style={[styles.sectionLabel, { color: colors.muted }]}>OUTPUT NAME</Text>
        <TextInput
          style={[styles.nameInput, { color: colors.text, backgroundColor: colors.card, borderColor: colors.border }]}
          value={name}
          onChangeText={setName}
          placeholder="Merged document name"
          placeholderTextColor={colors.muted}
          returnKeyType="done"
          maxLength={60}
        />

        {/* Document picker */}
        <Text style={[styles.sectionLabel, { color: colors.muted, marginTop: 20 }]}>
          SELECT DOCUMENTS{selected.length > 0 ? ` (${selected.length} selected · ${totalPages} pages)` : ''}
        </Text>

        {docs.length === 0 ? (
          <Text style={[styles.emptyText, { color: colors.muted }]}>
            No documents found. Scan some documents first.
          </Text>
        ) : (
          docs.map(doc => {
            const isSelected = selected.includes(doc.id);
            const order = selected.indexOf(doc.id) + 1;
            return (
              <Pressable
                key={doc.id}
                style={[
                  styles.docRow,
                  {
                    backgroundColor: colors.card,
                    borderColor: isSelected ? colors.accent : 'transparent',
                  },
                ]}
                onPress={() => toggle(doc.id)}
              >
                {/* Thumbnail */}
                <Image
                  source={{ uri: `${doc.pages[0]}?v=${doc.updatedAt}` }}
                  style={styles.thumb}
                  resizeMode="cover"
                />

                {/* Info */}
                <View style={{ flex: 1 }}>
                  <Text style={[styles.docName, { color: colors.text }]} numberOfLines={1}>
                    {doc.name}
                  </Text>
                  <Text style={[styles.docMeta, { color: colors.muted }]}>
                    {doc.pages.length} page{doc.pages.length !== 1 ? 's' : ''}
                  </Text>
                </View>

                {/* Selection indicator */}
                {isSelected ? (
                  <View style={[styles.orderBadge, { backgroundColor: colors.accent }]}>
                    <Text style={styles.orderText}>{order}</Text>
                  </View>
                ) : (
                  <View style={[styles.emptyBadge, { borderColor: colors.border }]} />
                )}
              </Pressable>
            );
          })
        )}

        {/* Merge hint */}
        {selected.length === 1 && (
          <Text style={[styles.hint, { color: colors.muted }]}>
            Select at least one more document to merge.
          </Text>
        )}

        {/* Merge button */}
        {selectedDocs.length >= 2 && name.trim() && (
          <Pressable
            style={[
              styles.mergeBtn,
              { backgroundColor: colors.accent, opacity: merging ? 0.6 : 1 },
            ]}
            onPress={handleMerge}
            disabled={merging}
          >
            {merging ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.mergeBtnText}>
                Merge {selected.length} Documents → {totalPages} pages
              </Text>
            )}
          </Pressable>
        )}

        <Text style={[styles.footnote, { color: colors.muted }]}>
          Pages are merged in the order you selected. Your original documents are unchanged.
        </Text>
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
  nameInput: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  emptyText: { fontSize: 14, fontStyle: 'italic' },
  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 10,
    borderRadius: 12,
    marginBottom: 8,
    borderWidth: 1.5,
  },
  thumb: {
    width: 44,
    height: 58,
    borderRadius: 6,
    backgroundColor: '#333',
  },
  docName: { fontSize: 15, fontWeight: '600' },
  docMeta: { fontSize: 12, marginTop: 2 },
  orderBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  orderText: { fontSize: 13, fontWeight: '800', color: '#fff' },
  emptyBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1.5,
  },
  hint: { fontSize: 13, fontStyle: 'italic', textAlign: 'center', marginTop: 8 },
  mergeBtn: {
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 24,
  },
  mergeBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  footnote: { fontSize: 12, marginTop: 12, textAlign: 'center', fontStyle: 'italic' },
});
