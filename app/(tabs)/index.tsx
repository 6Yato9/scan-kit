// app/(tabs)/index.tsx
// Home: a starting point, not a second library. Shortcuts (import, sign —
// scanning is the tab bar's camera button, so there's no second Scan card), the
// few most recent documents, and shortcuts into folders. The full library
// (every document, grid or list, sort, select, folders) lives in Files.
// Searching here covers everything, including text inside documents, and a
// text match shows the line that matched.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Document } from '@/types/document';
import { getDocuments, getFolders } from '@/lib/storage';
import { useScan } from '@/contexts/scan-context';
import { LargeTitle } from '@/components/screen-header';
import { useTheme } from '@/contexts/theme-context';
import { EmptyState } from '@/components/empty-state';
import { DocumentRow, DocumentRowSkeleton } from '@/components/document-card';
import { SectionLabel } from '@/components/section-label';
import { useDocumentActions } from '@/components/document-actions';
import { useImportDocuments } from '@/components/use-import';
import { SearchField } from '@/components/search-field';
import { matchesQuery, searchSnippet, sortDocuments } from '@/lib/doc-list';
import { HIT, Radius, Spacing, TAB_BAR_CLEARANCE, Type } from '@/lib/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

const RECENT_LIMIT = 5;

export default function HomeScreen() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { lastSaved } = useScan();
  const { colors } = useTheme();
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

  const q = searchQuery.trim();
  // Recent means recently worked on, whatever the library's sort order is.
  const { displayed, capped } = useMemo(() => {
    if (q) return { displayed: sortDocuments(documents.filter(d => matchesQuery(d, q)), 'dateModified'), capped: false };
    const sorted = sortDocuments(documents, 'dateModified');
    return { displayed: sorted.slice(0, RECENT_LIMIT), capped: sorted.length > RECENT_LIMIT };
  }, [documents, q]);

  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of documents) if (d.folder) counts.set(d.folder, (counts.get(d.folder) ?? 0) + 1);
    return counts;
  }, [documents]);

  const openFolder = useCallback((folder: string) => {
    router.navigate({ pathname: '/files', params: { folder } });
  }, [router]);

  const searching = !!q;
  const noDocs = loaded && documents.length === 0;

  const header = (
    <View>
      {!searching && (
        <View style={styles.quickRow}>
          <QuickAction icon="images-outline" label="Import photos" hint="Make a document from photos" onPress={importImages} />
          <QuickAction icon="folder-open-outline" label="Import file" hint="Import a PDF or an image file" onPress={importFile} />
          <QuickAction icon="create-outline" label="Sign" hint="Sign a document" onPress={() => router.push('/tools/sign')} />
        </View>
      )}
      {!searching && folders.length > 0 && (
        <>
          <View style={styles.sectionRow}>
            <SectionLabel style={styles.sectionLabel}>Folders</SectionLabel>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.folderScroll}
            contentContainerStyle={styles.folderRow}
          >
            {folders.map(f => {
              const n = folderCounts.get(f) ?? 0;
              return (
                <Pressable
                  key={f}
                  onPress={() => openFolder(f)}
                  style={({ pressed }) => [styles.folder, { backgroundColor: colors.card }, pressed && { opacity: 0.7 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Folder ${f}, ${n} ${n === 1 ? 'document' : 'documents'}`}
                >
                  <Ionicons name="folder-outline" size={22} color={colors.accent} />
                  <View style={styles.folderText}>
                    <Text style={[Type.subhead, { color: colors.text, fontWeight: '600' }]} numberOfLines={1}>{f}</Text>
                    <Text style={[Type.caption, { color: colors.muted }]}>{n === 0 ? 'Empty' : `${n} ${n === 1 ? 'document' : 'documents'}`}</Text>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
        </>
      )}
      {displayed.length > 0 && (
        <View style={styles.sectionRow}>
          <SectionLabel style={styles.sectionLabel}>{searching ? 'Results' : 'Recent'}</SectionLabel>
          {!searching && (
            <Pressable
              onPress={() => router.navigate('/files')}
              hitSlop={10}
              style={styles.seeAll}
              accessibilityRole="button"
              accessibilityLabel={capped ? `See all ${documents.length} documents` : 'Open Files'}
            >
              <Text style={[Type.subhead, { color: colors.accent }]}>{capped ? 'See all' : 'Files'}</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.bg }]}>
      <LargeTitle title="Home" />

      <View style={styles.searchRow}>
        <SearchField value={searchQuery} onChangeText={setSearchQuery} />
      </View>

      {!loaded ? (
        <View style={styles.listContent}>
          <View style={styles.quickRow}>
            {[0, 1, 2].map(i => <View key={i} style={[styles.quick, { backgroundColor: colors.card }]} />)}
          </View>
          <SectionLabel style={styles.sectionLabel}>Recent</SectionLabel>
          {[0, 1, 2].map(i => <DocumentRowSkeleton key={i} />)}
        </View>
      ) : (
        <FlatList
          data={displayed}
          keyExtractor={d => d.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }]}
          ListHeaderComponent={header}
          ListEmptyComponent={
            searching ? (
              <View style={styles.empty}>
                <EmptyState variant="no-search-results" query={searchQuery.trim()} />
              </View>
            ) : noDocs ? (
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
              snippet={searching ? searchSnippet(item, q) : undefined}
              snippetQuery={searching ? q : undefined}
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
  hint,
  onPress,
}: {
  icon: IconName;
  label: string;
  hint: string;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.quick, { backgroundColor: colors.card }, pressed && { opacity: 0.75 }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
    >
      <View style={[styles.quickIcon, { backgroundColor: colors.accentLight }]}>
        <Ionicons name={icon} size={22} color={colors.accent} />
      </View>
      <Text
        style={[Type.footnote, styles.quickLabel, { color: colors.text }]}
        numberOfLines={1}
        maxFontSizeMultiplier={1.2}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  searchRow: { paddingHorizontal: Spacing.gutter, paddingBottom: Spacing.xs },
  listContent: { paddingHorizontal: Spacing.gutter, flexGrow: 1 },
  quickRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md },
  quick: {
    flex: 1,
    minHeight: 84,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
  },
  quickIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  quickLabel: { fontWeight: '600' },
  sectionRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  sectionLabel: { marginTop: Spacing.xl },
  seeAll: { minHeight: HIT / 2, justifyContent: 'flex-end', marginBottom: Spacing.sm, marginRight: Spacing.xs },
  // Bleeds to the screen edges so cards scroll out from under the gutter.
  folderScroll: { marginHorizontal: -Spacing.gutter },
  folderRow: { paddingHorizontal: Spacing.gutter, gap: Spacing.sm },
  folder: {
    width: 168,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: Radius.md,
    minHeight: 60,
  },
  folderText: { flex: 1 },
  empty: { flex: 1, paddingTop: Spacing.xxl },
});
