// app/(tabs)/index.tsx
// Home: where you pick up or start work, not a second library. Two ways to
// bring documents in besides the tab bar's camera button (photos, or a PDF or
// image file), shortcuts into folders, and the documents worked on most
// recently as a list with their full names. Everything else has one home:
// browsing, sorting, selecting and searching the whole library are in Files
// (the search button here opens Files' search with the keyboard up), and scan
// modes such as ID card, Book and Whiteboard are in Tools.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState, FlatList, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Document } from '@/types/document';
import { getDocuments, getFolders, subscribeDocumentChanges } from '@/lib/storage';
import { requestFilesCopySync } from '@/lib/files-copy';
import { useScan } from '@/contexts/scan-context';
import { HeaderIconButton, LargeTitle } from '@/components/screen-header';
import { useTheme } from '@/contexts/theme-context';
import { EmptyState } from '@/components/empty-state';
import { DocumentRow, DocumentRowSkeleton } from '@/components/document-card';
import { SectionLabel } from '@/components/section-label';
import { useDocumentActions } from '@/components/document-actions';
import { useImportDocuments } from '@/components/use-import';
import { sortDocuments } from '@/lib/doc-list';
import { HIT, Radius, Spacing, TAB_BAR_CLEARANCE, Type } from '@/lib/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

const RECENT_LIMIT = 6;

/**
 * Folder card width when folders scroll (three or more): two whole cards and
 * about a third of the next, so the row visibly continues. Two or fewer fill
 * the row instead (flex), ending on the same edge as every card below.
 */
function folderCardWidth(screenW: number): number {
  const visible = screenW - Spacing.gutter; // the row bleeds off the right edge
  return Math.floor((visible - Spacing.sm * 2) / 2.35);
}

export default function HomeScreen() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { lastSaved } = useScan();
  const { colors } = useTheme();
  const { width: screenW } = useWindowDimensions();
  const actions = useDocumentActions({ documents, setDocuments, folders, setFolders });
  const { importImages, importFile } = useImportDocuments();

  const load = useCallback(async () => {
    try {
      const [docs, fldrs] = await Promise.all([getDocuments(), getFolders()]);
      setDocuments(docs);
      setFolders(fldrs);
    } finally {
      setLoaded(true);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { if (lastSaved > 0) load(); }, [lastSaved, load]);
  // Any change to the list (a save, a rename or delete made here, coming
  // back from the viewer) brings the copies in Files up to date.
  useEffect(() => { requestFilesCopySync(); }, [documents]);

  // Keep a copy in Files (lib/files-copy.ts) catches up after any change:
  // Home is the first tab, so it stays mounted for the app's whole life. The
  // pass is debounced and does nothing while the setting is off.
  useEffect(() => {
    const unsubscribe = subscribeDocumentChanges(() => requestFilesCopySync());
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active' || s === 'background') requestFilesCopySync(s === 'background' ? 0 : 2000);
    });
    return () => { unsubscribe(); sub.remove(); };
  }, []);

  // Recent means recently worked on, whatever the library's sort order is.
  const recent = useMemo(() => sortDocuments(documents, 'dateModified').slice(0, RECENT_LIMIT), [documents]);
  const capped = documents.length > RECENT_LIMIT;

  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of documents) if (d.folder) counts.set(d.folder, (counts.get(d.folder) ?? 0) + 1);
    return counts;
  }, [documents]);

  const openFolder = useCallback((folder: string) => {
    router.navigate({ pathname: '/files', params: { folder } });
  }, [router]);

  const noDocs = loaded && documents.length === 0;

  const quickActions = (
    <View style={styles.quickRow}>
      <QuickAction icon="images-outline" label="Import photos" detail="From your library" onPress={importImages} />
      <QuickAction icon="folder-open-outline" label="Import file" detail="PDF or image" onPress={importFile} />
    </View>
  );

  const folderCard = (f: string, fill: boolean) => {
    const n = folderCounts.get(f) ?? 0;
    return (
      <Pressable
        key={f}
        onPress={() => openFolder(f)}
        style={({ pressed }) => [
          styles.folder,
          fill ? styles.folderFill : { width: folderCardWidth(screenW) },
          { backgroundColor: colors.card },
          pressed && { opacity: 0.7 },
        ]}
        accessibilityRole="button"
        accessibilityLabel={`Folder ${f}, ${n} ${n === 1 ? 'document' : 'documents'}`}
      >
        <View style={[styles.quickIcon, { backgroundColor: colors.accentLight }]}>
          <Ionicons name="folder-outline" size={20} color={colors.accent} />
        </View>
        <View style={styles.folderText}>
          <Text style={[Type.subhead, { color: colors.text, fontWeight: '600' }]} numberOfLines={1}>{f}</Text>
          <Text style={[Type.caption, { color: colors.muted }]}>{n === 0 ? 'Empty' : `${n} ${n === 1 ? 'document' : 'documents'}`}</Text>
        </View>
      </Pressable>
    );
  };

  // Two or fewer fill the row edge to edge; more scroll, with the next card peeking in.
  const folderShortcuts = folders.length > 0 ? (
    <View>
      <SectionLabel style={styles.sectionLabel}>Folders</SectionLabel>
      {folders.length <= 2 ? (
        <View style={styles.folderGrid}>{folders.map(f => folderCard(f, true))}</View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.edgeScroll}
          contentContainerStyle={styles.folderRow}
        >
          {folders.map(f => folderCard(f, false))}
        </ScrollView>
      )}
    </View>
  ) : null;

  const header = (
    <View>
      {quickActions}
      {folderShortcuts}
      {recent.length > 0 && (
        <View style={styles.sectionRow}>
          <SectionLabel style={styles.sectionLabel}>Recent</SectionLabel>
          {/* Only when Recent is a slice of the library; otherwise every
              document is already listed here and the tab bar has Files. */}
          {capped ? (
            <Pressable
              onPress={() => router.navigate('/files')}
              hitSlop={10}
              style={styles.seeAll}
              accessibilityRole="button"
              accessibilityLabel={`See all ${documents.length} documents in Files`}
            >
              <Text style={[Type.subhead, { color: colors.accent }]}>See all</Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );


  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.bg }]}>
      <LargeTitle
        title="Home"
        right={
          <HeaderIconButton
            icon="search"
            label="Search documents"
            color={colors.accent}
            onPress={() => router.navigate({ pathname: '/files', params: { search: '1' } })}
          />
        }
      />

      {!loaded ? (
        <View style={styles.listContent}>
          {quickActions}
          <SectionLabel style={styles.sectionLabel}>Recent</SectionLabel>
          {[0, 1, 2].map(i => <DocumentRowSkeleton key={i} />)}
        </View>
      ) : (
        <FlatList
          data={recent}
          keyExtractor={d => d.id}
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }]}
          ListHeaderComponent={header}
          ListEmptyComponent={
            noDocs ? (
              <View style={styles.empty}>
                <EmptyState
                  variant="no-docs"
                  subtitle="Tap the camera button to scan, or import photos or a PDF. Your newest documents show up here."
                />
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <DocumentRow
              document={item}
              onPress={() => router.push({ pathname: '/viewer', params: { id: item.id } })}
              onLongPress={() => actions.openActions(item)}
            />
          )}
        />
      )}

      {actions.sheets}
    </View>
  );
}

function QuickAction({
  icon,
  label,
  detail,
  onPress,
}: {
  icon: IconName;
  label: string;
  detail: string;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.quick, { backgroundColor: colors.card }, pressed && { opacity: 0.75 }]}
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${detail}`}
    >
      <View style={[styles.quickIcon, { backgroundColor: colors.accentLight }]}>
        <Ionicons name={icon} size={20} color={colors.accent} />
      </View>
      <View style={styles.quickText}>
        <Text style={[Type.subhead, styles.quickLabel, { color: colors.text }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
          {label}
        </Text>
        <Text style={[Type.caption, { color: colors.muted }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
          {detail}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  listContent: { paddingHorizontal: Spacing.gutter, flexGrow: 1 },
  quickRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm },
  quick: {
    flex: 1,
    minHeight: 64,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md - 2,
  },
  quickIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  quickText: { flex: 1, minWidth: 0, gap: 1 },
  quickLabel: { fontWeight: '600' },
  sectionRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  sectionLabel: { marginTop: Spacing.xl },
  seeAll: { minHeight: HIT / 2, justifyContent: 'flex-end', marginBottom: Spacing.sm, marginRight: Spacing.xs },
  // Bleeds to the screen edges so folders scroll out from under the gutter.
  edgeScroll: { marginHorizontal: -Spacing.gutter },
  folderRow: { paddingHorizontal: Spacing.gutter, gap: Spacing.sm },
  folderGrid: { flexDirection: 'row', gap: Spacing.sm },
  folderFill: { flex: 1, minWidth: 0 },
  // Same card as the quick actions above: radius, height, tinted icon disc.
  folder: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md - 2,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.lg,
    minHeight: 64,
  },
  folderText: { flex: 1, minWidth: 0, gap: 1 },
  empty: { flex: 1, paddingTop: Spacing.xxl },
});
