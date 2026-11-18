// app/(tabs)/index.tsx
// Home: search everything, and the most recent documents.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Document } from '@/types/document';
import { getDocuments, getSortPreference, saveSortPreference, getFolders, SortKey } from '@/lib/storage';
import { useScan } from '@/contexts/scan-context';
import { useTheme } from '@/contexts/theme-context';
import { EmptyState } from '@/components/empty-state';
import { DocumentRow, DocumentRowSkeleton } from '@/components/document-card';
import { SortSheet } from '@/components/sort-sheet';
import { SectionLabel } from '@/components/section-label';
import { HeaderIconButton } from '@/components/screen-header';
import { useDocumentActions } from '@/components/document-actions';
import { SearchField } from '@/components/search-field';
import { matchesQuery, sortDocuments } from '@/lib/doc-list';
import { HIT, Spacing, Type } from '@/lib/theme';

const RECENT_LIMIT = 10;

export default function HomeScreen() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('dateAdded');
  const [sortSheetVisible, setSortSheetVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { lastSaved, triggerScan } = useScan();
  const { colors } = useTheme();
  const actions = useDocumentActions({ documents, setDocuments, folders, setFolders });

  const load = useCallback(async () => {
    try {
      const [docs, sort, fldrs] = await Promise.all([getDocuments(), getSortPreference(), getFolders()]);
      setDocuments(docs);
      setSortKey(sort);
      setFolders(fldrs);
    } finally {
      setLoaded(true);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { if (lastSaved > 0) load(); }, [lastSaved, load]);

  const q = searchQuery.trim().toLowerCase();
  const { displayed, capped } = useMemo(() => {
    const filtered = q ? documents.filter(d => matchesQuery(d, q)) : documents;
    const sorted = sortDocuments(filtered, sortKey);
    if (q) return { displayed: sorted, capped: false };
    return { displayed: sorted.slice(0, RECENT_LIMIT), capped: sorted.length > RECENT_LIMIT };
  }, [documents, q, sortKey]);

  const handleSort = useCallback(async (key: SortKey) => {
    setSortKey(key);
    await saveSortPreference(key);
  }, []);

  const scan = useCallback(async () => {
    const id = await triggerScan();
    if (id) router.push({ pathname: '/viewer', params: { id } });
  }, [triggerScan, router]);

  const showList = loaded && (documents.length > 0 || !!q);

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.bg }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">Home</Text>
        <HeaderIconButton icon="swap-vertical" label="Sort documents" color={colors.accent} size={22} onPress={() => setSortSheetVisible(true)} />
      </View>

      <View style={styles.searchRow}>
        <SearchField value={searchQuery} onChangeText={setSearchQuery} />
      </View>

      {!loaded ? (
        <View style={styles.listContent}>
          <SectionLabel style={styles.sectionLabel}>Recent</SectionLabel>
          {[0, 1, 2, 3].map(i => <DocumentRowSkeleton key={i} />)}
        </View>
      ) : !showList ? (
        <View style={[styles.flex, { paddingBottom: insets.bottom + 72 }]}>
        <EmptyState
          variant="no-docs"
          actionLabel="Scan a document"
          actionIcon="camera-outline"
          onAction={scan}
          secondaryLabel="Import from Photos"
          onSecondaryAction={() => router.navigate({ pathname: '/files', params: { action: 'importImages' } })}
        />
        </View>
      ) : (
        <FlatList
          data={displayed}
          keyExtractor={d => d.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 110 }, displayed.length === 0 && styles.listContentEmpty]}
          ListHeaderComponent={
            displayed.length > 0 ? (
              <View style={styles.sectionRow}>
                <SectionLabel style={styles.sectionLabel}>{q ? 'Results' : 'Recent'}</SectionLabel>
                {capped && (
                  <Pressable
                    onPress={() => router.navigate('/files')}
                    hitSlop={10}
                    style={styles.seeAll}
                    accessibilityRole="button"
                    accessibilityLabel={`See all ${documents.length} documents`}
                  >
                    <Text style={[Type.subhead, { color: colors.accent }]}>See all</Text>
                  </Pressable>
                )}
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={[styles.flex, { paddingBottom: insets.bottom + 72 }]}>
              <EmptyState variant="no-search-results" query={searchQuery.trim()} />
            </View>
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

      <SortSheet
        visible={sortSheetVisible}
        current={sortKey}
        onSort={handleSort}
        onClose={() => setSortSheetVisible(false)}
      />
      {actions.sheets}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 20,
    paddingRight: Spacing.sm,
    paddingTop: 14,
    paddingBottom: Spacing.sm,
  },
  title: { fontSize: 30, fontWeight: '800', letterSpacing: -0.5 },
  searchRow: { paddingHorizontal: Spacing.gutter, paddingBottom: Spacing.xs },
  listContent: { paddingHorizontal: Spacing.gutter },
  listContentEmpty: { flexGrow: 1 },
  sectionRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  sectionLabel: { marginTop: Spacing.lg },
  seeAll: { minHeight: HIT / 2, justifyContent: 'flex-end', marginBottom: Spacing.sm, marginRight: Spacing.xs },
});
