// components/page-actions-sheet.tsx
// The viewer's inline edit panel: filters and brightness / contrast /
// saturation for the current page.
//
// It is NOT a modal sheet. It takes the place of the viewer's toolbar and
// thumbnail strip, so the page above shrinks to fit and stays fully visible
// while you adjust it (a sheet used to cover half the page). Being inline also
// means nothing native has to wait for it to dismiss before Crop, Mark up or
// a share sheet can open.
//
// The panel is taller than the toolbar and strip it replaces, so the page has
// to get smaller. That happens as one eased motion, never a jump: the panel
// mounts at exactly the height of what it replaces and grows from there, and
// Done shrinks it back to that height before the toolbar returns, so the page
// grows back just as smoothly. (A Reanimated height: it updates the layout
// every frame, so the page above resizes with it. LayoutAnimation is not
// enabled on iOS with the new architecture.)
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, ReduceMotion, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { PageFilter, PageAdjustment } from '@/types/document';
import { bakePreviews, PREVIEW_FILTERS } from '@/lib/bake';
import { PREVIEW_ASPECT } from '@/lib/bake-html';
import { ChromeSlider } from '@/components/chrome-slider';
import { useTheme } from '@/contexts/theme-context';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

/** Display names, shared with Scan Settings' default-filter picker. */
export const FILTER_LABELS: Record<PageFilter, string> = {
  original: 'Original',
  grayscale: 'Grayscale',
  bw: 'Black & white',
  enhanced: 'Enhanced',
};

/**
 * One-line "what it does" under each filter name, so Enhanced and Grayscale
 * can be told apart even on a black-and-white page where their tiles look
 * alike. Shared with Scan settings.
 */
export const FILTER_CAPTIONS: Record<PageFilter, string> = {
  original: 'As captured',
  enhanced: 'Keeps color',
  grayscale: 'No color',
  bw: 'Sharpest text',
};

/** Filters whose output has no colour, so the Saturation slider does nothing. */
const NO_COLOR: PageFilter[] = ['grayscale', 'bw'];

export type EditTab = 'filters' | 'adjust';

const DEFAULT_ADJ: PageAdjustment = { brightness: 0, contrast: 0, saturation: 0 };
const isDefault = (a: PageAdjustment) => a.brightness === 0 && a.contrast === 0 && a.saturation === 0;

/** Fixed content height so switching tabs never makes the page above jump. */
const CONTENT_H = 150;

/**
 * Height of the viewer's toolbar (components/viewer-toolbar.tsx: 8 + 56 + 4 and
 * a hairline) plus its thumbnail strip (components/thumbnail-strip.tsx: 12 +
 * 64pt thumbnails + 4 + 13pt numbers, then the home-indicator padding): the
 * height the panel opens from, so the page starts exactly where it was.
 */
export function replacedBarsHeight(bottomInset: number): number {
  const toolbar = Spacing.sm + HIT + 12 + Spacing.xs + StyleSheet.hairlineWidth;
  const strip = Spacing.md + 64 + Spacing.xs + 13 + Math.max(Spacing.sm, bottomInset - Spacing.md);
  return toolbar + strip;
}

/** The panel's full height: top row, fixed content, home-indicator padding. */
export function panelHeight(bottomInset: number): number {
  return Spacing.sm + HIT + Spacing.sm + CONTENT_H + bottomInset + Spacing.sm;
}

/** One eased resize of the page above, opening and on Done. Reduce Motion: instant. */
const PANEL_MOTION = { duration: 260, easing: Easing.bezier(0.25, 0.1, 0.25, 1), reduceMotion: ReduceMotion.System };

/**
 * Filter tiles show the top of the page's content (title and first lines)
 * across its full width, rendered by lib/bake-html.ts buildPreviewHtml at
 * PREVIEW_ASPECT. That is where the filters differ: ink weight, colour, grey.
 * A whole-page tile made Enhanced, Grayscale and Black & white look like the
 * same white sheet.
 */
const PREVIEW_MAX_H = 80;
/** Ring border + gap around the preview in a tile. */
const RING = 4;

/** The preview box inside a tile of width `tileW`. */
function fitPreview(tileW: number): { w: number; h: number } {
  const w = Math.min(Math.max(0, tileW - RING * 2), PREVIEW_MAX_H / PREVIEW_ASPECT);
  return { w, h: w * PREVIEW_ASPECT };
}

type Props = {
  tab: EditTab;
  onTabChange: (tab: EditTab) => void;
  uri: string;
  docId: string;
  pageIndex: number;
  pageCount: number;
  filter: PageFilter;
  adjustment?: PageAdjustment;
  /** Cache-bust for the fallback tile image while previews render. */
  cacheBust?: number;
  onFilter: (filter: PageFilter) => void;
  /** Applies the current page's filter to every page. Omit to hide the button. */
  onApplyToAll?: () => void;
  onAdjust: (adj: PageAdjustment) => void;
  /** The finger lifted off a slider: commit the adjustment now. */
  onAdjustCommit: () => void;
  onDone: () => void;
  bottomInset: number;
};

export function PageEditPanel({
  tab,
  onTabChange,
  uri,
  docId,
  pageIndex,
  pageCount,
  filter,
  adjustment,
  cacheBust,
  onFilter,
  onApplyToAll,
  onAdjust,
  onAdjustCommit,
  onDone,
  bottomInset,
}: Props) {
  const { colors } = useTheme();
  const [previews, setPreviews] = useState<string[] | null>(null);
  const [tileW, setTileW] = useState(0);
  const [aspect, setAspect] = useState(1.3);
  // Mounted at the height of the bars it replaces, then grown, so the page
  // above shrinks smoothly instead of jumping.
  const closedH = replacedBarsHeight(bottomInset);
  const height = useSharedValue(closedH);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    height.value = withTiming(panelHeight(bottomInset), PANEL_MOTION);
    // Opening runs once; a changed inset (rotation) re-targets the height.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bottomInset]);
  const heightStyle = useAnimatedStyle(() => ({ height: height.value }));
  // Done: back down to the bars' height first, then the toolbar and strip
  // take its place at the same height and the page is full size again.
  const done = () => {
    if (closing) return;
    setClosing(true);
    height.value = withTiming(closedH, PANEL_MOTION, finished => {
      if (finished) runOnJS(onDone)();
    });
  };

  // Real previews: each tile is the page rendered through that filter (RN's
  // `filter` style can't do this on iOS). One WebView pass renders all four.
  useEffect(() => {
    if (tab !== 'filters') return;
    let cancelled = false;
    setPreviews(null);
    bakePreviews(docId, pageIndex)
      .then(urls => { if (!cancelled) setPreviews(urls); })
      .catch(() => { if (!cancelled) setPreviews(null); });
    return () => { cancelled = true; };
  }, [tab, docId, pageIndex]);

  const adj = adjustment ?? DEFAULT_ADJ;
  const fallback = cacheBust ? `${uri}?v=${cacheBust}` : uri;

  // The tiles take the page's shape (h / w).
  useEffect(() => {
    let cancelled = false;
    Image.getSize(
      fallback,
      (w, h) => { if (!cancelled && w > 0) setAspect(h / w); },
      () => {},
    );
    return () => { cancelled = true; };
  }, [fallback]);

  const onTileLayout = (e: LayoutChangeEvent) => {
    const { width } = e.nativeEvent.layout;
    if (Math.abs(width - tileW) > 0.5) setTileW(width);
  };
  const box = fitPreview(tileW);
  // Until the previews arrive, the tile shows the unfiltered page's top at
  // full width (the same framing, minus the margin trim).
  const pageH = box.w * Math.max(0.4, Math.min(3, aspect));
  const noColor = NO_COLOR.includes(filter);

  // Left of the tabs: the one secondary action that fits the current tab.
  const secondary =
    tab === 'filters'
      ? pageCount > 1 && onApplyToAll
        ? { label: 'Apply to all', a11y: `Apply ${FILTER_LABELS[filter]} to all ${pageCount} pages`, onPress: onApplyToAll, disabled: false }
        : null
      : { label: 'Reset', a11y: 'Reset adjustments', onPress: () => { onAdjust(DEFAULT_ADJ); onAdjustCommit(); }, disabled: isDefault(adj) };

  return (
    <Animated.View
      style={[
        styles.panel,
        { backgroundColor: colors.chromeRaised, paddingBottom: bottomInset + Spacing.sm },
        heightStyle,
      ]}
    >
      <View style={styles.topRow}>
        <View style={styles.side}>
          {secondary && (
            // A real button (filled pill), not a label: "Apply to all" is the
            // only way to give a whole document one look.
            <Pressable
              onPress={secondary.onPress}
              disabled={secondary.disabled}
              hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
              style={({ pressed }) => [
                styles.pillBtn,
                { backgroundColor: colors.chromeBorder },
                (pressed || secondary.disabled) && { opacity: secondary.disabled ? 0.4 : 0.6 },
              ]}
              accessibilityRole="button"
              accessibilityLabel={secondary.a11y}
              accessibilityState={{ disabled: secondary.disabled }}
            >
              <Text
                style={[Type.footnote, styles.pillText, { color: colors.chromeText }]}
                numberOfLines={1}
                maxFontSizeMultiplier={1.2}
              >
                {secondary.label}
              </Text>
            </Pressable>
          )}
        </View>

        <View style={[styles.segment, { backgroundColor: colors.chrome }]} accessibilityRole="tablist">
          {(['filters', 'adjust'] as EditTab[]).map(t => {
            const active = tab === t;
            return (
              <Pressable
                key={t}
                style={[styles.segmentBtn, active && { backgroundColor: colors.chromeBorder }]}
                onPress={() => onTabChange(t)}
                hitSlop={4}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
              >
                <Text style={[Type.footnote, styles.segmentText, { color: active ? colors.chromeText : colors.chromeMuted }]}>
                  {t === 'filters' ? 'Filters' : 'Adjust'}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={[styles.side, styles.sideRight]}>
          <Pressable
            onPress={done}
            hitSlop={8}
            style={({ pressed }) => [styles.textBtn, pressed && { opacity: 0.6 }]}
            accessibilityRole="button"
            accessibilityLabel="Done editing"
          >
            <Text style={[Type.headline, { color: colors.chromeAccent }]}>Done</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.content}>
        {tab === 'filters' ? (
          <View style={styles.filterRow}>
            {PREVIEW_FILTERS.map((key, i) => {
              const active = filter === key;
              const preview = previews?.[i];
              return (
                <Pressable
                  key={key}
                  style={styles.filterTile}
                  onLayout={i === 0 ? onTileLayout : undefined}
                  onPress={() => onFilter(key)}
                  accessibilityRole="button"
                  accessibilityLabel={`${FILTER_LABELS[key]} filter, ${FILTER_CAPTIONS[key].toLowerCase()}`}
                  accessibilityState={{ selected: active }}
                >
                  <View style={styles.previewSlot}>
                    {box.w > 0 && (
                      <View style={[styles.previewRing, { borderColor: active ? colors.chromeAccent : 'transparent' }]}>
                        <View style={[styles.preview, { width: box.w, height: box.h, backgroundColor: colors.paper }]}>
                          {preview ? (
                            <Image source={{ uri: preview }} style={{ width: box.w, height: box.h }} resizeMode="stretch" />
                          ) : (
                            <Image source={{ uri: fallback }} style={{ width: box.w, height: pageH }} resizeMode="stretch" />
                          )}
                        </View>
                        {!preview && (
                          <View style={styles.previewBusy} pointerEvents="none">
                            <ActivityIndicator size="small" color={colors.chromeText} />
                          </View>
                        )}
                      </View>
                    )}
                  </View>
                  <Text
                    numberOfLines={1}
                    maxFontSizeMultiplier={1.15}
                    style={[
                      Type.caption,
                      styles.filterLabel,
                      { color: active ? colors.chromeAccent : colors.chromeText },
                      active && styles.filterLabelActive,
                    ]}
                  >
                    {FILTER_LABELS[key]}
                  </Text>
                  <Text
                    numberOfLines={1}
                    maxFontSizeMultiplier={1.15}
                    style={[Type.caption, styles.filterCaption, { color: colors.chromeMuted }]}
                  >
                    {FILTER_CAPTIONS[key]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <View style={styles.adjust}>
            <ChromeSlider
              label="Brightness"
              value={adj.brightness}
              onValueChange={v => onAdjust({ ...adj, brightness: v })}
              onSlidingComplete={onAdjustCommit}
            />
            <ChromeSlider
              label="Contrast"
              value={adj.contrast}
              onValueChange={v => onAdjust({ ...adj, contrast: v })}
              onSlidingComplete={onAdjustCommit}
            />
            {noColor ? (
              // Grayscale and Black & white have no colour to saturate; the
              // slider would move and change nothing.
              <View style={styles.noSaturation} accessible accessibilityLabel={`Saturation is not available with ${FILTER_LABELS[filter]}`}>
                <Text style={[Type.footnote, styles.noSaturationLabel, { color: colors.chromeMuted }]}>Saturation</Text>
                <Text style={[Type.footnote, styles.noSaturationNote, { color: colors.chromeMuted }]} numberOfLines={1}>
                  {`No color in ${FILTER_LABELS[filter]}`}
                </Text>
              </View>
            ) : (
              <ChromeSlider
                label="Saturation"
                value={adj.saturation}
                onValueChange={v => onAdjust({ ...adj, saturation: v })}
                onSlidingComplete={onAdjustCommit}
              />
            )}
          </View>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  panel: {
    // Clips the content while the height animates.
    overflow: 'hidden',
    paddingTop: Spacing.sm,
    paddingHorizontal: Spacing.gutter,
  },
  topRow: { flexDirection: 'row', alignItems: 'center', minHeight: HIT, marginBottom: Spacing.sm },
  side: { flex: 1, flexDirection: 'row' },
  sideRight: { justifyContent: 'flex-end' },
  textBtn: { minHeight: HIT, justifyContent: 'center' },
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
  content: { height: CONTENT_H, justifyContent: 'center' },
  filterRow: { flexDirection: 'row', gap: Spacing.sm },
  filterTile: { flex: 1, alignItems: 'center' },
  previewSlot: { height: PREVIEW_MAX_H + RING * 2, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  previewRing: {
    borderRadius: Radius.sm + 2,
    borderWidth: 2,
    padding: 2,
  },
  preview: { borderRadius: Radius.sm - 2, overflow: 'hidden' },
  pillBtn: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.pill,
  },
  pillText: { fontWeight: '600' },
  previewBusy: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  filterLabel: { marginTop: Spacing.xs + 2 },
  filterLabelActive: { fontWeight: '600' },
  filterCaption: { marginTop: 1 },
  // Same row geometry as a ChromeSlider (label column, then the rest).
  noSaturation: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, minHeight: HIT },
  noSaturationLabel: { width: 84, fontWeight: '500' },
  noSaturationNote: { flex: 1 },
  adjust: { gap: Spacing.xxs },
});
