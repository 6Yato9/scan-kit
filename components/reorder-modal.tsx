// components/reorder-modal.tsx
// Drag-to-reorder sheet for the viewer. Uses the always-dark chrome like the
// viewer it is presented over.
import { Modal, Platform, Pressable, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useEffect, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import DraggableFlatList, {
  ScaleDecorator,
  RenderItemParams,
} from 'react-native-draggable-flatlist';
import { useTheme } from '@/contexts/theme-context';
import { PageThumb } from '@/components/page-thumb';
import { HeaderTextButton, ScreenHeader } from '@/components/screen-header';
import { useAppLocked } from '@/components/lock-gate';
import { HIT, Spacing, Type } from '@/lib/theme';

type PageItem = {
  index: number;
  uri: string;
};

type Props = {
  visible: boolean;
  pages: string[];
  /** Cache-bust value (document.updatedAt) so thumbnails reflect in-place edits. */
  cacheBust?: number;
  /** Shows a spinner on Done while the new order is being written. */
  saving?: boolean;
  onConfirm: (newOrderIndices: number[]) => void;
  onCancel: () => void;
};

export function ReorderModal({ visible, pages, cacheBust, saving, onConfirm, onCancel }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  // iOS presents a page sheet below the status bar; Android has no page
  // sheets, so the modal is full screen, edge to edge, and pads for the bars.
  const fullScreen = Platform.OS !== 'ios';
  const [items, setItems] = useState<PageItem[]>([]);

  // App lock: pushing /lock makes react-native-screens dismiss this RN Modal
  // natively while JS still thinks it is open, leaving it impossible to
  // reopen. Close it properly instead (an unsaved order is dropped; a save
  // already running still completes) and remount the Modal so its native host
  // starts fresh.
  const locked = useAppLocked();
  const [modalKey, setModalKey] = useState(0);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useEffect(() => {
    if (!locked || !visible) return;
    setModalKey(k => k + 1);
    onCancelRef.current();
  }, [locked, visible]);

  // Re-init whenever the modal becomes visible OR the underlying pages change.
  useEffect(() => {
    if (!visible) return;
    setItems(pages.map((uri, index) => ({ index, uri })));
  }, [visible, pages]);

  const changed = items.some((item, i) => item.index !== i);

  function handleConfirm() {
    if (!changed) {
      onCancel();
      return;
    }
    onConfirm(items.map(item => item.index));
  }

  const renderItem = ({ item, getIndex, drag, isActive }: RenderItemParams<PageItem>) => {
    const position = (getIndex() ?? 0) + 1;
    return (
      <ScaleDecorator>
        <Pressable
          style={[
            styles.row,
            { backgroundColor: isActive ? colors.chromeBorder : colors.chromeRaised },
          ]}
          onLongPress={drag}
          delayLongPress={150}
          accessibilityRole="button"
          accessibilityLabel={`Page ${position}`}
          accessibilityHint="Touch and hold, then drag to move"
        >
          <PageThumb
            uri={cacheBust ? `${item.uri}?v=${cacheBust}` : item.uri}
            style={[styles.thumb, { backgroundColor: colors.chrome }]}
          />
          <Text style={[Type.body, styles.pageLabel, { color: colors.chromeText }]}>Page {position}</Text>
          <Pressable
            onPressIn={drag}
            hitSlop={8}
            style={styles.handle}
            accessibilityLabel={`Move page ${position}`}
          >
            <Ionicons name="reorder-three-outline" size={26} color={colors.chromeMuted} />
          </Pressable>
        </Pressable>
      </ScaleDecorator>
    );
  };

  return (
    <Modal
      key={modalKey}
      visible={visible && !locked}
      animationType="slide"
      presentationStyle="pageSheet"
      // iOS: the page sheet's swipe down, as before. Android's back is Cancel,
      // except while the new order is being written.
      onRequestClose={Platform.OS === 'ios' ? onCancel : () => {
        if (!saving) onCancel();
      }}
      statusBarTranslucent
      navigationBarTranslucent
    >
      {/* A Modal is a separate native root, so the gesture handler needs its own root inside it. */}
      <GestureHandlerRootView style={[styles.container, { backgroundColor: colors.chrome }]}>
        <ScreenHeader
          dark
          withInset={fullScreen}
          title="Reorder pages"
          left={<HeaderTextButton title="Cancel" color={colors.chromeText} onPress={onCancel} />}
          right={
            <HeaderTextButton
              title={saving ? 'Saving…' : 'Done'}
              emphasis
              disabled={saving}
              color={colors.chromeAccent}
              onPress={handleConfirm}
            />
          }
        />
        <Text style={[Type.footnote, styles.hint, { color: colors.chromeMuted }]}>
          Touch and hold a page, then drag it to a new position.
        </Text>
        <DraggableFlatList
          data={items}
          onDragEnd={({ data }) => setItems(data)}
          keyExtractor={item => String(item.index)}
          renderItem={renderItem}
          contentContainerStyle={[styles.list, fullScreen && { paddingBottom: Spacing.xxxl + insets.bottom }]}
        />
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  hint: { paddingHorizontal: Spacing.gutter, paddingBottom: Spacing.sm },
  list: { paddingHorizontal: Spacing.gutter, paddingBottom: Spacing.xxxl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
    gap: Spacing.md + 2,
    borderRadius: 12,
    marginBottom: Spacing.sm,
  },
  thumb: {
    width: 44,
    height: 58,
    borderRadius: 4,
  },
  pageLabel: { flex: 1 },
  handle: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
});
