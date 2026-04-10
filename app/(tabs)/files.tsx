// app/(tabs)/files.tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Crypto from 'expo-crypto';
import { Document, PageFilter } from '@/types/document';
import {
  getDocuments,
  saveDocument,
  updateDocument,
  deleteDocument,
  getSortPreference,
  saveSortPreference,
  getFolders,
  saveFolder,
  SortKey,
} from '@/lib/storage';
import {
  copyDocumentFiles,
  deleteDocumentFiles,
  appendPages,
  copyPdfToStorage,
} from '@/lib/files';
import { useScan } from '@/contexts/scan-context';
import { DocumentCard } from '@/components/document-card';
import { EmptyState } from '@/components/empty-state';
import { RenameSheet } from '@/components/rename-sheet';
import { SortSheet } from '@/components/sort-sheet';
import { DocActionsSheet } from '@/components/doc-actions-sheet';
import { MergeSheet } from '@/components/merge-sheet';
import { MoveFolderSheet } from '@/components/move-folder-sheet';

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

export default function FilesScreen() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('dateAdded');
  const [sortSheetVisible, setSortSheetVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [docActionsTarget, setDocActionsTarget] = useState<Document | null>(null);
  const [renameTarget, setRenameTarget] = useState<Document | null>(null);
  const [mergeTarget, setMergeTarget] = useState<Document | null>(null);
  const [moveFolderTarget, setMoveFolderTarget] = useState<Document | null>(null);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ action?: string }>();
  const { lastSaved, openImport, openPdfImport } = useScan();

  const load = useCallback(async () => {
    const [docs, sort, fldrs] = await Promise.all([
      getDocuments(),
      getSortPreference(),
      getFolders(),
    ]);
    setDocuments(docs);
    setSortKey(sort);
    setFolders(fldrs);
    setSelectedIds(new Set());
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { if (lastSaved > 0) load(); }, [lastSaved, load]);

  // Handle URL params from Tools tab shortcuts.
  useEffect(() => {
    if (params.action === 'importImages') handleImportImages();
    else if (params.action === 'importFiles') handleImportFiles();
  }, [params.action]);

  const displayedDocuments = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let filtered = q ? documents.filter(d => d.name.toLowerCase().includes(q)) : documents;
    if (activeFolder !== null) {
      filtered = filtered.filter(d => d.folder === activeFolder);
    }
    return sortDocuments(filtered, sortKey);
  }, [documents, searchQuery, sortKey, activeFolder]);

  const isMultiSelectMode = selectedIds.size > 0;

  const handleImportImages = useCallback(async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        quality: 1,
      });
      if (result.canceled || !result.assets.length) return;
      await openImport(result.assets.map(a => a.uri));
    } catch (err) {
      console.error('Import images failed', err);
      Alert.alert('Import Failed', 'Could not import images.');
    }
  }, [openImport]);

  const handleImportFiles = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/*'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets.length) return;
      const asset = result.assets[0];
      if (asset.mimeType === 'application/pdf') {
        await openPdfImport(asset.uri);
      } else {
        await openImport([asset.uri]);
      }
    } catch (err) {
      console.error('Import files failed', err);
      Alert.alert('Import Failed', 'Could not import file.');
    }
  }, [openImport, openPdfImport]);

  const handleNewFolder = useCallback(() => {
    if (Platform.OS === 'ios') {
      Alert.prompt(
        'New Folder',
        'Enter a name for the folder',
        async (name) => {
          if (!name?.trim()) return;
          await saveFolder(name.trim());
          setFolders(await getFolders());
        },
        'plain-text'
      );
    } else {
      Alert.alert('New Folder', 'Folder creation is available on iOS. Long-press a document and choose "Move to Folder" after creating a folder via settings.');
    }
  }, []);

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
    try {
      const newId = Crypto.randomUUID();
      const now = Date.now();
      if (doc.pdfUri) {
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

  const handleMoveToFolder = useCallback(async (doc: Document, folder: string | null) => {
    const updated: Document = { ...doc, folder: folder ?? undefined, updatedAt: Date.now() };
    await updateDocument(updated);
    setDocuments(prev => prev.map(d => (d.id === doc.id ? updated : d)));
    setMoveFolderTarget(null);
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
        <Text style={styles.title}>Files</Text>
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

      {/* Quick action bar */}
      <View style={styles.actionBar}>
        <Pressable style={styles.actionBtn} onPress={handleImportImages}>
          <Text style={styles.actionBtnText}>🖼 Import Images</Text>
        </Pressable>
        <Pressable style={styles.actionBtn} onPress={handleImportFiles}>
          <Text style={styles.actionBtnText}>📥 Import Files</Text>
        </Pressable>
        <Pressable style={styles.actionBtn} onPress={handleNewFolder}>
          <Text style={styles.actionBtnText}>📁 New Folder</Text>
        </Pressable>
      </View>

      {/* Folder chips */}
      {folders.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chipsScroll}
          contentContainerStyle={styles.chips}
        >
          <Pressable
            style={[styles.chip, activeFolder === null && styles.chipActive]}
            onPress={() => setActiveFolder(null)}
          >
            <Text style={[styles.chipText, activeFolder === null && styles.chipTextActive]}>All</Text>
          </Pressable>
          {folders.map(f => (
            <Pressable
              key={f}
              style={[styles.chip, activeFolder === f && styles.chipActive]}
              onPress={() => setActiveFolder(f)}
            >
              <Text style={[styles.chipText, activeFolder === f && styles.chipTextActive]}>{f}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

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

      {isMultiSelectMode && (
        <View style={[styles.multiBar, { paddingBottom: insets.bottom + 12 }]}>
          <Pressable style={styles.cancelBtn} onPress={() => setSelectedIds(new Set())}>
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.deleteBtn} onPress={handleBatchDelete}>
            <Text style={styles.deleteBtnText}>Delete ({selectedIds.size})</Text>
          </Pressable>
        </View>
      )}

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
        onSelect={doc => { setDocActionsTarget(null); setSelectedIds(new Set([doc.id])); }}
        onDelete={doc => { setDocActionsTarget(null); handleDelete(doc); }}
        onClose={() => setDocActionsTarget(null)}
        onMoveToFolder={doc => { setDocActionsTarget(null); setMoveFolderTarget(doc); }}
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

      <MoveFolderSheet
        visible={moveFolderTarget !== null}
        document={moveFolderTarget}
        folders={folders}
        onMove={handleMoveToFolder}
        onClose={() => setMoveFolderTarget(null)}
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
  searchRow: { paddingHorizontal: 14, paddingBottom: 6 },
  searchInput: {
    backgroundColor: '#ebebeb',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 9,
    fontSize: 15,
    color: '#1a1a1a',
  },
  actionBar: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingBottom: 8,
    gap: 8,
  },
  actionBtn: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingVertical: 9,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  actionBtnText: { fontSize: 12, fontWeight: '600', color: '#1a1a1a' },
  chipsScroll: { maxHeight: 40 },
  chips: { paddingHorizontal: 14, paddingBottom: 8, gap: 8, flexDirection: 'row' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#ebebeb',
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  chipActive: { borderColor: '#0a7ea4', backgroundColor: '#e8f5fa' },
  chipText: { fontSize: 13, color: '#555', fontWeight: '500' },
  chipTextActive: { color: '#0a7ea4', fontWeight: '700' },
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
});
