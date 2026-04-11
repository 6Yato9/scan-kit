// app/(tabs)/files.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet } from '@/components/bottom-sheet';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Crypto from 'expo-crypto';
import { Document, PageFilter } from '@/types/document';
import {
  getDocuments,
  saveDocument,
  updateDocument,
  deleteDocument,
  deleteDocuments,
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
import { useTheme } from '@/contexts/theme-context';
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
  const [newFolderVisible, setNewFolderVisible] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const newFolderInputRef = useRef<TextInput>(null);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ action?: string }>();
  const { lastSaved, openImport, openPdfImport } = useScan();
  const { colors } = useTheme();

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
  }, [params.action, handleImportImages, handleImportFiles]);

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
    setNewFolderName('');
    setNewFolderVisible(true);
    setTimeout(() => newFolderInputRef.current?.focus(), 400);
  }, []);

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim()) return;
    await saveFolder(newFolderName.trim());
    setFolders(await getFolders());
    setNewFolderVisible(false);
  }, [newFolderName]);

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
            await deleteDocuments(ids);
            ids.forEach(id => deleteDocumentFiles(id));
            setDocuments(prev => prev.filter(d => !ids.includes(d.id)));
            setSelectedIds(new Set());
          },
        },
      ]
    );
  }, [selectedIds]);

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.bg }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]}>Files</Text>
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

      {/* Quick action bar */}
      <View style={styles.actionBar}>
        <Pressable style={[styles.actionBtn, { backgroundColor: colors.card }]} onPress={handleImportImages}>
          <Ionicons name="images-outline" size={16} color={colors.accent} />
          <Text style={[styles.actionBtnText, { color: colors.text }]}>Import Images</Text>
        </Pressable>
        <Pressable style={[styles.actionBtn, { backgroundColor: colors.card }]} onPress={handleImportFiles}>
          <Ionicons name="cloud-download-outline" size={16} color={colors.accent} />
          <Text style={[styles.actionBtnText, { color: colors.text }]}>Import Files</Text>
        </Pressable>
        <Pressable style={[styles.actionBtn, { backgroundColor: colors.card }]} onPress={handleNewFolder}>
          <Ionicons name="folder-open-outline" size={16} color={colors.accent} />
          <Text style={[styles.actionBtnText, { color: colors.text }]}>New Folder</Text>
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
            style={[styles.chip, { backgroundColor: colors.input }, activeFolder === null && { borderColor: colors.accent, backgroundColor: colors.accentLight }]}
            onPress={() => setActiveFolder(null)}
          >
            <Text style={[styles.chipText, { color: colors.subtext }, activeFolder === null && { color: colors.accent, fontWeight: '700' }]}>All</Text>
          </Pressable>
          {folders.map(f => (
            <Pressable
              key={f}
              style={[styles.chip, { backgroundColor: colors.input }, activeFolder === f && { borderColor: colors.accent, backgroundColor: colors.accentLight }]}
              onPress={() => setActiveFolder(f)}
            >
              <Text style={[styles.chipText, { color: colors.subtext }, activeFolder === f && { color: colors.accent, fontWeight: '700' }]}>{f}</Text>
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
              <Text style={[styles.noResultsText, { color: colors.muted }]}>No results for "{searchQuery.trim()}"</Text>
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
        <View style={[styles.multiBar, { paddingBottom: insets.bottom + 12, backgroundColor: colors.card }]}>
          <Pressable style={[styles.cancelBtn, { backgroundColor: colors.secondary }]} onPress={() => setSelectedIds(new Set())}>
            <Text style={[styles.cancelBtnText, { color: colors.text }]}>Cancel</Text>
          </Pressable>
          <Pressable style={[styles.deleteBtn, { backgroundColor: colors.dangerBg, borderColor: colors.dangerBorder }]} onPress={handleBatchDelete}>
            <Text style={[styles.deleteBtnText, { color: colors.danger }]}>Delete ({selectedIds.size})</Text>
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

      <BottomSheet visible={newFolderVisible} onClose={() => setNewFolderVisible(false)}>
        <Text style={[styles.sheetHeading, { color: colors.text }]}>New Folder</Text>
        <TextInput
          ref={newFolderInputRef}
          style={[styles.sheetInput, { borderColor: colors.border, color: colors.text, backgroundColor: colors.input }]}
          value={newFolderName}
          onChangeText={setNewFolderName}
          placeholder="Folder name"
          placeholderTextColor={colors.faint}
          selectTextOnFocus
          returnKeyType="done"
          onSubmitEditing={handleCreateFolder}
        />
        <View style={styles.sheetRow}>
          <Pressable style={[styles.sheetCancelBtn, { backgroundColor: colors.secondary }]} onPress={() => setNewFolderVisible(false)}>
            <Text style={[styles.sheetCancelText, { color: colors.text }]}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.sheetCreateBtn, { backgroundColor: colors.accent }, !newFolderName.trim() && styles.sheetBtnDisabled]}
            onPress={handleCreateFolder}
          >
            <Text style={styles.sheetCreateText}>Create</Text>
          </Pressable>
        </View>
      </BottomSheet>
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
  searchRow: { paddingHorizontal: 14, paddingBottom: 6 },
  searchInput: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 9,
    fontSize: 15,
  },
  actionBar: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingBottom: 8,
    gap: 8,
  },
  actionBtn: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 9,
    alignItems: 'center',
    gap: 4,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  actionBtnText: { fontSize: 11, fontWeight: '600' },
  chipsScroll: { maxHeight: 40 },
  chips: { paddingHorizontal: 14, paddingBottom: 8, gap: 8, flexDirection: 'row' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  chipText: { fontSize: 13, fontWeight: '500' },
  gridContent: { padding: 10, paddingBottom: 120 },
  emptyContent: { flex: 1 },
  noResults: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  noResultsText: { fontSize: 16 },
  multiBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
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
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
  },
  cancelBtnText: { fontSize: 16, fontWeight: '600' },
  deleteBtn: {
    flex: 1,
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
    borderWidth: 1.5,
  },
  deleteBtnText: { fontSize: 16, fontWeight: '600' },
  sheetHeading: { fontSize: 17, fontWeight: '700', marginBottom: 14 },
  sheetInput: {
    borderWidth: 1.5,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 16,
    marginBottom: 18,
    minHeight: 52,
  },
  sheetRow: { flexDirection: 'row', gap: 12 },
  sheetCancelBtn: { flex: 1, borderRadius: 12, padding: 15, alignItems: 'center' },
  sheetCancelText: { fontSize: 16, fontWeight: '600' },
  sheetCreateBtn: { flex: 1, borderRadius: 12, padding: 15, alignItems: 'center' },
  sheetCreateText: { fontSize: 16, fontWeight: '700', color: '#fff' },
  sheetBtnDisabled: { opacity: 0.4 },
});
