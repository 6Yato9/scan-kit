// app/index.tsx
import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DocumentScanner from 'react-native-document-scanner-plugin';
import * as Crypto from 'expo-crypto';
import { Document, PageFilter } from '@/types/document';
import {
  getDocuments,
  saveDocument,
  updateDocument,
  deleteDocument,
  getSortPreference,
  saveSortPreference,
  SortKey,
} from '@/lib/storage';
import {
  copyPageToStorage,
  deleteDocumentFiles,
  appendPages,
  copyDocumentFiles,
} from '@/lib/files';
import { DocumentCard } from '@/components/document-card';
import { EmptyState } from '@/components/empty-state';
import { ScanNameSheet } from '@/components/scan-name-sheet';
import { RenameSheet } from '@/components/rename-sheet';
import { SortSheet } from '@/components/sort-sheet';
import { DocActionsSheet } from '@/components/doc-actions-sheet';
import { MergeSheet } from '@/components/merge-sheet';

function sortDocuments(docs: Document[], key: SortKey): Document[] {
  const sorted = [...docs];
  switch (key) {
    case 'dateModified':
      return sorted.sort((a, b) => b.updatedAt - a.updatedAt);
    case 'nameAZ':
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
    default:
      return sorted.sort((a, b) => b.createdAt - a.createdAt);
  }
}

export default function HomeScreen() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [pendingPages, setPendingPages] = useState<string[]>([]);
  const [nameSheetVisible, setNameSheetVisible] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('dateAdded');
  const [sortSheetVisible, setSortSheetVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [docActionsTarget, setDocActionsTarget] = useState<Document | null>(null);
  const [renameTarget, setRenameTarget] = useState<Document | null>(null);
  const [mergeTarget, setMergeTarget] = useState<Document | null>(null);
  const insets = useSafeAreaInsets();
  const router = useRouter();

  useFocusEffect(
    useCallback(() => {
      async function load() {
        const [docs, sort] = await Promise.all([getDocuments(), getSortPreference()]);
        setDocuments(docs);
        setSortKey(sort);
      }
      load();
      // Clear multi-select when coming back into focus
      setSelectedIds(new Set());
    }, [])
  );

  const displayedDocuments = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = q ? documents.filter(d => d.name.toLowerCase().includes(q)) : documents;
    return sortDocuments(filtered, sortKey);
  }, [documents, searchQuery, sortKey]);

  const isMultiSelectMode = selectedIds.size > 0;

  const handleScan = useCallback(async () => {
    try {
      const { scannedImages } = await DocumentScanner.scanDocument();
      if (!scannedImages?.length) return;
      setPendingPages(scannedImages);
      setNameSheetVisible(true);
    } catch (err) {
      console.error('Scan failed', err);
    }
  }, []);

  const handleSave = useCallback(
    async (name: string) => {
      try {
        const id = Crypto.randomUUID();
        const now = Date.now();
        const savedPages = await Promise.all(
          pendingPages.map((uri, i) => copyPageToStorage(uri, id, i))
        );
        const doc: Document = { id, name, pages: savedPages, createdAt: now, updatedAt: now };
        await saveDocument(doc);
        setDocuments(prev => [doc, ...prev]);
        setNameSheetVisible(false);
        setPendingPages([]);
      } catch (err) {
        console.error('Save failed', err);
      }
    },
    [pendingPages]
  );

  const handleRetake = useCallback(() => {
    setNameSheetVisible(false);
    setPendingPages([]);
    setTimeout(handleScan, 350);
  }, [handleScan]);

  const handleCardPress = useCallback((doc: Document) => {
    if (isMultiSelectMode) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(doc.id)) next.delete(doc.id);
        else next.add(doc.id);
        return next;
      });
    } else {
      router.push({ pathname: '/viewer', params: { id: doc.id } });
    }
  }, [isMultiSelectMode, router]);

  const handleCardLongPress = useCallback((doc: Document) => {
    if (isMultiSelectMode) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(doc.id)) next.delete(doc.id);
        else next.add(doc.id);
        return next;
      });
    } else {
      setDocActionsTarget(doc);
    }
  }, [isMultiSelectMode]);

  const handleRename = useCallback(async (doc: Document, newName: string) => {
    const updated = { ...doc, name: newName, updatedAt: Date.now() };
    await updateDocument(updated);
    setDocuments(prev => prev.map(d => (d.id === doc.id ? updated : d)));
    setRenameTarget(null);
  }, []);

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
    const newId = Crypto.randomUUID();
    const now = Date.now();
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
  }, []);

  const handleMerge = useCallback(async (targetDoc: Document, sourceDoc: Document) => {
    const newPageUris = appendPages(sourceDoc.pages, targetDoc.id, targetDoc.pages.length);
    const targetFilters: PageFilter[] = targetDoc.filters ?? targetDoc.pages.map(() => 'original');
    const sourceFilters: PageFilter[] = sourceDoc.filters ?? sourceDoc.pages.map(() => 'original');
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

  const handleSelect = useCallback((doc: Document) => {
    setSelectedIds(new Set([doc.id]));
  }, []);

  const handleSort = useCallback(async (key: SortKey) => {
    setSortKey(key);
    await saveSortPreference(key);
  }, []);

  const handleBatchDelete = useCallback(() => {
    Alert.alert(
      `Delete ${selectedIds.size} document${selectedIds.size !== 1 ? 's' : ''}?`,
      'This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const ids = Array.from(selectedIds);
            for (const id of ids) {
              await deleteDocument(id);
              deleteDocumentFiles(id);
            }
            setDocuments(prev => prev.filter(d => !ids.includes(d.id)));
            setSelectedIds(new Set());
          },
        },
      ]
    );
  }, [selectedIds]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Scan Kit</Text>
        <Pressable onPress={() => setSortSheetVisible(true)} hitSlop={12}>
          <Text style={styles.sortBtn}>↕ Sort</Text>
        </Pressable>
      </View>

      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search documents…"
          placeholderTextColor="#aaa"
          value={searchQuery}
          onChangeText={setSearchQuery}
          clearButtonMode="while-editing"
          returnKeyType="search"
        />
      </View>

      <FlatList
        data={displayedDocuments}
        keyExtractor={d => d.id}
        numColumns={2}
        contentContainerStyle={
          displayedDocuments.length === 0 ? styles.emptyContent : styles.gridContent
        }
        ListEmptyComponent={
          searchQuery.trim() ? (
            <View style={styles.noResults}>
              <Text style={styles.noResultsText}>No results for "{searchQuery.trim()}"</Text>
            </View>
          ) : (
            <EmptyState />
          )
        }
        renderItem={({ item }) => (
          <DocumentCard
            document={item}
            onPress={() => handleCardPress(item)}
            onLongPress={() => handleCardLongPress(item)}
            isSelected={selectedIds.has(item.id)}
            isMultiSelectMode={isMultiSelectMode}
          />
        )}
      />

      {/* Multi-select action bar */}
      {isMultiSelectMode && (
        <View style={[styles.multiBar, { paddingBottom: insets.bottom + 12 }]}>
          <Pressable style={styles.cancelBtn} onPress={() => setSelectedIds(new Set())}>
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.deleteBtn} onPress={handleBatchDelete}>
            <Text style={styles.deleteBtnText}>
              Delete ({selectedIds.size})
            </Text>
          </Pressable>
        </View>
      )}

      {/* FAB — hidden in multi-select */}
      {!isMultiSelectMode && (
        <Pressable
          style={[styles.fab, { bottom: insets.bottom + 24 }]}
          onPress={handleScan}
        >
          <Text style={styles.fabIcon}>+</Text>
        </Pressable>
      )}

      <ScanNameSheet
        visible={nameSheetVisible}
        pageCount={pendingPages.length}
        onSave={handleSave}
        onRetake={handleRetake}
        onClose={() => { setNameSheetVisible(false); setPendingPages([]); }}
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
        onRename={doc => setRenameTarget(doc)}
        onDuplicate={handleDuplicate}
        onMerge={doc => setMergeTarget(doc)}
        onSelect={handleSelect}
        onDelete={handleDelete}
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
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 8,
  },
  title: { fontSize: 30, fontWeight: '800', color: '#1a1a1a', letterSpacing: -0.5 },
  sortBtn: { fontSize: 14, color: '#0a7ea4', fontWeight: '600' },
  searchRow: { paddingHorizontal: 14, paddingBottom: 10 },
  searchInput: {
    backgroundColor: '#ebebeb',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 9,
    fontSize: 15,
    color: '#1a1a1a',
  },
  gridContent: { padding: 10, paddingBottom: 120 },
  emptyContent: { flex: 1 },
  noResults: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  noResultsText: { fontSize: 16, color: '#888' },
  multiBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#fff',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 14,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: -4 },
    elevation: 8,
  },
  cancelBtn: {
    flex: 1,
    backgroundColor: '#f0f0f0',
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
  },
  cancelBtnText: { fontSize: 16, fontWeight: '600', color: '#1a1a1a' },
  deleteBtn: {
    flex: 1,
    backgroundColor: '#fff0f0',
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#ffc5c5',
  },
  deleteBtnText: { fontSize: 16, fontWeight: '600', color: '#cc0000' },
  fab: {
    position: 'absolute',
    alignSelf: 'center',
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#0a7ea4',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0a7ea4',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  fabIcon: { fontSize: 34, color: '#fff', lineHeight: 40, marginTop: -2 },
});
