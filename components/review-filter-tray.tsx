// components/review-filter-tray.tsx
// The capture review's filter picker (components/capture-review.tsx): the
// same nine filters, names, captions and preview tiles as the viewer's Filters
// panel (components/page-actions-sheet.tsx), applied before the scan is saved.
// A choice applies to every page by default; "This page" gives the page on
// screen a filter of its own. The choice is saved with the pages
// (lib/review-filter.ts). Always-dark chrome, like the review.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Image, LayoutChangeEvent, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { PageFilter } from '@/types/document';
import type { CapturedPage } from '@/lib/capture-session';
import { PREVIEW_FILTERS } from '@/lib/bake';
import { PREVIEW_ASPECT } from '@/lib/bake-html';
import {
  chooseReviewFilter,
  clearReviewPreviews,
  filterInSnapshot,
  getReviewFilterSnapshot,
  reviewPagePreview,
  reviewTilePreviews,
  subscribeReviewFilters,
  type ReviewFilterSnapshot,
} from '@/lib/review-filter';
import { FILTER_CAPTIONS, FILTER_LABELS } from '@/components/page-actions-sheet';
import { useTheme } from '@/contexts/theme-context';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

const TILE_W = 80;
const TILE_GAP = Spacing.sm;
const RING = 4;
const PREVIEW_W = TILE_W - RING * 2;
const PREVIEW_H = Math.min(80, PREVIEW_W * PREVIEW_ASPECT);

/**
 * The review's filter choice; null when the picker is off (lib/review-filter.ts).
 * Rendering reads filters from this snapshot (filterInSnapshot), never from
 * the module directly: the React Compiler memoizes plain calls.
 */
export function useReviewFilters(): ReviewFilterSnapshot | null {
  return useSyncExternalStore(subscribeReviewFilters, getReviewFilterSnapshot, getReviewFilterSnapshot);
}

/**
 * The image each page shows in the review: its preview with its chosen
 * filter, once rendered; the plain preview until then (`pending` lists the
 * pages still rendering).
 */
export function useFilteredPreviews(pages: CapturedPage[], enabled: boolean): { uris: Map<string, string>; pending: Set<string> } {
  const snap = useReviewFilters();
  const [done, setDone] = useState<Map<string, string>>(new Map());
  const want = pages
    .filter(p => p.previewUri)
    .map(p => ({ key: p.key, src: p.previewUri!, filter: filterInSnapshot(snap, p.sourceUri) ?? 'original' }));
  const wantKey = want.map(w => `${w.key}|${w.src}|${w.filter}`).join(',');
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      for (const w of want) {
        const id = `${w.src}|${w.filter}`;
        try {
          const uri = await reviewPagePreview(w.src, w.filter);
          if (cancelled) return;
          setDone(prev => (prev.get(id) === uri ? prev : new Map(prev).set(id, uri)));
        } catch {
          // The plain preview stays; the filter is still applied when saved.
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantKey, enabled]);
  useEffect(() => () => clearReviewPreviews(), []);
  const uris = new Map<string, string>();
  const pending = new Set<string>();
  for (const w of want) {
    const hit = done.get(`${w.src}|${w.filter}`);
    if (hit) uris.set(w.key, hit);
    else if (enabled && w.filter !== 'original') pending.add(w.key);
  }
  return { uris, pending };
}

export function ReviewFilterTray({
  page,
  pageCount,
  bottomInset,
  onDone,
}: {
  /** The page on screen. */
  page: CapturedPage | undefined;
  pageCount: number;
  bottomInset: number;
  onDone: () => void;
}) {
  const { colors } = useTheme();
  const snap = useReviewFilters();
  const [onlyThis, setOnlyThis] = useState(false);
  const [tiles, setTiles] = useState<string[] | null>(null);
  const stripRef = useRef<ScrollView>(null);
  const src = page?.previewUri ?? null;
  const current: PageFilter = page ? filterInSnapshot(snap, page.sourceUri) ?? 'original' : 'original';
  const own = !!page && !!snap?.perPage.has(page.sourceUri.split('?')[0]);

  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    setTiles(null);
    reviewTilePreviews(src)
      .then(urls => { if (!cancelled) setTiles(urls); })
      .catch(() => { if (!cancelled) setTiles(null); });
    return () => { cancelled = true; };
  }, [src]);

  // A page with its own filter opens on "This page".
  useEffect(() => { setOnlyThis(own); }, [page?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const onStripLayout = (e: LayoutChangeEvent) => {
    const viewW = e.nativeEvent.layout.width;
    const index = Math.max(0, PREVIEW_FILTERS.indexOf(current));
    const x = Spacing.gutter + index * (TILE_W + TILE_GAP) - (viewW - TILE_W) / 2;
    if (x > 0) stripRef.current?.scrollTo({ x, animated: false });
  };

  const scopes: { key: 'all' | 'one'; label: string }[] = [
    { key: 'all', label: pageCount === 2 ? 'Both pages' : 'All pages' },
    { key: 'one', label: 'This page' },
  ];

  return (
    <View style={[styles.tray, { backgroundColor: colors.chromeRaised, paddingBottom: Math.max(bottomInset, Spacing.md) }]}>
      <View style={styles.topRow}>
        <View style={styles.side}>
          {pageCount > 1 ? (
            <View style={[styles.segment, { backgroundColor: colors.chrome }]} accessibilityRole="tablist">
              {scopes.map(s => {
                const active = (s.key === 'one') === onlyThis;
                return (
                  <Pressable
                    key={s.key}
                    onPress={() => setOnlyThis(s.key === 'one')}
                    hitSlop={4}
                    style={[styles.segmentBtn, active && { backgroundColor: colors.chromeBorder }]}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={s.key === 'all' ? 'Apply filters to every page' : 'Apply filters to this page only'}
                  >
                    <Text
                      style={[Type.footnote, styles.segmentText, { color: active ? colors.chromeText : colors.chromeMuted }]}
                      numberOfLines={1}
                      maxFontSizeMultiplier={1.2}
                    >
                      {s.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : (
            <Text style={[Type.subhead, styles.title, { color: colors.chromeText }]}>Filter</Text>
          )}
        </View>
        <Pressable
          onPress={onDone}
          hitSlop={8}
          style={({ pressed }) => [styles.doneBtn, pressed && { opacity: 0.6 }]}
          accessibilityRole="button"
          accessibilityLabel="Done choosing a filter"
        >
          <Text style={[Type.headline, { color: colors.chromeAccent }]}>Done</Text>
        </Pressable>
      </View>

      <ScrollView
        ref={stripRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        onLayout={onStripLayout}
      >
        {PREVIEW_FILTERS.map((key, i) => {
          const active = current === key;
          const tile = tiles?.[i];
          return (
            <Pressable
              key={key}
              style={styles.tile}
              onPress={() => chooseReviewFilter(key, onlyThis && page ? page.sourceUri : undefined)}
              accessibilityRole="button"
              accessibilityLabel={`${FILTER_LABELS[key]} filter, ${FILTER_CAPTIONS[key].toLowerCase()}`}
              accessibilityState={{ selected: active }}
            >
              <View style={[styles.ring, { borderColor: active ? colors.chromeAccent : 'transparent' }]}>
                <View style={[styles.preview, { backgroundColor: colors.paper }]}>
                  {tile ? (
                    <Image source={{ uri: tile }} style={styles.previewImg} resizeMode="stretch" />
                  ) : src ? (
                    <Image source={{ uri: src }} style={styles.previewImg} resizeMode="cover" />
                  ) : null}
                </View>
                {!tile && (
                  <View style={styles.busy} pointerEvents="none">
                    <ActivityIndicator size="small" color={colors.chromeText} />
                  </View>
                )}
              </View>
              <Text
                numberOfLines={1}
                maxFontSizeMultiplier={1.15}
                style={[Type.caption, styles.label, { color: active ? colors.chromeAccent : colors.chromeText }, active && styles.labelActive]}
              >
                {FILTER_LABELS[key]}
              </Text>
              <Text numberOfLines={1} maxFontSizeMultiplier={1.15} style={[Type.caption, styles.caption, { color: colors.chromeMuted }]}>
                {FILTER_CAPTIONS[key]}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  tray: { paddingTop: Spacing.sm },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.gutter,
    minHeight: HIT,
    marginBottom: Spacing.xs,
  },
  side: { flexShrink: 1 },
  title: { fontWeight: '600' },
  // The viewer's Filters / Adjust segment (components/page-actions-sheet.tsx).
  segment: { flexDirection: 'row', borderRadius: Radius.sm, padding: 2 },
  segmentBtn: {
    minWidth: 76,
    minHeight: 32,
    paddingHorizontal: Spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.sm - 2,
  },
  segmentText: { fontWeight: '600' },
  doneBtn: { minHeight: HIT, minWidth: HIT, alignItems: 'flex-end', justifyContent: 'center' },
  row: { paddingHorizontal: Spacing.gutter, gap: TILE_GAP, paddingTop: Spacing.xs },
  tile: { width: TILE_W, alignItems: 'center' },
  ring: { borderWidth: 2, borderRadius: Radius.sm + 2, padding: 2 },
  preview: { width: PREVIEW_W, height: PREVIEW_H, borderRadius: Radius.sm - 2, overflow: 'hidden' },
  previewImg: { width: PREVIEW_W, height: PREVIEW_H },
  busy: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  label: { marginTop: Spacing.xs + 2 },
  labelActive: { fontWeight: '600' },
  caption: { marginTop: 1 },
});
