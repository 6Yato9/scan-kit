// components/capture-review.tsx
// The camera's review step (app/camera.tsx): every captured page as it will
// be saved — its crop applied — before anything is stored. Swipe between
// pages or pick one in the strip (touch and hold to drag it to a new place);
// Crop opens the four-corner editor on the WHOLE photo, so a crop that cut
// into the page can be widened; Rotate turns the page; Retake goes back to
// the camera for this page; Delete drops it. Always-dark chrome.
import { useCallback, useEffect, useRef, type ComponentProps } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { HeaderIconButton, HeaderTextButton, ScreenHeader } from '@/components/screen-header';
import { ThumbnailStrip } from '@/components/thumbnail-strip';
import { HIT, Spacing, Type } from '@/lib/theme';
import type { CapturedPage } from '@/lib/capture-session';

type IconName = ComponentProps<typeof Ionicons>['name'];

type Props = {
  pages: CapturedPage[];
  index: number;
  onSelect: (index: number) => void;
  /** Back to the camera to capture more (or, at the page limit, to retake this one). */
  onBack: () => void;
  onSave: () => void;
  doneLabel: string;
  onCrop: (index: number) => void;
  onRotate: (index: number) => void;
  onRetake: (index: number) => void;
  onDelete: (index: number) => void;
  onReorder: (from: number, to: number) => void;
  /** More pages may be captured (no page limit reached). */
  canAddMore: boolean;
  /** Pages whose preview is being rendered again (after a crop or turn). */
  rendering: ReadonlySet<string>;
};

export function CaptureReview({
  pages,
  index,
  onSelect,
  onBack,
  onSave,
  doneLabel,
  onCrop,
  onRotate,
  onRetake,
  onDelete,
  onReorder,
  canAddMore,
  rendering,
}: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const listRef = useRef<FlatList<CapturedPage>>(null);
  const current = pages[index];

  // The strip (or a deletion) picked a page: bring it into view.
  const shown = useRef(index);
  useEffect(() => {
    if (shown.current === index || index >= pages.length) return;
    shown.current = index;
    listRef.current?.scrollToIndex({ index, animated: true });
  }, [index, pages.length]);

  const onScrollEnd = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / Math.max(1, width));
    if (i !== shown.current && i >= 0 && i < pages.length) {
      shown.current = i;
      onSelect(i);
    }
  }, [width, pages.length, onSelect]);

  const count = pages.length;
  const title = count === 1 ? '1 page' : `${count} pages`;
  const caption = current
    ? `${count > 1 ? `Page ${index + 1} of ${count}` : 'Page 1'}${current.detected ? '' : ' · No edges found, whole photo kept'}`
    : '';

  const actions: { key: string; icon: IconName; label: string; a11y: string; onPress: () => void; flip?: boolean }[] = [
    { key: 'crop', icon: 'crop-outline', label: 'Crop', a11y: 'Adjust the crop', onPress: () => onCrop(index) },
    { key: 'rotate', icon: 'refresh-outline', label: 'Rotate', a11y: 'Rotate page clockwise', onPress: () => onRotate(index) },
    { key: 'retake', icon: 'camera-outline', label: 'Retake', a11y: 'Retake this page', onPress: () => onRetake(index) },
    { key: 'delete', icon: 'trash-outline', label: 'Delete', a11y: 'Delete this page', onPress: () => onDelete(index) },
  ];

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.chrome }]}>
      <ScreenHeader
        dark
        title={title}
        left={<HeaderIconButton icon="chevron-back" size={28} label="Back to camera" color={colors.chromeText} onPress={onBack} />}
        right={<HeaderTextButton title={doneLabel} emphasis color={colors.chromeAccent} onPress={onSave} disabled={!count} />}
      />

      <FlatList
        ref={listRef}
        style={styles.pager}
        data={pages}
        keyExtractor={p => p.key}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={Math.min(index, Math.max(0, count - 1))}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        onMomentumScrollEnd={onScrollEnd}
        renderItem={({ item, index: i }) => (
          <View style={[styles.page, { width }]}>
            {item.previewUri ? (
              <Image
                source={{ uri: item.previewUri }}
                style={styles.pageImage}
                resizeMode="contain"
                accessibilityLabel={`Page ${i + 1}`}
              />
            ) : null}
            {(!item.previewUri || rendering.has(item.key)) && (
              <ActivityIndicator style={StyleSheet.absoluteFill} color={colors.chromeMuted} accessibilityLabel="Preparing page" />
            )}
          </View>
        )}
      />

      <Text style={[Type.footnote, styles.caption, { color: colors.chromeMuted }]} numberOfLines={1} accessibilityLiveRegion="polite">
        {caption}
      </Text>

      <ThumbnailStrip
        pages={pages.map(p => p.previewUri ?? p.sourceUri)}
        currentPage={index}
        onPagePress={onSelect}
        onAddPress={onBack}
        adding={!canAddMore}
        onReorder={onReorder}
        bottomInset={0}
      />

      <View style={[styles.actions, { backgroundColor: colors.chromeRaised, paddingBottom: Math.max(insets.bottom, Spacing.md) }]}>
        {actions.map(a => (
          <Pressable
            key={a.key}
            onPress={a.onPress}
            disabled={!current}
            style={({ pressed }) => [styles.action, pressed && { opacity: 0.55 }]}
            accessibilityRole="button"
            accessibilityLabel={a.a11y}
          >
            <View style={styles.actionIcon}>
              <Ionicons name={a.icon} size={24} color={colors.chromeText} style={a.flip ? styles.flip : undefined} />
            </View>
            <Text style={[Type.caption, styles.actionLabel, { color: colors.chromeText }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
              {a.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pager: { flex: 1 },
  page: { flex: 1, paddingHorizontal: Spacing.xxl, paddingTop: Spacing.lg, paddingBottom: Spacing.sm },
  pageImage: { flex: 1 },
  caption: { textAlign: 'center', paddingHorizontal: Spacing.gutter, paddingBottom: Spacing.sm, minHeight: 26 },
  actions: { flexDirection: 'row', paddingHorizontal: Spacing.xs, paddingTop: Spacing.xs },
  action: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: HIT + 12, gap: 3 },
  actionIcon: { height: 26, justifyContent: 'center' },
  actionLabel: { fontWeight: '500' },
  flip: { transform: [{ scaleX: -1 }] },
});
