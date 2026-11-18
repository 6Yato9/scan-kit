// app/(tabs)/files.tsx
// Files: every document, in folders, with search, sort, import and multi-select.
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
  useWindowDimensions,
} from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Document } from '@/types/document';
import {
  getDocuments,
  deleteFolder,
  getSortPreference,
  saveSortPreference,
  getFolders,
  patchDocument,
  renameFolder,
  saveFolder,
  restoreDocuments,
  trashDocuments,
  SortKey,
} from '@/lib/storage';
import { mergeIntoNew } from '@/lib/doc-ops';
import { matchesQuery, searchSnippet, sortDocuments } from '@/lib/doc-list';
import { useScan } from '@/contexts/scan-context';
import { useTheme } from '@/contexts/theme-context';
import { notifySuccess, selection } from '@/lib/haptics';
import { BottomSheet, SheetGroup, SheetHeader, SheetRow } from '@/components/bottom-sheet';
import { DocumentCard, DocumentCardSkeleton, DocumentRow, DocumentRowSkeleton } from '@/components/document-card';
import { FilesLayout, getFilesLayout, saveFilesLayout } from '@/lib/view-pref';
import { EmptyState } from '@/components/empty-state';
import { SortSheet } from '@/components/sort-sheet';
import { MoveFolderSheet } from '@/components/move-folder-sheet';
import { HeaderIconButton, HeaderTextButton, LargeTitle } from '@/components/screen-header';
import { PrimaryButton } from '@/components/primary-button';
import { SearchField } from '@/components/search-field';
import { useDocumentActions } from '@/components/document-actions';
import { useToast } from '@/components/toast';
import { useImportDocuments } from '@/components/use-import';
import { MultiShareSheet } from '@/components/multi-share-sheet';
import { ExportSheet } from '@/components/export-sheet';
import { Radius, Spacing, Type } from '@/lib/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

function countLabel(n: number): string {
  return n === 0 ? 'Empty' : `${n} document${n === 1 ? '' : 's'}`;
}
type FolderPrompt = { mode: 'create' } | { mode: 'rename'; folder: string };

/**
 * Grid columns: three on phones, so a screen shows two full rows of documents
 * instead of one and a half; more on wider screens (iPad, landscape).
 */
function gridColumns(width: number): number {
  return Math.max(3, Math.min(6, Math.floor(width / 130)));
}

export default function FilesScreen() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('dateAdded');
  const [sortSheetVisible, setSortSheetVisible] = useState(false);
  const [addSheetVisible, setAddSheetVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [bulkMoveVisible, setBulkMoveVisible] = useState(false);
  const [shareVisible, setShareVisible] = useState(false);
  // Frozen when Share opens, so the sheet keeps its documents while it closes.
  const [shareDocs, setShareDocs] = useState<Document[]>([]);
  const [folderActions, setFolderActions] = useState<string | null>(null);
  const [folderPrompt, setFolderPrompt] = useState<FolderPrompt | null>(null);
  const [folderName, setFolderNameState] = useState('');
  const folderNameRef = useRef('');
  const setFolderName = useCallback((v: string) => { folderNameRef.current = v; setFolderNameState(v); }, []);
  const pendingAfterSheet = useRef<(() => void) | null>(null);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ action?: string; folder?: string }>();
  const [layout, setLayout] = useState<FilesLayout>('grid');
  useEffect(() => { getFilesLayout().then(setLayout); }, []);
  const toggleLayout = useCallback(() => {
    setLayout(prev => {
      const next = prev === 'grid' ? 'list' : 'grid';
      saveFilesLayout(next);
      return next;
    });
  }, []);
  const { lastSaved } = useScan();
  const { colors } = useTheme();
  const toast = useToast();
  const { width: screenW } = useWindowDimensions();
  const columns = gridColumns(screenW);

  const enterSelect = useCallback((doc?: Document) => {
    setSelecting(true);
    setSelectedIds(doc ? new Set([doc.id]) : new Set());
  }, []);
  const exitSelect = useCallback(() => {
    setSelecting(false);
    setSelectedIds(new Set());
  }, []);

  const actions = useDocumentActions({ documents, setDocuments, folders, setFolders, onSelect: enterSelect });

  // While selecting, the selection toolbar replaces the tab bar.
  const navigation = useNavigation();
  useEffect(() => {
    navigation.setOptions({ tabBarStyle: selecting ? { display: 'none' } : undefined });
  }, [navigation, selecting]);
  // Leaving the tab ends selection, so the tab bar is never left hidden.
  useFocusEffect(useCallback(() => () => exitSelect(), [exitSelect]));

  const load = useCallback(async () => {
    try {
      const [docs, sort, fldrs] = await Promise.all([getDocuments(), getSortPreference(), getFolders()]);
      setDocuments(docs);
      setSortKey(sort);
      setFolders(fldrs);
      // Keep the selection across tab switches, minus anything that vanished.
      const ids = new Set(docs.map(d => d.id));
      setSelectedIds(prev => new Set([...prev].filter(id => ids.has(id))));
    } finally {
      setLoaded(true);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { if (lastSaved > 0) load(); }, [lastSaved, load]);

  // A folder that was deleted or renamed elsewhere can't stay selected.
  // (Only once the folders have loaded: a folder opened from Home arrives first.)
  useEffect(() => {
    if (loaded && activeFolder !== null && !folders.includes(activeFolder)) setActiveFolder(null);
  }, [loaded, folders, activeFolder]);

  const q = searchQuery.trim();
  const displayedDocuments = useMemo(() => {
    let filtered = q ? documents.filter(d => matchesQuery(d, q)) : documents;
    if (activeFolder !== null) filtered = filtered.filter(d => d.folder === activeFolder);
    return sortDocuments(filtered, sortKey);
  }, [documents, q, sortKey, activeFolder]);

  const selectedDocs = useMemo(
    () => documents.filter(d => selectedIds.has(d.id)),
    [documents, selectedIds],
  );

  // ── Import ────────────────────────────────────────────────────────────────

  const { importImages: handleImportImages, importFile: handleImportFiles } = useImportDocuments();

  // Handle URL params from Tools / Home shortcuts. Clear the param after firing
  // so it doesn't re-trigger every time the tab regains focus.
  useEffect(() => {
    if (!params.action) return;
    const action = params.action;
    router.setParams({ action: undefined } as any);
    if (action === 'importImages') handleImportImages();
    else if (action === 'importFiles') handleImportFiles();
  }, [params.action, router, handleImportImages, handleImportFiles]);

  // Home's folder shortcuts open Files filtered to that folder.
  useEffect(() => {
    if (params.folder === undefined) return;
    const folder = params.folder;
    router.setParams({ folder: undefined } as any);
    setSearchQuery('');
    setActiveFolder(folder || null);
  }, [params.folder, router]);

  /** Close a sheet, then run `fn` once it is fully gone (native pickers need that). */
  const afterAddSheet = (fn: () => void) => () => {
    pendingAfterSheet.current = fn;
    setAddSheetVisible(false);
  };

  // ── Folders ───────────────────────────────────────────────────────────────

  const openFolderPrompt = useCallback((p: FolderPrompt) => {
    setFolderName(p.mode === 'rename' ? p.folder : '');
    setFolderPrompt(p);
  }, [setFolderName]);

  const submitFolderPrompt = useCallback(async () => {
    // Read the ref: a Return key press can arrive before the last keystroke's
    // re-render, and the state captured here would miss that character.
    const name = folderNameRef.current.trim();
    if (!name || !folderPrompt) return;
    try {
      if (folderPrompt.mode === 'create') {
        await saveFolder(name);
        setFolders(await getFolders());
        setActiveFolder(name);
      } else {
        await renameFolder(folderPrompt.folder, name);
        setFolders(await getFolders());
        if (activeFolder === folderPrompt.folder) setActiveFolder(name);
        setDocuments(prev => prev.map(d => (d.folder === folderPrompt.folder ? { ...d, folder: name } : d)));
      }
      setFolderPrompt(null);
    } catch (err) {
      console.error('Folder update failed', err);
      Alert.alert(folderPrompt.mode === 'create' ? "Couldn't create folder" : "Couldn't rename folder", 'Please try again.');
    }
  }, [folderPrompt, activeFolder]);

  const confirmDeleteFolder = useCallback((folder: string) => {
    const count = documents.filter(d => d.folder === folder).length;
    Alert.alert(
      `Delete “${folder}”?`,
      count > 0
        ? `The ${count} document${count === 1 ? '' : 's'} in it will be kept and moved out of the folder.`
        : 'This folder is empty.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete folder',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteFolder(folder);
              if (activeFolder === folder) setActiveFolder(null);
              setDocuments(prev => prev.map(d => (d.folder === folder ? { ...d, folder: undefined } : d)));
              setFolders(await getFolders());
              toast.show('Folder deleted');
            } catch (err) {
              console.error('Delete folder failed', err);
              Alert.alert("Couldn't delete folder", 'Please try again.');
            }
          },
        },
      ],
    );
  }, [documents, activeFolder, toast]);

  // ── Selection ─────────────────────────────────────────────────────────────

  const toggleSelected = useCallback((doc: Document) => {
    selection();
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(doc.id)) next.delete(doc.id);
      else next.add(doc.id);
      return next;
    });
  }, []);

  const handleCardPress = useCallback((doc: Document) => {
    if (selecting) toggleSelected(doc);
    else router.push({ pathname: '/viewer', params: { id: doc.id } });
  }, [selecting, toggleSelected, router]);

  const handleCardLongPress = useCallback((doc: Document) => {
    if (selecting) toggleSelected(doc);
    else actions.openActions(doc);
  }, [selecting, toggleSelected, actions]);

  const allShownSelected = displayedDocuments.length > 0 && displayedDocuments.every(d => selectedIds.has(d.id));

  const handleSort = useCallback(async (key: SortKey) => {
    setSortKey(key);
    await saveSortPreference(key);
  }, []);

  const handleBatchDelete = useCallback(() => {
    const n = selectedIds.size;
    if (n === 0) return;
    const plural = n !== 1;
    Alert.alert(
      `Delete ${n} document${plural ? 's' : ''}?`,
      `${plural ? 'They move' : 'It moves'} to Recently deleted, where you can restore ${plural ? 'them' : 'it'} for 30 days.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const ids = Array.from(selectedIds);
              const idSet = new Set(ids);
              // Soft delete: records and files stay until Recently deleted is emptied.
              await trashDocuments(ids);
              setDocuments(prev => prev.filter(d => !idSet.has(d.id)));
              exitSelect();
              notifySuccess();
              toast.show(plural ? `${n} documents moved to Recently deleted` : 'Moved to Recently deleted', {
                action: {
                  label: 'Undo',
                  onPress: () => {
                    restoreDocuments(ids)
                      .then(() => load())
                      .catch(err => {
                        console.error('Restore failed', err);
                        Alert.alert("Couldn't restore the documents", 'Find them in Settings, Recently deleted.');
                      });
                  },
                },
              });
            } catch (err) {
              console.error('Batch delete failed', err);
              Alert.alert("Couldn't delete the documents", 'Try again.');
            }
          },
        },
      ],
    );
  }, [selectedIds, exitSelect, toast, load]);

  const handleBatchShare = useCallback(() => {
    if (selectedDocs.length === 0) return;
    setShareDocs(selectedDocs);
    setShareVisible(true);
  }, [selectedDocs]);

  const handleBatchMove = useCallback(async (docs: Document[], folder: string | null) => {
    setBulkMoveVisible(false);
    try {
      const updatedAt = Date.now();
      await Promise.all(docs.map(d => patchDocument(d.id, { folder: folder ?? undefined, updatedAt })));
      const ids = new Set(docs.map(d => d.id));
      setDocuments(prev => prev.map(d => (ids.has(d.id) ? { ...d, folder: folder ?? undefined, updatedAt } : d)));
      exitSelect();
      toast.show(folder ? `Moved to “${folder}”` : 'Removed from folder');
    } catch (err) {
      console.error('Batch move failed', err);
      Alert.alert("Couldn't move documents", 'Please try again.');
    }
  }, [exitSelect, toast]);

  const mergeable = selectedDocs.filter(d => !d.pdfUri && d.pages.length > 0);
  const canMerge = selectedDocs.length >= 2 && mergeable.length === selectedDocs.length;

  const handleBatchMerge = useCallback(async () => {
    if (!canMerge) {
      Alert.alert('Choose two or more scans', 'Imported PDFs can’t be merged. Select at least two scanned documents.');
      return;
    }
    // Oldest first reads naturally as one document.
    const ordered = [...mergeable].sort((a, b) => a.createdAt - b.createdAt);
    try {
      const merged = await mergeIntoNew(ordered, `Merged ${ordered[0].name}`);
      setDocuments(prev => [merged, ...prev]);
      exitSelect();
      notifySuccess();
      toast.show(`Merged ${ordered.length} documents`);
    } catch (err) {
      console.error('Batch merge failed', err);
      Alert.alert("Couldn't merge documents", 'There may not be enough free space. Please try again.');
    }
  }, [canMerge, mergeable, exitSelect, toast]);

  const createFolderFromMove = useCallback(async (name: string) => {
    await saveFolder(name);
    setFolders(await getFolders());
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  const tabBarClearance = insets.bottom + 8 + 64;
  const empty = loaded && displayedDocuments.length === 0;
  const selCount = selectedIds.size;

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.bg }]}>
      {selecting ? (
        <LargeTitle
          title={selCount === 0 ? 'Select' : `${selCount} selected`}
          right={
            <>
              <HeaderTextButton
                title={allShownSelected ? 'Deselect all' : 'Select all'}
                onPress={() => setSelectedIds(allShownSelected ? new Set() : new Set(displayedDocuments.map(d => d.id)))}
              />
              <HeaderTextButton title="Done" emphasis onPress={exitSelect} />
            </>
          }
        />
      ) : (
        <LargeTitle
          title="Files"
          right={
            <>
              <HeaderIconButton icon="checkmark-circle-outline" label="Select documents" color={colors.accent} size={23} onPress={() => enterSelect()} disabled={documents.length === 0} />
              <HeaderIconButton
                icon={layout === 'grid' ? 'list-outline' : 'grid-outline'}
                label={layout === 'grid' ? 'Show as list' : 'Show as grid'}
                color={colors.accent}
                size={22}
                onPress={toggleLayout}
              />
              <HeaderIconButton icon="swap-vertical-outline" label="Sort documents" color={colors.accent} size={22} onPress={() => setSortSheetVisible(true)} />
              <HeaderIconButton icon="add" label="Add documents or a folder" color={colors.accent} size={28} onPress={() => setAddSheetVisible(true)} />
            </>
          }
        />
      )}

      <View style={styles.searchRow}>
        <SearchField value={searchQuery} onChangeText={setSearchQuery} />
      </View>

      {/* Folder chips. Long-press a folder to rename or delete it. */}
      {folders.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chipsScroll}
          contentContainerStyle={styles.chips}
        >
          <FolderChip label="All" icon="albums-outline" active={activeFolder === null} onPress={() => setActiveFolder(null)} />
          {folders.map(f => (
            <FolderChip
              key={f}
              label={f}
              icon={activeFolder === f ? 'folder-open' : 'folder-outline'}
              active={activeFolder === f}
              onPress={() => setActiveFolder(activeFolder === f ? null : f)}
              onLongPress={() => setFolderActions(f)}
            />
          ))}
        </ScrollView>
      )}

      {!loaded ? (
        layout === 'list' ? (
          <View style={styles.listContent}>
            {[0, 1, 2, 3].map(r => <DocumentRowSkeleton key={r} />)}
          </View>
        ) : (
          <View style={styles.gridContent}>
            {[0, 1].map(r => (
              <View key={r} style={styles.skeletonRow}>
                {Array.from({ length: columns }, (_, c) => <DocumentCardSkeleton key={c} columns={columns} />)}
              </View>
            ))}
          </View>
        )
      ) : empty ? (
        <View style={[styles.flex, { paddingBottom: tabBarClearance }]}>{q ? (
          <EmptyState variant="no-search-results" query={searchQuery.trim()} />
        ) : activeFolder !== null ? (
          <EmptyState variant="empty-folder" folderName={activeFolder} />
        ) : (
          <EmptyState
            variant="no-docs"
            subtitle="Import photos or PDFs, or scan a document with the camera button."
            actionLabel="Import from Photos"
            actionIcon="images-outline"
            onAction={handleImportImages}
            secondaryLabel="Import a file"
            onSecondaryAction={handleImportFiles}
          />
        )}</View>
      ) : (
        <FlatList
          // numColumns can't change on a mounted list.
          key={layout === 'grid' ? `grid-${columns}` : 'list'}
          data={displayedDocuments}
          keyExtractor={d => d.id}
          numColumns={layout === 'grid' ? columns : 1}
          style={styles.list}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          // Clear the floating tab bar, and the selection bar when it's up.
          contentContainerStyle={[
            layout === 'grid' ? styles.gridContent : styles.listContent,
            { paddingBottom: tabBarClearance + 40 },
          ]}
          renderItem={({ item }) =>
            layout === 'grid' ? (
              <DocumentCard
                document={item}
                columns={columns}
                snippet={q ? searchSnippet(item, q) : undefined}
                snippetQuery={q || undefined}
                onPress={() => handleCardPress(item)}
                onLongPress={() => handleCardLongPress(item)}
                isSelected={selectedIds.has(item.id)}
                isMultiSelectMode={selecting}
              />
            ) : (
              <DocumentRow
                document={item}
                snippet={q ? searchSnippet(item, q) : undefined}
                snippetQuery={q || undefined}
                onPress={() => handleCardPress(item)}
                onLongPress={() => handleCardLongPress(item)}
                isSelected={selectedIds.has(item.id)}
                isMultiSelectMode={selecting}
              />
            )
          }
        />
      )}

      {selecting && (
        <View
          style={[
            styles.multiBar,
            { bottom: insets.bottom + 8, backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <BarButton icon="share-outline" label="Share" disabled={selCount === 0} onPress={handleBatchShare} />
          <BarButton icon="folder-outline" label="Move" disabled={selCount === 0} onPress={() => setBulkMoveVisible(true)} />
          <BarButton icon="git-merge-outline" label="Merge" disabled={selCount < 2} onPress={handleBatchMerge} />
          <BarButton icon="trash-outline" label="Delete" destructive disabled={selCount === 0} onPress={handleBatchDelete} />
        </View>
      )}

      <SortSheet
        visible={sortSheetVisible}
        current={sortKey}
        onSort={handleSort}
        onClose={() => setSortSheetVisible(false)}
      />

      {/* Add: import or create a folder. Pickers open after the sheet is gone. */}
      <BottomSheet
        visible={addSheetVisible}
        onClose={() => { pendingAfterSheet.current = null; setAddSheetVisible(false); }}
        variant="grouped"
        onDismissed={() => {
          const fn = pendingAfterSheet.current;
          pendingAfterSheet.current = null;
          fn?.();
        }}
      >
        <SheetHeader title="Add to Files" />
        <SheetGroup>
          <SheetRow icon="images-outline" label="Import from Photos" detail="One or more photos become one document" onPress={afterAddSheet(handleImportImages)} />
          <SheetRow icon="folder-open-outline" label="Import a file" detail="A PDF or an image from Files" onPress={afterAddSheet(handleImportFiles)} last />
        </SheetGroup>
        <SheetGroup style={{ marginBottom: 0 }}>
          <SheetRow icon="folder-outline" label="New folder" onPress={afterAddSheet(() => openFolderPrompt({ mode: 'create' }))} last />
        </SheetGroup>
      </BottomSheet>

      {/* Folder actions (long-press a chip). */}
      <BottomSheet
        visible={folderActions !== null}
        onClose={() => { pendingAfterSheet.current = null; setFolderActions(null); }}
        variant="grouped"
        onDismissed={() => {
          const fn = pendingAfterSheet.current;
          pendingAfterSheet.current = null;
          fn?.();
        }}
      >
        <SheetHeader
          title={folderActions ?? ''}
          subtitle={folderActions ? countLabel(documents.filter(d => d.folder === folderActions).length) : undefined}
        />
        <SheetGroup>
          <SheetRow
            icon="pencil-outline"
            label="Rename folder"
            onPress={() => {
              const f = folderActions;
              pendingAfterSheet.current = () => f && openFolderPrompt({ mode: 'rename', folder: f });
              setFolderActions(null);
            }}
            last
          />
        </SheetGroup>
        <SheetGroup style={{ marginBottom: 0 }}>
          <SheetRow
            icon="trash-outline"
            label="Delete folder"
            destructive
            onPress={() => {
              const f = folderActions;
              pendingAfterSheet.current = () => f && confirmDeleteFolder(f);
              setFolderActions(null);
            }}
            last
          />
        </SheetGroup>
      </BottomSheet>

      {/* New / rename folder. */}
      <BottomSheet visible={folderPrompt !== null} onClose={() => setFolderPrompt(null)}>
        <SheetHeader title={folderPrompt?.mode === 'rename' ? 'Rename folder' : 'New folder'} />
        <TextInput
          autoFocus
          style={[Type.body, styles.sheetInput, { color: colors.text, backgroundColor: colors.input }]}
          value={folderName}
          onChangeText={setFolderName}
          placeholder="Folder name"
          placeholderTextColor={colors.muted}
          selectTextOnFocus
          returnKeyType="done"
          onSubmitEditing={submitFolderPrompt}
          accessibilityLabel="Folder name"
        />
        <View style={styles.sheetRow}>
          <PrimaryButton title="Cancel" variant="secondary" onPress={() => setFolderPrompt(null)} style={styles.flex} />
          <PrimaryButton
            title={folderPrompt?.mode === 'rename' ? 'Save' : 'Create'}
            onPress={submitFolderPrompt}
            disabled={!folderName.trim()}
            style={styles.flex}
          />
        </View>
      </BottomSheet>

      <MoveFolderSheet
        visible={bulkMoveVisible}
        document={null}
        documents={selectedDocs}
        folders={folders}
        onMove={() => {}}
        onMoveMany={handleBatchMove}
        onCreateFolder={createFolderFromMove}
        onClose={() => setBulkMoveVisible(false)}
      />

      {/* One document: the full export sheet. Several: one PDF or separate PDFs. */}
      {shareDocs.length === 1 ? (
        <ExportSheet visible={shareVisible} document={shareDocs[0]} onClose={() => setShareVisible(false)} />
      ) : (
        <MultiShareSheet visible={shareVisible} documents={shareDocs} onClose={() => setShareVisible(false)} />
      )}

      {actions.sheets}
    </View>
  );
}

function FolderChip({
  label,
  icon,
  active,
  onPress,
  onLongPress,
}: {
  label: string;
  icon: IconName;
  active: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={{ top: 4, bottom: 4 }}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label === 'All' ? 'All documents' : `Folder ${label}`}
      accessibilityHint={onLongPress ? 'Long-press to rename or delete' : undefined}
      style={({ pressed }) => [
        styles.chip,
        { backgroundColor: active ? colors.accentFill : colors.card, borderColor: active ? colors.accentFill : colors.border },
        pressed && { opacity: 0.7 },
      ]}
    >
      <Ionicons name={icon} size={16} color={active ? colors.onAccent : colors.muted} />
      <Text style={[Type.subhead, { color: active ? colors.onAccent : colors.text }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

function BarButton({
  icon,
  label,
  onPress,
  disabled,
  destructive,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  const { colors } = useTheme();
  const color = destructive ? colors.danger : colors.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [styles.barBtn, (pressed || disabled) && { opacity: disabled ? 0.35 : 0.6 }]}
    >
      <Ionicons name={icon} size={22} color={color} />
      <Text style={[Type.caption, { color, fontWeight: '600' }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  searchRow: { paddingHorizontal: Spacing.gutter, paddingBottom: Spacing.md },
  chipsScroll: { flexGrow: 0, flexShrink: 0 },
  chips: { paddingHorizontal: Spacing.gutter, paddingTop: Spacing.xs, paddingBottom: Spacing.sm, gap: Spacing.sm, flexDirection: 'row' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 36,
    paddingHorizontal: Spacing.md + 2,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  list: { flex: 1 },
  gridContent: { paddingHorizontal: Spacing.gutter - 4, paddingTop: Spacing.xs },
  listContent: { paddingHorizontal: Spacing.gutter, paddingTop: Spacing.xs },
  skeletonRow: { flexDirection: 'row' },
  multiBar: {
    position: 'absolute',
    left: Spacing.gutter,
    right: Spacing.gutter,
    height: 64,
    borderRadius: 32,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  barBtn: { flex: 1, height: 64, alignItems: 'center', justifyContent: 'center', gap: 2 },
  sheetInput: { borderRadius: Radius.md, paddingHorizontal: Spacing.lg, minHeight: 50, marginBottom: Spacing.lg },
  sheetRow: { flexDirection: 'row', gap: Spacing.md },
  flex: { flex: 1 },
});
