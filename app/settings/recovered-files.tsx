// app/settings/recovered-files.tsx
// Recovered files: what the app set aside during an update and can't show
// anywhere else (lib/recovered-files.ts) — pages an older version of the app
// saved over the same files a newer one had, and old pages no document uses.
// Settings shows the entry only while there is something here. Tap a row to
// bring the pages back as a new document, share them, or delete them.
import { useCallback, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { useScan } from '@/contexts/scan-context';
import { ScreenHeader } from '@/components/screen-header';
import { BottomSheet, SheetGroup, SheetRow } from '@/components/bottom-sheet';
import { EmptyState } from '@/components/empty-state';
import { DocumentRowSkeleton } from '@/components/document-card';
import { PageThumb } from '@/components/page-thumb';
import { useToast } from '@/components/toast';
import { formatBytes } from '@/components/tool-ui';
import { notifySuccess } from '@/lib/haptics';
import { formatDate } from '@/lib/format';
import { canShareFiles, isCancelError, shareFile, shareFiles } from '@/lib/share';
import {
  canRestore,
  deleteRecovered,
  getRecoveredGroups,
  restoreRecoveredGroup,
  type RecoveredGroup,
} from '@/lib/recovered-files';
import { Radius, Spacing, Type } from '@/lib/theme';

function titleOf(g: RecoveredGroup): string {
  const n = g.files.length;
  switch (g.kind) {
    case 'pages': return n === 1 ? '1 page' : `${n} pages`;
    case 'pdf': return 'PDF document';
    case 'signatures': return n === 1 ? '1 signature' : `${n} signatures`;
    default: return n === 1 ? '1 file' : `${n} files`;
  }
}

function detailOf(g: RecoveredGroup): string {
  const when = g.savedAt ? `Set aside ${formatDate(g.savedAt)}` : 'From an earlier version';
  return `${when}, ${formatBytes(g.bytes)}`;
}

export default function RecoveredFilesScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { bumpLastSaved } = useScan();
  const [groups, setGroups] = useState<RecoveredGroup[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<RecoveredGroup | null>(null);
  // The row shown in the sheet, kept while it slides away.
  const [shown, setShown] = useState<RecoveredGroup | null>(null);
  const pending = useRef<(() => void) | null>(null);

  const load = useCallback(async () => {
    setGroups(await getRecoveredGroups());
    setLoaded(true);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const restore = useCallback(async (g: RecoveredGroup) => {
    if (busy) return;
    setBusy(true);
    try {
      await restoreRecoveredGroup(g);
      bumpLastSaved();
      notifySuccess();
      toast.show(g.kind === 'pdf' ? 'Restored as a document' : 'Restored as a new document');
    } catch (err) {
      console.error('Restore recovered files failed', err);
      Alert.alert('Couldn’t restore these files', 'There may not be enough free space. Free up some storage and try again.');
    } finally {
      setBusy(false);
      load();
    }
  }, [busy, bumpLastSaved, toast, load]);

  const share = useCallback(async (g: RecoveredGroup) => {
    try {
      if (g.files.length > 1 && canShareFiles()) await shareFiles(g.files);
      else await shareFile(g.files[0]);
    } catch (err) {
      if (isCancelError(err)) return;
      console.error('Share recovered files failed', err);
      Alert.alert('Couldn’t share these files', 'Try again.');
    }
  }, []);

  const confirmDelete = useCallback((g: RecoveredGroup) => {
    const what = titleOf(g).replace(/^1 /, 'this ').replace(/^PDF document$/, 'this PDF');
    Alert.alert(`Delete ${what}?`, 'They’re not part of any document. This can’t be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          if (deleteRecovered(g)) toast.show('Deleted');
          else Alert.alert('Couldn’t delete everything', 'Try again.');
          load();
        },
      },
    ]);
  }, [toast, load]);

  const openSheet = (g: RecoveredGroup) => {
    setShown(g);
    setTarget(g);
  };
  // Run a sheet action once the sheet has fully gone (it may present a sheet or an Alert).
  const after = (fn: () => void) => () => {
    pending.current = fn;
    setTarget(null);
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScreenHeader title="Recovered files" onBack={() => router.back()} />

      {!loaded ? (
        <View style={styles.list}>
          {[0, 1].map(i => <DocumentRowSkeleton key={i} />)}
        </View>
      ) : groups.length === 0 ? (
        <View style={[styles.flex, { paddingBottom: insets.bottom + Spacing.xxxl }]}>
          <EmptyState
            icon="checkmark-circle-outline"
            title="Nothing to recover"
            subtitle="Every page is in your documents."
          />
        </View>
      ) : (
        <FlatList
          data={groups}
          keyExtractor={g => g.key}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + Spacing.xxl }]}
          ListHeaderComponent={
            <Text style={[Type.footnote, styles.intro, { color: colors.muted }]}>
              An update set these files aside instead of replacing or deleting them. They aren’t part of any document. Restore them as a new document, or delete them.
            </Text>
          }
          renderItem={({ item }) => <GroupRow group={item} onPress={() => openSheet(item)} />}
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
              <Thumb group={shown} />
              <View style={styles.flex}>
                <Text style={[Type.headline, { color: colors.text }]} numberOfLines={1}>{titleOf(shown)}</Text>
                <Text style={[Type.footnote, { color: colors.muted, marginTop: 2 }]} numberOfLines={1}>{detailOf(shown)}</Text>
              </View>
            </View>
            <SheetGroup>
              {canRestore(shown) && (
                <SheetRow icon="arrow-undo-outline" label="Restore as a document" onPress={after(() => restore(shown))} />
              )}
              <SheetRow icon="share-outline" label="Share" onPress={after(() => share(shown))} last />
            </SheetGroup>
            <SheetGroup style={styles.lastGroup}>
              <SheetRow icon="trash-outline" label="Delete" destructive onPress={after(() => confirmDelete(shown))} last />
            </SheetGroup>
          </>
        )}
      </BottomSheet>
    </View>
  );
}

function Thumb({ group }: { group: RecoveredGroup }) {
  const { colors } = useTheme();
  const first = group.files[0];
  if ((group.kind === 'pages' || group.kind === 'signatures') && first) {
    return <PageThumb uri={first} style={[styles.thumb, { backgroundColor: colors.placeholder }]} />;
  }
  return (
    <View style={[styles.thumb, styles.thumbIcon, { backgroundColor: colors.placeholder }]}>
      <Ionicons name={group.kind === 'pdf' ? 'document-text-outline' : 'documents-outline'} size={20} color={colors.muted} />
    </View>
  );
}

function GroupRow({ group, onPress }: { group: RecoveredGroup; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, { backgroundColor: colors.card }, pressed && { opacity: 0.7 }]}
      accessibilityRole="button"
      accessibilityLabel={`${titleOf(group)}, ${detailOf(group)}`}
      accessibilityHint="Opens restore, share and delete options"
    >
      <Thumb group={group} />
      <View style={styles.flex}>
        <Text style={[Type.subhead, { color: colors.text, fontWeight: '600' }]} numberOfLines={1}>{titleOf(group)}</Text>
        <Text style={[Type.footnote, { color: colors.muted, marginTop: 2 }]} numberOfLines={1}>{detailOf(group)}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.muted} />
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
  thumb: { width: 40, height: 52, borderRadius: 6 },
  thumbIcon: { alignItems: 'center', justifyContent: 'center' },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginBottom: Spacing.lg, paddingHorizontal: Spacing.xs },
  lastGroup: { marginBottom: 0 },
});
