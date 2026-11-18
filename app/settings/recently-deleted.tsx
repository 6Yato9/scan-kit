// app/settings/recently-deleted.tsx
// Recently deleted: documents the user deleted, kept for TRASH_RETENTION_DAYS
// so they can be restored. Tap a row for Restore / Delete forever; "Delete all"
// empties the list. Deleting from here is the only permanent delete.
import { useCallback, useRef, useState } from 'react';
import { Alert, FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  deleteForever,
  emptyTrash,
  getTrashedDocuments,
  restoreDocument,
  trashDaysLeft,
  TRASH_RETENTION_DAYS,
} from '@/lib/storage';
import { Document } from '@/types/document';
import { useTheme } from '@/contexts/theme-context';
import { useScan } from '@/contexts/scan-context';
import { ScreenHeader, HeaderTextButton } from '@/components/screen-header';
import { BottomSheet, SheetGroup, SheetRow } from '@/components/bottom-sheet';
import { EmptyState } from '@/components/empty-state';
import { DocumentRowSkeleton } from '@/components/document-card';
import { useToast } from '@/components/toast';
import { notifySuccess } from '@/lib/haptics';
import { formatPageCount } from '@/lib/format';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

/** "29 days left", "1 day left", "Deletes today". */
function daysLeftLabel(days: number): string {
  if (days <= 0) return 'Deletes today';
  return `${days} ${days === 1 ? 'day' : 'days'} left`;
}

export default function RecentlyDeletedScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { bumpLastSaved } = useScan();
  const [docs, setDocs] = useState<Document[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [target, setTarget] = useState<Document | null>(null);
  // The row shown in the sheet, kept while it slides away.
  const [shown, setShown] = useState<Document | null>(null);
  const pending = useRef<(() => void) | null>(null);

  const load = useCallback(async () => {
    try {
      setDocs(await getTrashedDocuments());
    } catch (err) {
      console.error('Load trash failed', err);
    } finally {
      setLoaded(true);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const restore = useCallback(async (doc: Document) => {
    try {
      await restoreDocument(doc.id);
      setDocs(prev => prev.filter(d => d.id !== doc.id));
      bumpLastSaved();
      notifySuccess();
      toast.show(`Restored “${doc.name}”`);
    } catch (err) {
      console.error('Restore failed', err);
      Alert.alert('Couldn’t restore the document', 'Try again.');
    }
  }, [bumpLastSaved, toast]);

  const confirmDeleteForever = useCallback((doc: Document) => {
    Alert.alert(`Delete “${doc.name}” forever?`, 'This can’t be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete forever',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteForever(doc.id);
            setDocs(prev => prev.filter(d => d.id !== doc.id));
            toast.show('Deleted forever');
          } catch (err) {
            console.error('Delete forever failed', err);
            Alert.alert('Couldn’t delete the document', 'Try again.');
          }
        },
      },
    ]);
  }, [toast]);

  const confirmEmpty = useCallback(() => {
    const n = docs.length;
    if (n === 0) return;
    Alert.alert(
      n === 1 ? 'Delete 1 document forever?' : `Delete ${n} documents forever?`,
      'This can’t be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete all',
          style: 'destructive',
          onPress: async () => {
            try {
              await emptyTrash();
              setDocs([]);
              toast.show(n === 1 ? 'Deleted 1 document forever' : `Deleted ${n} documents forever`);
            } catch (err) {
              console.error('Empty trash failed', err);
              Alert.alert('Couldn’t delete the documents', 'Try again.');
              load();
            }
          },
        },
      ],
    );
  }, [docs.length, toast, load]);

  const openSheet = (doc: Document) => {
    setShown(doc);
    setTarget(doc);
  };
  // Run a sheet action once the sheet has fully gone (it may present an Alert).
  const after = (fn: () => void) => () => {
    pending.current = fn;
    setTarget(null);
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScreenHeader
        title="Recently deleted"
        onBack={() => router.back()}
        right={
          docs.length > 0 ? <HeaderTextButton title="Delete all" color={colors.danger} onPress={confirmEmpty} /> : undefined
        }
      />

      {!loaded ? (
        <View style={styles.list}>
          {[0, 1, 2].map(i => <DocumentRowSkeleton key={i} />)}
        </View>
      ) : docs.length === 0 ? (
        <View style={[styles.flex, { paddingBottom: insets.bottom + Spacing.xxxl }]}>
          <EmptyState
            icon="trash-outline"
            title="No deleted documents"
            subtitle={`Documents you delete stay here for ${TRASH_RETENTION_DAYS} days, so you can get them back.`}
          />
        </View>
      ) : (
        <FlatList
          data={docs}
          keyExtractor={d => d.id}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + Spacing.xxl }]}
          ListHeaderComponent={
            <Text style={[Type.footnote, styles.intro, { color: colors.muted }]}>
              Documents are deleted forever {TRASH_RETENTION_DAYS} days after you delete them. Tap one to restore it.
            </Text>
          }
          renderItem={({ item }) => (
            <TrashRow doc={item} onPress={() => openSheet(item)} onRestore={() => restore(item)} />
          )}
        />
      )}

      <BottomSheet
        visible={target !== null}
        onClose={() => { pending.current = null; setTarget(null); }}
        variant="grouped"
        onDismissed={() => {
          const fn = pending.current;
          pending.current = null;
          fn?.();
        }}
      >
        {shown && (
          <>
            <View style={styles.sheetHeader}>
              <Thumb doc={shown} />
              <View style={styles.flex}>
                <Text style={[Type.headline, { color: colors.text }]} numberOfLines={2}>{shown.name}</Text>
                <Text style={[Type.footnote, { color: colors.muted, marginTop: 2 }]} numberOfLines={1}>
                  {formatPageCount(shown)}, {daysLeftLabel(trashDaysLeft(shown)).toLowerCase()}
                </Text>
              </View>
            </View>
            <SheetGroup>
              <SheetRow icon="arrow-undo-outline" label="Restore" onPress={after(() => restore(shown))} last />
            </SheetGroup>
            <SheetGroup style={styles.lastGroup}>
              <SheetRow icon="trash-outline" label="Delete forever" destructive onPress={after(() => confirmDeleteForever(shown))} last />
            </SheetGroup>
          </>
        )}
      </BottomSheet>
    </View>
  );
}

function Thumb({ doc }: { doc: Document }) {
  const { colors } = useTheme();
  if (doc.pdfUri || !doc.pages[0]) {
    return (
      <View style={[styles.thumb, styles.thumbIcon, { backgroundColor: colors.placeholder }]}>
        <Ionicons name="document-text-outline" size={20} color={colors.muted} />
      </View>
    );
  }
  return (
    <Image
      source={{ uri: `${doc.pages[0]}?v=${doc.updatedAt}` }}
      style={[styles.thumb, { backgroundColor: colors.placeholder }]}
      resizeMode="cover"
    />
  );
}

function TrashRow({ doc, onPress, onRestore }: { doc: Document; onPress: () => void; onRestore: () => void }) {
  const { colors } = useTheme();
  const days = trashDaysLeft(doc);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, { backgroundColor: colors.card }, pressed && { opacity: 0.7 }]}
      accessibilityRole="button"
      accessibilityLabel={`${doc.name}, ${formatPageCount(doc)}, ${daysLeftLabel(days)}`}
      accessibilityHint="Opens restore and delete options"
    >
      <Thumb doc={doc} />
      <View style={styles.rowText}>
        <Text style={[Type.subhead, { color: colors.text, fontWeight: '600' }]} numberOfLines={1}>{doc.name}</Text>
        <Text style={[Type.footnote, { color: days <= 3 ? colors.danger : colors.muted, marginTop: 2 }]} numberOfLines={1}>
          {formatPageCount(doc)}, {daysLeftLabel(days).toLowerCase()}
        </Text>
      </View>
      <Pressable
        onPress={onRestore}
        hitSlop={8}
        style={({ pressed }) => [styles.restoreBtn, { backgroundColor: colors.accentLight }, pressed && { opacity: 0.6 }]}
        accessibilityRole="button"
        accessibilityLabel={`Restore ${doc.name}`}
      >
        <Text style={[Type.footnote, { color: colors.accent, fontWeight: '600' }]}>Restore</Text>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  list: { paddingHorizontal: Spacing.gutter, paddingTop: Spacing.sm },
  intro: { marginBottom: Spacing.md, marginHorizontal: Spacing.xs, lineHeight: 18 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: Radius.md,
    marginBottom: Spacing.sm,
  },
  rowText: { flex: 1 },
  thumb: { width: 40, height: 52, borderRadius: 6 },
  thumbIcon: { alignItems: 'center', justifyContent: 'center' },
  restoreBtn: {
    minHeight: 32,
    minWidth: HIT + 20,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginBottom: Spacing.lg, paddingHorizontal: Spacing.xs },
  lastGroup: { marginBottom: 0 },
});
