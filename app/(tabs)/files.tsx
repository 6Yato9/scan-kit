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
} from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Document } from '@/types/document';
import {
  getDocuments,
  deleteDocuments,
  deleteFolder,
  getSortPreference,
  saveSortPreference,
  getFolders,
  patchDocument,
  renameFolder,
  saveFolder,
  getScanSettings,
  SortKey,
} from '@/lib/storage';
import { deleteDocumentFiles } from '@/lib/files';
import { mergeIntoNew } from '@/lib/doc-ops';
import { matchesQuery, sortDocuments } from '@/lib/doc-list';
import { useScan } from '@/contexts/scan-context';
import { useTheme } from '@/contexts/theme-context';
import { notifySuccess, selection } from '@/lib/haptics';
import { BottomSheet, SheetGroup, SheetHeader, SheetRow } from '@/components/bottom-sheet';
import { DocumentCard, DocumentCardSkeleton } from '@/components/document-card';
import { EmptyState } from '@/components/empty-state';
import { SortSheet } from '@/components/sort-sheet';
import { MoveFolderSheet } from '@/components/move-folder-sheet';
import { HeaderIconButton, HeaderTextButton } from '@/components/screen-header';
import { PrimaryButton } from '@/components/primary-button';
import { SearchField } from '@/components/search-field';
import { useDocumentActions } from '@/components/document-actions';
import { useToast } from '@/components/toast';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

function countLabel(n: number): string {
  return n === 0 ? 'Empty' : `${n} document${n === 1 ? '' : 's'}`;
}
type FolderPrompt = { mode: 'create' } | { mode: 'rename'; folder: string };

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
  const [folderActions, setFolderActions] = useState<string | null>(null);
  const [folderPrompt, setFolderPrompt] = useState<FolderPrompt | null>(null);
  const [folderName, setFolderNameState] = useState('');
  const folderNameRef = useRef('');
  const setFolderName = useCallback((v: string) => { folderNameRef.current = v; setFolderNameState(v); }, []);
  const pendingAfterSheet = useRef<(() => void) | null>(null);
  const importing = useRef(false);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ action?: string }>();
  const { lastSaved, saveAndOpen } = useScan();
  const { colors } = useTheme();
  const toast = useToast();

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
  useEffect(() => {
    if (activeFolder !== null && !folders.includes(activeFolder)) setActiveFolder(null);
  }, [folders, activeFolder]);

  const q = searchQuery.trim().toLowerCase();
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

  const handleImportImages = useCallback(async () => {
    if (importing.current) return;
    importing.current = true;
    try {
      // Honor the user's Scan Quality preference when importing from the library.
      const settings = await getScanSettings();
      const qualityMap = { low: 0.5, medium: 0.75, high: 0.9 };
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        orderedSelection: true,
        quality: qualityMap[settings.quality],
      });
      if (result.canceled || !result.assets.length) return;
      const id = await saveAndOpen({ pages: result.assets.map(a => a.uri) });
      if (id) router.push({ pathname: '/viewer', params: { id } });
    } catch (err) {
      console.error('Import images failed', err);
      Alert.alert("Couldn't import photos", 'Check that Scan Kit can access your photos, then try again.');
    } finally {
      importing.current = false;
    }
  }, [saveAndOpen, router]);

  const handleImportFiles = useCallback(async () => {
    if (importing.current) return;
    importing.current = true;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/*'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets.length) return;
      const asset = result.assets[0];
      const id = asset.mimeType === 'application/pdf'
        ? await saveAndOpen({ pdfUri: asset.uri })
        : await saveAndOpen({ pages: [asset.uri] });
      if (id) router.push({ pathname: '/viewer', params: { id } });
    } catch (err) {
      console.error('Import files failed', err);
      Alert.alert("Couldn't import file", 'Choose a PDF or an image and try again.');
    } finally {
      importing.current = false;
    }
  }, [saveAndOpen, router]);

  // Handle URL params from Tools / Home shortcuts. Clear the param after firing
  // so it doesn't re-trigger every time the tab regains focus.
  useEffect(() => {
    if (!params.action) return;
    const action = params.action;
    router.setParams({ action: undefined } as any);
    if (action === 'importImages') handleImportImages();
    else if (action === 'importFiles') handleImportFiles();
  }, [params.action, router, handleImportImages, handleImportFiles]);

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
    Alert.alert(
      `Delete ${n} document${n !== 1 ? 's' : ''}?`,
      'This can’t be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const ids = Array.from(selectedIds);
              const idSet = new Set(ids);
              await deleteDocuments(ids);
              ids.forEach(id => { try { deleteDocumentFiles(id); } catch {} });
              setDocuments(prev => prev.filter(d => !idSet.has(d.id)));
              exitSelect();
              notifySuccess();
              toast.show(`${n} document${n !== 1 ? 's' : ''} deleted`);
            } catch (err) {
              console.error('Batch delete failed', err);
              Alert.alert("Couldn't delete documents", 'Please try again.');
            }
          },
        },
      ],
    );
  }, [selectedIds, exitSelect, toast]);

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
      <View style={styles.header}>
        {selecting ? (
          <>
            <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header" numberOfLines={1}>
              {selCount === 0 ? 'Select' : `${selCount} selected`}
            </Text>
            <View style={styles.headerActions}>
              <HeaderTextButton
                title={allShownSelected ? 'Deselect all' : 'Select all'}
                onPress={() => setSelectedIds(allShownSelected ? new Set() : new Set(displayedDocuments.map(d => d.id)))}
              />
              <HeaderTextButton title="Done" emphasis onPress={exitSelect} />
            </View>
          </>
        ) : (
          <>
            <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">Files</Text>
            <View style={styles.headerActions}>
              <HeaderIconButton icon="checkmark-circle-outline" label="Select documents" color={colors.accent} size={23} onPress={() => enterSelect()} disabled={documents.length === 0} />
              <HeaderIconButton icon="swap-vertical" label="Sort documents" color={colors.accent} size={22} onPress={() => setSortSheetVisible(true)} />
              <HeaderIconButton icon="add" label="Add documents or a folder" color={colors.accent} size={28} onPress={() => setAddSheetVisible(true)} />
            </View>
          </>
        )}
      </View>

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
        <View style={styles.gridContent}>
          {[0, 1].map(r => (
            <View key={r} style={styles.skeletonRow}>
              <DocumentCardSkeleton />
              <DocumentCardSkeleton />
            </View>
          ))}
        </View>
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
          data={displayedDocuments}
          keyExtractor={d => d.id}
          numColumns={2}
          style={styles.list}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          // Clear the floating tab bar, and the selection bar when it's up.
          contentContainerStyle={[styles.gridContent, { paddingBottom: tabBarClearance + 40 }]}
          renderItem={({ item }) => (
            <DocumentCard
              document={item}
              onPress={() => handleCardPress(item)}
              onLongPress={() => handleCardLongPress(item)}
              isSelected={selectedIds.has(item.id)}
              isMultiSelectMode={selecting}
            />
          )}
        />
      )}

      {selecting && (
        <View
          style={[
            styles.multiBar,
            { bottom: insets.bottom + 8, backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
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
          <SheetRow icon="document-attach-outline" label="Import a file" detail="A PDF or an image from Files" onPress={afterAddSheet(handleImportFiles)} last />
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 20,
    paddingRight: Spacing.sm,
    paddingTop: 14,
    paddingBottom: Spacing.sm,
    minHeight: 14 + HIT + Spacing.sm,
  },
  title: { fontSize: 30, fontWeight: '800', letterSpacing: -0.5, flexShrink: 1 },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
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
  gridContent: { paddingHorizontal: Spacing.gutter - 6, paddingTop: Spacing.xs },
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
