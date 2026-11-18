// app/(tabs)/index.tsx
// Home: a starting point, not a second library. Quick actions (scan, import),
// the few most recent documents, and shortcuts into folders. The full library
// (every document, grid or list, sort, select, folders) lives in Files.
// Searching here covers everything, including text inside documents.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Document } from '@/types/document';
import { getDocuments, getFolders } from '@/lib/storage';
import { useScan } from '@/contexts/scan-context';
import { useTheme } from '@/contexts/theme-context';
import { EmptyState } from '@/components/empty-state';
import { DocumentRow, DocumentRowSkeleton } from '@/components/document-card';
import { SectionLabel } from '@/components/section-label';
import { useDocumentActions } from '@/components/document-actions';
import { useImportDocuments } from '@/components/use-import';
import { SearchField } from '@/components/search-field';
import { matchesQuery, sortDocuments } from '@/lib/doc-list';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

const RECENT_LIMIT = 5;

export default function HomeScreen() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { lastSaved, triggerScan } = useScan();
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

  const q = searchQuery.trim().toLowerCase();
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

  const scan = useCallback(async () => {
    const id = await triggerScan();
    if (id) router.push({ pathname: '/viewer', params: { id } });
  }, [triggerScan, router]);

  const openFolder = useCallback((folder: string) => {
    router.navigate({ pathname: '/files', params: { folder } });
  }, [router]);

  const searching = !!q;
  const noDocs = loaded && documents.length === 0;

  const header = (
    <View>
      {!searching && (
        <View style={styles.quickRow}>
          <QuickAction icon="camera-outline" label="Scan" hint="Scan a document with the camera" onPress={scan} primary />
          <QuickAction icon="images-outline" label="Import photos" hint="Make a document from photos" onPress={importImages} />
          <QuickAction icon="folder-open-outline" label="Import file" hint="Import a PDF or an image file" onPress={importFile} />
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
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">Home</Text>
      </View>

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
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 110 }]}
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
                  subtitle="Scan a document, or import photos or a PDF. Your newest documents show up here."
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
  hint,
  onPress,
  primary,
}: {
  icon: IconName;
  label: string;
  hint: string;
  onPress: () => void;
  primary?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.quick,
        { backgroundColor: primary ? colors.accentFill : colors.card },
        pressed && { opacity: 0.75 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
    >
      <View style={[styles.quickIcon, !primary && { backgroundColor: colors.accentLight }]}>
        {/* A soft disc of the label colour behind the icon on the filled card. */}
        {primary && <View style={[StyleSheet.absoluteFill, styles.quickDisc, { backgroundColor: colors.onAccent }]} />}
        <Ionicons name={icon} size={22} color={primary ? colors.onAccent : colors.accent} />
      </View>
      <Text
        style={[Type.footnote, styles.quickLabel, { color: primary ? colors.onAccent : colors.text }]}
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 20,
    paddingRight: Spacing.sm,
    paddingTop: 14,
    paddingBottom: Spacing.sm,
    minHeight: 14 + HIT + Spacing.sm,
  },
  title: { fontSize: 30, fontWeight: '800', letterSpacing: -0.5 },
  searchRow: { paddingHorizontal: Spacing.gutter, paddingBottom: Spacing.xs },
  listContent: { paddingHorizontal: Spacing.gutter, flexGrow: 1 },
  quickRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md },
  quick: {
    flex: 1,
    minHeight: 92,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
  },
  quickIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  quickDisc: { borderRadius: 20, opacity: 0.18 },
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
