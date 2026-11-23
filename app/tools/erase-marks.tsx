// app/tools/erase-marks.tsx
// Whitens light pencil and pen marks by baking a high-contrast black-and-white
// filter into every page's pixels (lib/bake.ts). Bakes run from each page's
// pristine .orig copy, so the viewer's Undo can put every page back exactly as
// it was, its own earlier filter and adjustments included.
//
// Round 16: a strength (remembered in lib/tool-prefs.ts). On the Black &
// white filter Brightness moves the threshold (brighter = fewer dark pixels,
// so fainter marks go) and Contrast sets how hard edges are (lib/filters.ts);
// Standard is the +30 / +30 this tool always used.
//
// Before / After: a preview of a page as it is and as it will be, rendered
// with the same bake as Apply (lib/bake.ts bakeFilterPreview) for the chosen
// strength, so the result can be judged before anything changes.
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { PrimaryButton } from '@/components/primary-button';
import {
  NoDocumentsScreen,
  OptionList,
  ToolIntro,
  ToolNote,
  ToolProgress,
  ToolScreen,
  pageCountLabel,
  useImageAspect,
  useToolDocuments,
} from '@/components/tool-ui';
import { SegmentedControl } from '@/components/segmented-control';
import { useTheme } from '@/contexts/theme-context';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';
import { ToolDocPicker, useToolDoc } from '@/components/tool-doc';
import { SectionLabel } from '@/components/section-label';

import { eraseAdjustment, parseEraseStrength, type EraseStrength } from '@/lib/erase-strength';
import { readToolPrefs, TOOL_PREF_KEYS, writeToolPrefs } from '@/lib/tool-prefs';
import { useRememberedPrefs } from '@/components/use-remembered-prefs';
import { FilterBaker } from '@/components/filter-baker';
import { bakeFilterPreview, bakePage, invalidateDocPreviews } from '@/lib/bake';
import { notifyError, notifySuccess, selection } from '@/lib/haptics';
import type { Document, PageAdjustment, PageFilter } from '@/types/document';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { postViewerNotice } from '@/lib/viewer-notice';

const ERASE_FILTER: PageFilter = 'bw';

const STRENGTH_OPTIONS: { value: EraseStrength; label: string; detail: string }[] = [
  { value: 'light', label: 'Light', detail: 'Keeps faint print. Lifts only the lightest marks.' },
  { value: 'standard', label: 'Standard', detail: 'Pencil, highlighter and shadows go; text stays.' },
  { value: 'strong', label: 'Strong', detail: 'Also lifts darker marks. Thin or faint text may fade.' },
];

/** Puts every page back as it was before Erase marks (see run). */
async function undoErase(docId: string, before: { filter: PageFilter; adjustment: PageAdjustment | undefined }[]) {
  const results = await Promise.allSettled(before.map((b, i) => bakePage(docId, i, b.filter, b.adjustment)));
  invalidateDocPreviews(docId);
  if (results.some(r => r.status === 'rejected')) {
    notifyError();
    Alert.alert('Couldn’t undo on every page', 'Open Filters on a page that still looks black and white, and choose its filter again.');
    return;
  }
  postViewerNotice({ docId, message: 'Pages restored' });
}

/** Rendered previews, newest last: switching strength back and forth shows them at once. */
const previewCache = new Map<string, string>();
const PREVIEW_CACHE_SIZE = 6;
function rememberPreview(key: string, uri: string) {
  previewCache.delete(key);
  previewCache.set(key, uri);
  while (previewCache.size > PREVIEW_CACHE_SIZE) previewCache.delete(previewCache.keys().next().value!);
}

/** Tallest the preview may be, so the strength options stay in reach below it. */
const PREVIEW_MAX_H = 380;

/** A page as it is (Before) and as Erase marks would leave it (After). */
function ErasePreview({ doc, strength }: { doc: Document; strength: EraseStrength }) {
  const { colors } = useTheme();
  const pageCount = doc.pages.length;
  const [pageIndex, setPageIndex] = useState(0);
  const page = Math.min(pageIndex, Math.max(0, pageCount - 1));
  const [side, setSide] = useState<'before' | 'after'>('after');
  const [width, setWidth] = useState(0);
  const key = `${doc.id}:${doc.updatedAt}:${page}:${strength}`;
  const [after, setAfter] = useState<{ key: string; uri: string } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);

  useEffect(() => {
    const hit = previewCache.get(key);
    if (hit) {
      setAfter({ key, uri: hit });
      return;
    }
    let live = true;
    bakeFilterPreview(doc.id, page, ERASE_FILTER, eraseAdjustment(strength))
      .then(uri => {
        rememberPreview(key, uri);
        if (live) setAfter({ key, uri });
      })
      .catch(() => { if (live) setFailedKey(key); });
    return () => { live = false; };
  }, [key, doc.id, page, strength]);

  const beforeUri = doc.pages[page] ? `${doc.pages[page].split('?')[0]}?v=${doc.updatedAt}` : null;
  const aspect = useImageAspect(beforeUri);
  const afterUri = after?.key === key ? after.uri : null;
  const failed = failedKey === key;
  const h = Math.min(PREVIEW_MAX_H, Math.round(width * aspect));
  const w = Math.round(h / aspect);
  const shown = side === 'before' ? beforeUri : afterUri;

  const goTo = (i: number) => {
    if (i < 0 || i >= pageCount || i === page) return;
    setPageIndex(i);
    selection();
  };

  return (
    <View>
      <SectionLabel>Preview</SectionLabel>
      <SegmentedControl
        value={side}
        onChange={v => { setSide(v); selection(); }}
        options={[
          { value: 'before', label: 'Before' },
          { value: 'after', label: 'After' },
        ]}
      />
      <View
        style={[styles.previewArea, { backgroundColor: colors.card }]}
        onLayout={e => setWidth(Math.max(0, e.nativeEvent.layout.width - Spacing.md * 2))}
      >
        {width > 0 ? (
          <View style={[styles.previewPage, { width: w, height: h, backgroundColor: colors.paper, borderColor: colors.thumbBorder }]}>
            {shown ? (
              <Image
                source={{ uri: shown }}
                style={StyleSheet.absoluteFill}
                contentFit="fill"
                transition={0}
                accessibilityLabel={`Page ${page + 1}, ${side === 'before' ? 'as it is now' : 'with marks erased'}`}
              />
            ) : (
              <View style={[StyleSheet.absoluteFill, styles.center]}>
                {failed ? (
                  <Text style={[Type.footnote, styles.failed, { color: colors.muted }]}>Couldn’t make a preview. Erase marks still works.</Text>
                ) : (
                  <ActivityIndicator color={colors.muted} accessibilityLabel="Making the preview" />
                )}
              </View>
            )}
          </View>
        ) : null}
        {pageCount > 1 ? (
          <View style={styles.pager}>
            <Pressable
              onPress={() => goTo(page - 1)}
              disabled={page === 0}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Previous page"
              style={({ pressed }) => [styles.pageBtn, pressed && { opacity: 0.5 }]}
            >
              <Ionicons name="chevron-back" size={20} color={page === 0 ? colors.faint : colors.accent} />
            </Pressable>
            <Text style={[Type.subhead, { color: colors.text }]} accessibilityLiveRegion="polite">
              {`Page ${page + 1} of ${pageCount}`}
            </Text>
            <Pressable
              onPress={() => goTo(page + 1)}
              disabled={page >= pageCount - 1}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Next page"
              style={({ pressed }) => [styles.pageBtn, pressed && { opacity: 0.5 }]}
            >
              <Ionicons name="chevron-forward" size={20} color={page >= pageCount - 1 ? colors.faint : colors.accent} />
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

type ErasePrefs = { strength: EraseStrength };
const DEFAULT_ERASE_PREFS: ErasePrefs = { strength: 'standard' };
const loadErasePrefs = () => readToolPrefs(TOOL_PREF_KEYS.eraseMarks, o => ({ strength: parseEraseStrength(o) }));
const saveErasePrefs = (p: ErasePrefs) => writeToolPrefs(TOOL_PREF_KEYS.eraseMarks, p);

export default function EraseMarksScreen() {
  const router = useRouter();
  const { docs, loaded } = useToolDocuments();
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  // Remembered; a choice made before it loads wins (components/use-remembered-prefs.ts).
  const [{ strength }, setPrefs] = useRememberedPrefs(DEFAULT_ERASE_PREFS, loadErasePrefs, saveErasePrefs);
  const setStrength = (s: EraseStrength) => setPrefs({ strength: s });

  const { doc: selected, setDocId: setSelectedId, fixed, fromViewer } = useToolDoc(docs);
  const running = progress !== null;

  const run = async (doc: Document) => {
    const total = doc.pages.length;
    setProgress({ current: 0, total });
    // All pages are requested at once: the bake queue still runs them one at a
    // time, but each is tracked from the start, so an edit made meanwhile
    // re-targets the rest instead of baking stale page numbers.
    let done = 0;
    const results = await Promise.allSettled(
      doc.pages.map((_, i) =>
        bakePage(doc.id, i, ERASE_FILTER, eraseAdjustment(strength)).finally(() => {
          done++;
          setProgress({ current: done, total });
        }),
      ),
    );
    const failed = results.filter(r => r.status === 'rejected' || r.value === false).length;
    invalidateDocPreviews(doc.id);
    setProgress(null);

    if (failed === total) {
      notifyError();
      Alert.alert('Couldn’t clean up this document', 'No pages were changed. Try again.');
      return;
    }
    notifySuccess();
    // The viewer shows the toast, with Undo: it covers the app-wide toast host.
    // Undo re-bakes every page from its pristine .orig with the filter and
    // adjustments it had before, so earlier edits come back too (choosing
    // Original in Filters would have wiped those).
    const before = doc.pages.map((_, i) => ({ filter: doc.filters?.[i] ?? 'original', adjustment: doc.adjustments?.[i] }));
    postViewerNotice({
      docId: doc.id,
      message: failed ? `Cleaned ${total - failed} of ${total} pages` : 'Marks erased',
      action: { label: 'Undo', onPress: () => { void undoErase(doc.id, before); } },
    });
    // Opened from the viewer, go back to it rather than stacking a second one.
    navigateWhenUnlocked(() => {
      if (fromViewer) router.dismissTo({ pathname: '/viewer', params: { id: doc.id } });
      else router.replace({ pathname: '/viewer', params: { id: doc.id } });
    });
  };

  const handleApply = () => {
    if (!selected || running) return;
    run(selected);
  };

  if (loaded && docs.length === 0) {
    return (
      <NoDocumentsScreen
        toolTitle="Erase marks"
        icon="color-wand-outline"
        subtitle="Erase marks cleans up scanned pages. Scan or import a document first."
      />
    );
  }

  return (
    <ToolScreen
      title="Erase marks"
      footer={
        <>
          {progress ? (
            <ToolProgress
              label={`Cleaning page ${Math.min(progress.current + 1, progress.total)} of ${progress.total}…`}
              current={progress.current}
              total={progress.total}
            />
          ) : null}
          <PrimaryButton
            title={selected ? `Erase marks on ${pageCountLabel(selected.pages.length)}` : 'Erase marks'}
            onPress={handleApply}
            disabled={!selected}
            loading={running}
          />
        </>
      }
    >
      {/* Presented over the viewer: a baker underneath would never run (see FilterBaker). */}
      {fromViewer ? <FilterBaker /> : null}
      <ToolIntro
        icon="color-wand-outline"
        title="Remove light marks"
        text="Turns pages into crisp black and white and lifts faint pencil, highlighter and shadow marks."
      />
      <ToolDocPicker
        docs={docs}
        doc={selected}
        fixed={fixed}
        disabled={running}
        onPick={d => setSelectedId(d.id)}
      />
      <View pointerEvents={running ? 'none' : 'auto'} collapsable={false}>
        {selected && selected.pages.length > 0 ? <ErasePreview doc={selected} strength={strength} /> : null}
        <SectionLabel>Strength</SectionLabel>
        <OptionList options={STRENGTH_OPTIONS} value={strength} onChange={setStrength} />
      </View>
      <ToolNote>
        {'This changes the document itself, replacing any filters its pages have. Compare Before and After first; you can also undo it right\u00A0after.'}
      </ToolNote>
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  previewArea: { marginTop: Spacing.md, borderRadius: Radius.md, padding: Spacing.md, alignItems: 'center' },
  previewPage: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  center: { alignItems: 'center', justifyContent: 'center', padding: Spacing.lg },
  failed: { textAlign: 'center' },
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.md, marginTop: Spacing.sm },
  pageBtn: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
});
