// app/(tabs)/index.tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Crypto from 'expo-crypto';
import { Document, PageFilter } from '@/types/document';
import {
  getDocuments,
  deleteDocument,
  updateDocument,
  saveDocument,
  getSortPreference,
  saveSortPreference,
  SortKey,
} from '@/lib/storage';
import { deleteDocumentFiles, copyDocumentFiles, appendPages } from '@/lib/files';
import { useScan } from '@/contexts/scan-context';
import { useTheme } from '@/contexts/theme-context';
import { DocActionsSheet } from '@/components/doc-actions-sheet';
import { RenameSheet } from '@/components/rename-sheet';
import { MergeSheet } from '@/components/merge-sheet';
import { SortSheet } from '@/components/sort-sheet';

function sortDocuments(docs: Document[], key: SortKey): Document[] {
  switch (key) {
    case 'dateModified':
      return [...docs].sort((a, b) => b.updatedAt - a.updatedAt);
    case 'nameAZ':
      return [...docs].sort((a, b) => a.name.localeCompare(b.name));
    default:
      return [...docs].sort((a, b) => b.createdAt - a.createdAt);
  }
}

export default function HomeScreen() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('dateAdded');
  const [sortSheetVisible, setSortSheetVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [docActionsTarget, setDocActionsTarget] = useState<Document | null>(null);
  const [renameTarget, setRenameTarget] = useState<Document | null>(null);
  const [mergeTarget, setMergeTarget] = useState<Document | null>(null);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { lastSaved } = useScan();
  const { colors } = useTheme();

  const load = useCallback(async () => {
    const [docs, sort] = await Promise.all([getDocuments(), getSortPreference()]);
    setDocuments(docs);
    setSortKey(sort);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { if (lastSaved > 0) load(); }, [lastSaved, load]);

  const displayed = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = q ? documents.filter(d => d.name.toLowerCase().includes(q)) : documents;
    const sorted = sortDocuments(filtered, sortKey);
    return q ? sorted : sorted.slice(0, 10);
  }, [documents, searchQuery, sortKey]);

  const handleDelete = useCallback(async (doc: Document) => {
    Alert.alert('Delete document?', `"${doc.name}" will be permanently deleted.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteDocument(doc.id);
          deleteDocumentFiles(doc.id);
          setDocuments(prev => prev.filter(d => d.id !== doc.id));
        },
      },
    ]);
  }, []);

  const handleDuplicate = useCallback(async (doc: Document) => {
    try {
      const newId = Crypto.randomUUID();
      const now = Date.now();
      if (doc.pdfUri) {
        const { copyPdfToStorage } = await import('@/lib/files');
        const storedUri = copyPdfToStorage(doc.pdfUri, newId);
        const newDoc: Document = {
          id: newId,
          name: `Copy of ${doc.name}`,
          pages: [],
          pdfUri: storedUri,
          createdAt: now,
          updatedAt: now,
        };
        await saveDocument(newDoc);
        setDocuments(prev => [newDoc, ...prev]);
      } else {
        const newPages = copyDocumentFiles(doc.id, newId, doc.pages);
        const newDoc: Document = {
          id: newId,
          name: `Copy of ${doc.name}`,
          pages: newPages,
          filters: doc.filters ? [...doc.filters] : undefined,
          createdAt: now,
          updatedAt: now,
        };
        await saveDocument(newDoc);
        setDocuments(prev => [newDoc, ...prev]);
      }
    } catch (err) {
      console.error('Duplicate failed', err);
      Alert.alert('Duplicate Failed', 'Could not duplicate the document.');
    }
  }, []);

  const handleRename = useCallback(async (doc: Document, newName: string) => {
    const updated = { ...doc, name: newName, updatedAt: Date.now() };
    await updateDocument(updated);
    setDocuments(prev => prev.map(d => (d.id === doc.id ? updated : d)));
    setRenameTarget(null);
  }, []);

  const handleMerge = useCallback(async (targetDoc: Document, sourceDoc: Document) => {
    // Non-destructive merge: source document is preserved. Pages are copied into target.
    const newPageUris = appendPages(sourceDoc.pages, targetDoc.id, targetDoc.pages.length);
    const targetFilters: PageFilter[] = targetDoc.filters ?? targetDoc.pages.map(() => 'original' as PageFilter);
    const sourceFilters: PageFilter[] = sourceDoc.filters ?? sourceDoc.pages.map(() => 'original' as PageFilter);
    const combined = [...targetFilters, ...sourceFilters];
    const allOriginal = combined.every(f => f === 'original');
    const updated: Document = {
      ...targetDoc,
      pages: [...targetDoc.pages, ...newPageUris],
      filters: allOriginal ? undefined : combined,
      updatedAt: Date.now(),
    };
    await updateDocument(updated);
    setDocuments(prev => prev.map(d => (d.id === updated.id ? updated : d)));
  }, []);

  const handleSort = useCallback(async (key: SortKey) => {
    setSortKey(key);
    await saveSortPreference(key);
  }, []);

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.bg }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]}>Recent</Text>
        <Pressable style={styles.sortBtnRow} onPress={() => setSortSheetVisible(true)} hitSlop={12}>
          <Ionicons name="swap-vertical" size={16} color={colors.accent} />
          <Text style={[styles.sortBtn, { color: colors.accent }]}>Sort</Text>
        </Pressable>
      </View>

      <View style={styles.searchRow}>
        <TextInput
          style={[styles.searchInput, { backgroundColor: colors.input, color: colors.text }]}
          placeholder="Search documents…"
          placeholderTextColor={colors.muted}
          value={searchQuery}
          onChangeText={setSearchQuery}
          clearButtonMode="while-editing"
          returnKeyType="search"
        />
      </View>

      <FlatList
        data={displayed}
        keyExtractor={d => d.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: colors.muted }]}>
              {searchQuery.trim()
                ? `No results for "${searchQuery.trim()}"`
                : 'No documents yet. Tap the camera button to scan.'}
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            style={[styles.row, { backgroundColor: colors.card }]}
            onPress={() => router.push({ pathname: '/viewer', params: { id: item.id } })}
            onLongPress={() => setDocActionsTarget(item)}
          >
            {item.pdfUri ? (
              <View style={[styles.thumb, { backgroundColor: colors.placeholder, alignItems: 'center', justifyContent: 'center' }]}>
                <Ionicons name="document-text" size={28} color={colors.muted} />
              </View>
            ) : item.pages[0] ? (
              <Image source={{ uri: item.pages[0] }} style={styles.thumb} resizeMode="cover" />
            ) : (
              <View style={[styles.thumb, { backgroundColor: colors.placeholder }]} />
            )}
            <View style={styles.rowInfo}>
              <Text style={[styles.rowName, { color: colors.text }]} numberOfLines={1}>{item.name}</Text>
              <Text style={[styles.rowMeta, { color: colors.muted }]}>
                {item.pdfUri ? 'PDF' : `${item.pages.length} page${item.pages.length !== 1 ? 's' : ''}`}
                {' · '}
                {new Date(item.updatedAt).toLocaleDateString()}
              </Text>
            </View>
            <Text style={[styles.chevron, { color: colors.border }]}>›</Text>
          </Pressable>
        )}
      />

      <SortSheet
        visible={sortSheetVisible}
        current={sortKey}
        onSort={handleSort}
        onClose={() => setSortSheetVisible(false)}
      />

      <DocActionsSheet
        visible={docActionsTarget !== null}
        document={docActionsTarget}
        onRename={doc => { setDocActionsTarget(null); setRenameTarget(doc); }}
        onDuplicate={doc => { setDocActionsTarget(null); handleDuplicate(doc).catch(console.error); }}
        onMerge={doc => { setDocActionsTarget(null); setMergeTarget(doc); }}
        onSelect={() => setDocActionsTarget(null)}
        onDelete={doc => { setDocActionsTarget(null); handleDelete(doc); }}
        onMoveToFolder={() => setDocActionsTarget(null)}
        onClose={() => setDocActionsTarget(null)}
      />

      <RenameSheet
        visible={renameTarget !== null}
        document={renameTarget}
        onRename={handleRename}
        onDelete={handleDelete}
        onClose={() => setRenameTarget(null)}
      />

      <MergeSheet
        visible={mergeTarget !== null}
        targetDoc={mergeTarget}
        allDocs={documents}
        onMerge={handleMerge}
        onClose={() => setMergeTarget(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 8,
  },
  title: { fontSize: 30, fontWeight: '800', letterSpacing: -0.5 },
  sortBtnRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  sortBtn: { fontSize: 14, fontWeight: '600' },
  searchRow: { paddingHorizontal: 14, paddingBottom: 10 },
  searchInput: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 9,
    fontSize: 15,
  },
  listContent: { paddingHorizontal: 14, paddingBottom: 80 },
  empty: { alignItems: 'center', paddingTop: 60 },
  emptyText: { fontSize: 15, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    marginBottom: 8,
    padding: 10,
    gap: 12,
  },
  thumb: {
    width: 48,
    height: 64,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowInfo: { flex: 1 },
  rowName: { fontSize: 15, fontWeight: '600' },
  rowMeta: { fontSize: 12, marginTop: 2 },
  chevron: { fontSize: 20 },
});
