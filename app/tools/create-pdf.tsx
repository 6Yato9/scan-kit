// app/tools/create-pdf.tsx
// Create PDF, from the Tools tab: put together ONE new document from photos
// (library, multi-select), PDFs and images from the Files app (multi-select),
// and pages of documents already in Scan Kit (some or all of them) — added in
// any mix, any number of times — then arrange the pages (drag, or VoiceOver's
// Move up / Move down), turn and remove them, and create.
//
// What is made (lib/create-pdf.ts): with a PDF page among them, one new PDF
// whose PDF pages keep their text; otherwise a new scanned document (still
// filterable and re-croppable, exported as a PDF in one tap). The originals
// are never changed. The new document replaces this screen in the viewer, with
// Undo: it removes the new document (lib/merge-undo undoNewMerge) and comes
// back here with the same list (lib/create-pdf-build draft), since Undo
// usually means the order or the choice was wrong.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router as stackRouter, useLocalSearchParams, useRouter } from 'expo-router';
import DraggableFlatList, { ScaleDecorator, type RenderItemParams } from 'react-native-draggable-flatlist';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Ionicons } from '@expo/vector-icons';
import { useScan, QUALITY_MAP } from '@/contexts/scan-context';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import { FooterActions, ToolIntro, ToolNote, ToolProgress, ToolScreen } from '@/components/tool-ui';
import { useToast } from '@/components/toast';
import { PageRow } from '@/components/create-pdf/page-row';
import { DocPagePicker, sourceRefusalMessage, type PickedPages } from '@/components/create-pdf/doc-page-picker';
import {
  pdfItems,
  prepareImageItem,
  scanItems,
  SourceError,
  stageFilesPdf,
  storedPdfSource,
  type StagedSource,
} from '@/components/create-pdf/sources';
import {
  createdName,
  moveItem,
  pagesLabel,
  progressTotal,
  removeItem,
  resultKind,
  turnItem,
  unusedSources,
  type CreateItem,
  type CreateProgress,
} from '@/lib/create-pdf';
import {
  buildDocument,
  canCreateFromPdfs,
  CreatePdfError,
  discardDraft,
  discardItem,
  discardSource,
  peekDraft,
  stashDraft,
  takeDraft,
  type CreateDraft,
} from '@/lib/create-pdf-build';
import { autoName } from '@/lib/auto-name';
import { documentNameFor, importKindOf } from '@/lib/incoming-file';
import { getDocSettings, getScanSettings, keepSourcesEnabled } from '@/lib/storage';
import { withSystemUI } from '@/lib/system-ui';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { newMergeUndo, undoNewMerge } from '@/lib/merge-undo';
import { postViewerNotice } from '@/lib/viewer-notice';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { Radius, Spacing, Type } from '@/lib/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];
type Adding = { label: string; done: number; total: number };

/** The viewer's message for the new document. */
function createdMessage(kind: 'pdf' | 'scan', n: number): string {
  return `${kind === 'pdf' ? 'PDF' : 'Document'} created from ${pagesLabel(n)}. The originals are kept.`;
}

function failureAlert(err: unknown): void {
  const e = err instanceof CreatePdfError ? err : null;
  const who = e?.sourceName ? `“${e.sourceName}”` : null;
  switch (e?.kind) {
    case 'cancelled':
      return;
    case 'changed':
      Alert.alert(
        who ? `${who} changed` : 'A document changed',
        'Its pages were edited, moved or deleted while you were choosing. Remove its pages from the list and add them again.',
      );
      return;
    case 'locked':
      Alert.alert(`${who ?? 'A PDF'} is password protected`, 'Remove its pages and add them again to enter its password.');
      return;
    case 'restricted':
      Alert.alert(
        who ? `${who} can’t be combined` : 'A PDF can’t be combined',
        'Its author doesn’t allow its pages to be copied into another document. Remove its pages and try again.',
      );
      return;
    case 'unavailable':
      Alert.alert('Couldn’t create the PDF', 'This version of Scan Kit can’t combine PDF pages. Remove the PDF pages and try again.');
      return;
    default:
      console.error('Create PDF failed', err);
      Alert.alert('Couldn’t create the PDF', 'There may not be enough free space. Nothing was changed. Try again.');
  }
}

function AddButton({ icon, label, onPress, disabled }: { icon: IconName; label: string; onPress: () => void; disabled: boolean }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.addBtn, (pressed || disabled) && { opacity: disabled ? 0.4 : 0.6 }]}
      accessibilityRole="button"
      accessibilityLabel={`Add ${label.toLowerCase()}`}
      accessibilityState={{ disabled }}
    >
      <View style={[styles.addIcon, { backgroundColor: colors.accentLight }]}>
        <Ionicons name={icon} size={22} color={colors.accent} />
      </View>
      <Text style={[Type.footnote, styles.addLabel, { color: colors.text }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export default function CreatePdfScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ restore?: string }>();
  const { colors } = useTheme();
  const { bumpLastSaved } = useScan();
  const toast = useToast();

  // Back from Undo: the list as it was (its files were kept for it).
  const [restored] = useState<CreateDraft | null>(() => (params.restore === '1' ? peekDraft() : null));
  const [items, setItems] = useState<CreateItem[]>(() => restored?.items ?? []);
  const [sources, setSources] = useState<StagedSource[]>(() => restored?.sources ?? []);
  const [name, setName] = useState(() => restored?.name ?? '');
  // The automatic name, shown as the field's placeholder and used when it is left empty.
  const [autoTitle, setAutoTitle] = useState<string | null>(null);
  const [adding, setAdding] = useState<Adding | null>(null);
  const [building, setBuilding] = useState<CreateProgress | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const busy = useRef(false);
  const mounted = useRef(true);
  const abort = useRef<AbortController | null>(null);
  // The files now belong to Undo's draft: leaving must not delete them.
  const handedOff = useRef(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  // Leaving deletes the list's temp files — a moment later, so a development
  // StrictMode remount (cleanup then setup again) keeps them.
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    mounted.current = true;
    // The restored list's files are this screen's now (no longer Undo's).
    if (restored && peekDraft() === restored) takeDraft();
    if (leaving.current) clearTimeout(leaving.current);
    leaving.current = null;
    getDocSettings()
      .then(s => mounted.current && setAutoTitle(autoName(new Date(), s.namePrefix)))
      .catch(() => {});
    return () => {
      mounted.current = false;
      abort.current?.abort();
      leaving.current = setTimeout(() => {
        if (mounted.current || handedOff.current) return;
        itemsRef.current.forEach(discardItem);
        sourcesRef.current.forEach(discardSource);
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A PDF source no page uses any more: its staged copy and thumbnails go.
  useEffect(() => {
    const unused = unusedSources(items, sources);
    if (!unused.length) return;
    unused.forEach(discardSource);
    setSources(prev => prev.filter(s => !unused.includes(s)));
  }, [items, sources]);

  const working = !!adding || !!building;

  // ── Adding ────────────────────────────────────────────────────────────────

  /** Prepares images one at a time (bounded memory), appending each as it is ready. */
  const addImages = useCallback(async (files: { uri: string; label: string }[], origin: 'photo' | 'file', what: string) => {
    const [scan, keep] = await Promise.all([getScanSettings(), keepSourcesEnabled()]);
    const quality = QUALITY_MAP[scan.quality];
    let failed = 0;
    for (let i = 0; i < files.length; i++) {
      if (!mounted.current) break;
      setAdding({ label: `Preparing ${what}…`, done: i, total: files.length });
      try {
        const item = await prepareImageItem(files[i].uri, origin, quality, keep, files[i].label);
        if (!mounted.current) {
          discardItem(item);
          break;
        }
        setItems(prev => [...prev, item]);
      } catch (err) {
        console.warn('Create PDF: image not added', err);
        failed++;
      }
    }
    return failed;
  }, []);

  const addPhotos = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      // Tracked so the app lock doesn't present over the picker (lib/system-ui).
      const result = await withSystemUI(
        () => ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, orderedSelection: true, quality: 1 }),
        (): ImagePicker.ImagePickerResult => ({ canceled: true, assets: null }),
      );
      if (result.canceled || !result.assets?.length) return;
      const failed = await addImages(result.assets.map(a => ({ uri: a.uri, label: 'Photo' })), 'photo', result.assets.length === 1 ? 'photo' : 'photos');
      if (failed) Alert.alert(failed === 1 ? 'A photo couldn’t be added' : `${failed} photos couldn’t be added`, 'Try choosing them again.');
    } catch (err) {
      console.error('Create PDF: photos failed', err);
      Alert.alert('Couldn’t add photos', 'Check that Scan Kit can access your photos, then try again.');
    } finally {
      busy.current = false;
      if (mounted.current) setAdding(null);
    }
  }, [addImages]);

  const addFiles = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const result = await withSystemUI(
        () => DocumentPicker.getDocumentAsync({ type: ['application/pdf', 'image/*'], copyToCacheDirectory: true, multiple: true }),
        (): DocumentPicker.DocumentPickerResult => ({ canceled: true, assets: null }),
      );
      if (result.canceled || !result.assets?.length) return;
      const problems: { title: string; body: string }[] = [];
      let unsupported = 0;
      let failed = 0;
      for (let k = 0; k < result.assets.length; k++) {
        if (!mounted.current) break;
        const asset = result.assets[k];
        const fileName = asset.name || asset.uri;
        const label = documentNameFor(fileName) ?? 'File';
        const kind = importKindOf(fileName, asset.mimeType);
        if (!kind) {
          unsupported++;
          continue;
        }
        if (kind === 'image') {
          failed += await addImages([{ uri: asset.uri, label }], 'file', result.assets.length > 1 ? `file ${k + 1} of ${result.assets.length}` : 'the image');
          continue;
        }
        setAdding({ label: `Opening “${label}”…`, done: k, total: result.assets.length });
        try {
          const { source, items: pages } = await stageFilesPdf(asset.uri, label);
          if (!mounted.current) {
            discardSource(source);
            break;
          }
          setSources(prev => [...prev, source]);
          setItems(prev => [...prev, ...pages]);
        } catch (err) {
          const msg = err instanceof SourceError ? sourceRefusalMessage(err) : { title: `Couldn’t open “${label}”`, body: 'Try again.' };
          if (msg) problems.push(msg);
        }
      }
      if (problems.length) Alert.alert(problems[0].title, problems.length > 1 ? `${problems[0].body} ${problems.length - 1} more files couldn’t be added either.` : problems[0].body);
      else if (unsupported) Alert.alert(unsupported === 1 ? 'A file wasn’t added' : `${unsupported} files weren’t added`, 'Only PDFs and images can be added.');
      else if (failed) Alert.alert(failed === 1 ? 'An image couldn’t be added' : `${failed} images couldn’t be added`, 'The file may be damaged. Try another one.');
    } catch (err) {
      console.error('Create PDF: files failed', err);
      Alert.alert('Couldn’t add the files', 'Choose PDFs or images and try again.');
    } finally {
      busy.current = false;
      if (mounted.current) setAdding(null);
    }
  }, [addImages]);

  const addPicked = useCallback((picked: PickedPages) => {
    setPickerOpen(false);
    if (picked.pdf) {
      const source = storedPdfSource(picked.doc, picked.pdf.pageCount);
      setSources(prev => [...prev, source]);
      setItems(prev => [...prev, ...pdfItems(source, picked.indices, picked.pdf!.thumbs)]);
    } else {
      setItems(prev => [...prev, ...scanItems(picked.doc, picked.indices)]);
    }
  }, []);

  // ── The list ──────────────────────────────────────────────────────────────

  const remove = useCallback((key: string) => {
    setItems(prev => {
      const { items: next, removed } = removeItem(prev, key);
      if (removed) discardItem(removed);
      return next;
    });
  }, []);
  const rotate = useCallback((key: string) => setItems(prev => turnItem(prev, key, 90)), []);
  const move = useCallback((key: string, delta: number) => {
    setItems(prev => {
      const at = prev.findIndex(it => it.key === key);
      return moveItem(prev, at, at + delta);
    });
  }, []);

  // ── Create ────────────────────────────────────────────────────────────────

  const create = async () => {
    if (!items.length || working) return;
    const ctl = new AbortController();
    abort.current = ctl;
    const list = items;
    setBuilding({ done: 0, total: progressTotal(list) });
    try {
      const named = createdName(name, autoTitle ?? autoName(new Date(), (await getDocSettings().catch(() => null))?.namePrefix));
      const { doc, kind } = await buildDocument(list, sources, named.name, named.isDefault, {
        signal: ctl.signal,
        onProgress: p => mounted.current && setBuilding(p),
      });
      bumpLastSaved();
      notifySuccess();
      // The list and its files stay for Undo until it can't be used any more.
      const draft: CreateDraft = { items: list, sources, name };
      stashDraft(draft);
      handedOff.current = true;
      const undo = newMergeUndo(doc);
      postViewerNotice({
        docId: doc.id,
        message: createdMessage(kind, list.length),
        action: {
          label: 'Undo',
          onPress: () => {
            navigateWhenUnlocked(() => {
              stackRouter.back();
              stackRouter.push({ pathname: '/tools/create-pdf', params: { restore: '1' } });
            });
            undoNewMerge(undo)
              .then(outcome => {
                bumpLastSaved();
                notifySuccess();
                const what = kind === 'pdf' ? 'PDF' : 'document';
                if (outcome === 'trashed') toast.show(`New ${what} moved to Recently deleted`);
                else toast.show(`Removed the new ${what}`);
              })
              .catch(err => {
                console.error('Undo create PDF failed', err);
                notifyError();
                Alert.alert('Couldn’t undo', `Try again, or delete the new ${kind === 'pdf' ? 'PDF' : 'document'} yourself.`);
              });
          },
        },
        onExpire: () => discardDraft(draft),
      });
      navigateWhenUnlocked(() => router.replace({ pathname: '/viewer', params: { id: doc.id } }));
    } catch (err) {
      if (!(err instanceof CreatePdfError && err.kind === 'cancelled')) notifyError();
      failureAlert(err);
    } finally {
      abort.current = null;
      if (mounted.current) setBuilding(null);
    }
  };

  // ── Rendering ─────────────────────────────────────────────────────────────

  const n = items.length;
  const kind = resultKind(items);
  const pdfs = canCreateFromPdfs();

  const addBar = (
    <View style={[styles.addBar, { backgroundColor: colors.card }]}>
      <AddButton icon="images-outline" label="Photos" onPress={addPhotos} disabled={working} />
      <AddButton icon="folder-open-outline" label="Files" onPress={addFiles} disabled={working} />
      <AddButton icon="documents-outline" label="Documents" onPress={() => setPickerOpen(true)} disabled={working} />
    </View>
  );

  const addingLine = adding ? (
    <View style={styles.addingLine}>
      <ToolProgress label={adding.total > 1 ? `${adding.label} ${adding.done + 1} of ${adding.total}` : adding.label} current={adding.done} total={adding.total} />
    </View>
  ) : null;

  const header = n === 0 ? (
    <View>
      <ToolIntro
        icon="document-attach-outline"
        title="Create a PDF"
        text="Put photos, files and pages of your documents together in one new PDF, in any order."
        points={[
          { icon: 'images-outline', text: 'Photos, cropped and straightened like a scan' },
          { icon: 'folder-open-outline', text: 'PDFs and images from the Files app' },
          { icon: 'documents-outline', text: 'Pages of your Scan Kit documents' },
        ]}
      />
      <SectionLabel>Add pages</SectionLabel>
      {addBar}
      {addingLine}
    </View>
  ) : (
    <View>
      <SectionLabel>Name</SectionLabel>
      <TextInput
        style={[Type.body, styles.input, { color: colors.text, backgroundColor: colors.card }]}
        value={name}
        onChangeText={setName}
        placeholder={autoTitle ?? 'Name'}
        placeholderTextColor={colors.muted}
        returnKeyType="done"
        maxLength={120}
        editable={!building}
        accessibilityLabel="Name of the new document"
      />
      <SectionLabel>{`Pages, ${n}`}</SectionLabel>
    </View>
  );

  const footerNote =
    kind === 'pdf'
      ? 'With a PDF page among them, the result is a new PDF: PDF pages keep their text, and photos and scans are placed on your paper size from Document settings. The originals are kept.'
      : pdfs
        ? 'The result is a new document you can still filter and crop, and export or share as a PDF. Adding a PDF page makes it a PDF instead. The originals are kept.'
        : 'The result is a new document you can still filter and crop, and export or share as a PDF. The originals are kept.';

  const listFooter = n === 0 ? null : (
    <View>
      <Text style={[Type.footnote, styles.hint, { color: colors.muted }]}>
        Touch and hold a page to drag it. Pages are added at the end.
      </Text>
      <SectionLabel>Add more</SectionLabel>
      {addBar}
      {addingLine}
      <ToolNote>{footerNote}</ToolNote>
    </View>
  );

  const renderItem = ({ item, getIndex, drag, isActive }: RenderItemParams<CreateItem>) => (
    <ScaleDecorator>
      <PageRow
        item={item}
        position={(getIndex() ?? 0) + 1}
        count={n}
        active={isActive}
        disabled={working}
        drag={drag}
        onRotate={() => rotate(item.key)}
        onRemove={() => remove(item.key)}
        onMove={d => move(item.key, d)}
      />
    </ScaleDecorator>
  );

  return (
    <ToolScreen
      title="Create PDF"
      scroll={false}
      busy={!!building}
      footer={
        building ? (
          <>
            <ToolProgress label="Creating…" current={building.done} total={building.total} />
            <FooterActions
              secondary={<PrimaryButton title="Cancel" variant="secondary" onPress={() => abort.current?.abort()} />}
              primary={<PrimaryButton title="Create PDF" icon="document-attach-outline" onPress={() => {}} loading />}
            />
          </>
        ) : (
          <PrimaryButton
            title={n ? `Create PDF, ${pagesLabel(n)}` : 'Create PDF'}
            icon="document-attach-outline"
            onPress={create}
            disabled={n === 0 || !!adding}
          />
        )
      }
    >
      <DraggableFlatList
        data={items}
        keyExtractor={it => it.key}
        renderItem={renderItem}
        onDragEnd={({ data }) => setItems(data)}
        ListHeaderComponent={header}
        ListFooterComponent={listFooter}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        activationDistance={8}
      />
      <DocPagePicker visible={pickerOpen} onClose={() => setPickerOpen(false)} onAdd={addPicked} />
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: Spacing.gutter, paddingBottom: Spacing.xxl },
  input: { borderRadius: Radius.md, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md },
  addBar: { flexDirection: 'row', borderRadius: Radius.lg, paddingVertical: Spacing.md },
  addBtn: { flex: 1, alignItems: 'center', paddingVertical: Spacing.xs, minHeight: 44 },
  addIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.xs },
  addLabel: { fontWeight: '500' },
  addingLine: { marginTop: Spacing.md },
  hint: { marginTop: Spacing.xs, marginHorizontal: Spacing.xs },
});
