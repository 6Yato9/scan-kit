// components/page-actions-sheet.tsx
// The viewer's inline edit panel: filters and brightness / contrast /
// saturation for the current page.
//
// It is NOT a modal sheet. It takes the place of the viewer's toolbar and
// thumbnail strip, so the page above shrinks to fit and stays fully visible
// while you adjust it (a sheet used to cover half the page). Being inline also
// means nothing native has to wait for it to dismiss before Crop, Mark up or
// a share sheet can open.
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import { PageFilter, PageAdjustment } from '@/types/document';
import { bakePreviews, PREVIEW_FILTERS } from '@/lib/bake';
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

export type EditTab = 'filters' | 'adjust';

const DEFAULT_ADJ: PageAdjustment = { brightness: 0, contrast: 0, saturation: 0 };
const isDefault = (a: PageAdjustment) => a.brightness === 0 && a.contrast === 0 && a.saturation === 0;

/** Fixed content height so switching tabs never makes the page above jump. */
const CONTENT_H = 150;

/**
 * Filter tiles show a zoomed-in crop of the page (the upper middle, where a
 * title or the first lines usually are) rather than the whole page shrunk to a
 * stamp: at this size four whole-page thumbnails look identical, while text
 * at reading size makes Grayscale vs Black & white vs Enhanced obvious.
 */
const TILE_ZOOM = 2.4;
/** Centre of the crop, as a fraction of the page height. */
const TILE_FOCUS_Y = 0.25;

/** A crop of `uri` filling a tile of `w`×`h`, zoomed in on the upper middle of the page. */
function CropImage({ uri, w, h, aspect, bg }: { uri: string; w: number; h: number; aspect: number; bg: string }) {
  if (!w || !h) return null;
  const imgW = w * TILE_ZOOM;
  const imgH = imgW * aspect;
  const left = -(imgW - w) / 2;
  const top = -Math.max(0, Math.min(imgH * TILE_FOCUS_Y - h / 2, imgH - h));
  return (
    <Image
      source={{ uri }}
      style={{ position: 'absolute', width: imgW, height: imgH, left, top, backgroundColor: bg }}
      resizeMode="stretch"
    />
  );
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
  const [tile, setTile] = useState({ w: 0, h: 0 });
  const [aspect, setAspect] = useState(1.3);

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

  // The crop needs the page's shape (h / w).
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
    const { width, height } = e.nativeEvent.layout;
    if (Math.abs(width - tile.w) > 0.5 || Math.abs(height - tile.h) > 0.5) setTile({ w: width, h: height });
  };

  // Left of the tabs: the one secondary action that fits the current tab.
  const secondary =
    tab === 'filters'
      ? pageCount > 1 && onApplyToAll
        ? { label: 'Apply to all', a11y: `Apply ${FILTER_LABELS[filter]} to all ${pageCount} pages`, onPress: onApplyToAll, disabled: false }
        : null
      : { label: 'Reset', a11y: 'Reset adjustments', onPress: () => { onAdjust(DEFAULT_ADJ); onAdjustCommit(); }, disabled: isDefault(adj) };

  return (
    <View style={[styles.panel, { backgroundColor: colors.chromeRaised, paddingBottom: bottomInset + Spacing.sm }]}>
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
            onPress={onDone}
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
                  onPress={() => onFilter(key)}
                  accessibilityRole="button"
                  accessibilityLabel={`${FILTER_LABELS[key]} filter`}
                  accessibilityState={{ selected: active }}
                >
                  <View style={[styles.previewRing, { borderColor: active ? colors.chromeAccent : 'transparent' }]}>
                    <View style={[styles.preview, { backgroundColor: colors.paper }]} onLayout={i === 0 ? onTileLayout : undefined}>
                      <CropImage uri={preview ?? fallback} w={tile.w} h={tile.h} aspect={aspect} bg={colors.paper} />
                    </View>
                    {!preview && (
                      <View style={styles.previewBusy} pointerEvents="none">
                        <ActivityIndicator size="small" color={colors.chromeText} />
                      </View>
                    )}
                  </View>
                  <Text
                    numberOfLines={1}
                    maxFontSizeMultiplier={1.15}
                    style={[
                      Type.caption,
                      styles.filterLabel,
                      { color: active ? colors.chromeAccent : colors.chromeMuted },
                      active && styles.filterLabelActive,
                    ]}
                  >
                    {FILTER_LABELS[key]}
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
            <ChromeSlider
              label="Saturation"
              value={adj.saturation}
              onValueChange={v => onAdjust({ ...adj, saturation: v })}
              onSlidingComplete={onAdjustCommit}
            />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
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
  previewRing: {
    width: '100%',
    borderRadius: Radius.sm + 2,
    borderWidth: 2,
    padding: 2,
  },
  preview: { width: '100%', aspectRatio: 0.78, borderRadius: Radius.sm - 2, overflow: 'hidden' },
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
  adjust: { gap: Spacing.xxs },
});
