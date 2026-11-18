// components/page-actions-sheet.tsx
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { BottomSheet } from '@/components/bottom-sheet';
import { PageFilter, PageAdjustment } from '@/types/document';
import { bakePreviews, PREVIEW_FILTERS } from '@/lib/bake';
import { SimpleSlider } from '@/components/simple-slider';
import { PrimaryButton } from '@/components/primary-button';
import { useTheme } from '@/contexts/theme-context';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

type Props = {
  visible: boolean;
  uri: string;
  docId: string;
  pageIndex: number;
  pageCount: number;
  filter: PageFilter;
  adjustment?: PageAdjustment;
  onRotate: (direction: 'cw' | 'ccw') => Promise<void>;
  onFilter: (filter: PageFilter) => void;
  onAdjust: (adj: PageAdjustment) => void;
  onAnnotate: () => void;
  onCrop: () => void;
  /** Called after the user has confirmed the delete inside the sheet. */
  onDelete: () => void;
  onShare: () => void;
  onClose: () => void;
  /** Fires once the sheet has fully closed — present native UI (share sheet) from here. */
  onDismissed?: () => void;
};

/** Display names, shared with Scan Settings' default-filter picker. */
export const FILTER_LABELS: Record<PageFilter, string> = {
  original: 'Original',
  grayscale: 'Grayscale',
  bw: 'Black & white',
  enhanced: 'Enhanced',
};

const DEFAULT_ADJ: PageAdjustment = { brightness: 0, contrast: 0, saturation: 0 };

type Tab = 'filter' | 'adjust';

export function PageActionsSheet({
  visible,
  uri,
  docId,
  pageIndex,
  pageCount,
  filter,
  adjustment,
  onRotate,
  onFilter,
  onAdjust,
  onAnnotate,
  onCrop,
  onDelete,
  onShare,
  onClose,
  onDismissed,
}: Props) {
  const { colors } = useTheme();
  const [rotating, setRotating] = useState(false);
  const [tab, setTab] = useState<Tab>('filter');
  const [previews, setPreviews] = useState<string[] | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Each opening starts on the normal actions, never on a stale confirmation.
  useEffect(() => {
    if (!visible) setConfirmingDelete(false);
  }, [visible]);
  useEffect(() => { setConfirmingDelete(false); }, [pageIndex]);

  // Real previews: each tile is the page re-rendered through that filter. RN's
  // `filter` style cannot do this on iOS (it honours only brightness/opacity),
  // so all four tiles used to look identical. One WebView pass renders them all.
  useEffect(() => {
    if (!visible || tab !== 'filter') return;
    let cancelled = false;
    setPreviews(null);
    bakePreviews(docId, pageIndex)
      .then(urls => { if (!cancelled) setPreviews(urls); })
      .catch(() => { if (!cancelled) setPreviews(null); });
    return () => { cancelled = true; };
  }, [visible, tab, docId, pageIndex]);


  async function rotate(direction: 'cw' | 'ccw') {
    if (rotating) return;
    setRotating(true);
    try {
      await onRotate(direction);
    } finally {
      setRotating(false);
    }
  }

  const adj = adjustment ?? DEFAULT_ADJ;
  const isLastPage = pageCount <= 1;

  const action = (icon: IconName, label: string, a11y: string, onPress: () => void, opts: { danger?: boolean; mirror?: boolean; disabled?: boolean } = {}) => (
    <Pressable
      key={a11y}
      style={({ pressed }) => [
        styles.actionBtn,
        { backgroundColor: opts.danger ? colors.dangerBg : colors.actionBtnBg },
        (pressed || opts.disabled) && { opacity: opts.disabled ? 0.4 : 0.6 },
      ]}
      onPress={onPress}
      disabled={opts.disabled}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled: !!opts.disabled }}
    >
      <Ionicons
        name={icon}
        size={22}
        color={opts.danger ? colors.danger : colors.text}
        style={opts.mirror ? styles.mirror : undefined}
      />
      <Text
        allowFontScaling={false}
        numberOfLines={1}
        style={[styles.actionLabel, { color: opts.danger ? colors.danger : colors.subtext }]}
      >
        {label}
      </Text>
    </Pressable>
  );

  if (confirmingDelete) {
    return (
      <BottomSheet visible={visible} onClose={() => setConfirmingDelete(false)} onDismissed={onDismissed} transparentBackdrop>
        <View style={styles.confirm}>
          <View style={[styles.confirmIcon, { backgroundColor: colors.dangerBg }]}>
            <Ionicons name="trash-outline" size={24} color={colors.danger} />
          </View>
          <Text style={[Type.headline, { color: colors.text, textAlign: 'center' }]}>
            {isLastPage ? 'Delete this document?' : `Delete page ${pageIndex + 1}?`}
          </Text>
          <Text style={[Type.footnote, { color: colors.muted, textAlign: 'center' }]}>
            {isLastPage
              ? 'This is the only page, so the whole document will be deleted. This can’t be undone.'
              : 'This page will be removed from the document. This can’t be undone.'}
          </Text>
          <View style={styles.confirmRow}>
            <PrimaryButton
              title="Cancel"
              variant="secondary"
              style={styles.confirmBtn}
              onPress={() => setConfirmingDelete(false)}
            />
            <PrimaryButton
              title={isLastPage ? 'Delete document' : 'Delete page'}
              variant="destructive"
              style={{ ...styles.confirmBtn, backgroundColor: colors.dangerBg }}
              onPress={() => { setConfirmingDelete(false); onDelete(); }}
            />
          </View>
        </View>
      </BottomSheet>
    );
  }

  return (
    <BottomSheet visible={visible} onClose={rotating ? undefined : onClose} onDismissed={onDismissed} transparentBackdrop>
      <View style={styles.row}>
        {action('refresh-outline', 'Left', 'Rotate left', () => rotate('ccw'), { mirror: true, disabled: rotating })}
        {action('refresh-outline', 'Right', 'Rotate right', () => rotate('cw'), { disabled: rotating })}
        {action('crop-outline', 'Crop', 'Crop', onCrop, { disabled: rotating })}
        {action('brush-outline', 'Annotate', 'Annotate', () => { onClose(); onAnnotate(); }, { disabled: rotating })}
        {action('share-outline', 'Share', 'Share page', onShare, { disabled: rotating })}
        {action('trash-outline', 'Delete', 'Delete page', () => setConfirmingDelete(true), { danger: true, disabled: rotating })}
      </View>
      {rotating && <ActivityIndicator style={styles.rotating} color={colors.muted} />}

      {/* Segmented control */}
      <View style={[styles.tabRow, { backgroundColor: colors.secondary }]} accessibilityRole="tablist">
        {(['filter', 'adjust'] as Tab[]).map(t => {
          const active = tab === t;
          return (
            <Pressable
              key={t}
              style={[styles.tab, active && { backgroundColor: colors.card }]}
              onPress={() => setTab(t)}
              hitSlop={4}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
            >
              <Text style={[Type.subhead, { color: active ? colors.text : colors.muted, fontWeight: '600' }]}>
                {t === 'filter' ? 'Filter' : 'Adjust'}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {tab === 'filter' ? (
        <View style={styles.filterRow}>
          {PREVIEW_FILTERS.map(key => {
            const previewUri = previews?.[PREVIEW_FILTERS.indexOf(key)] ?? uri;
            const active = filter === key;
            return (
              <Pressable
                key={key}
                style={[styles.filterTile, { borderColor: active ? colors.accent : 'transparent' }]}
                onPress={() => onFilter(key)}
                accessibilityRole="button"
                accessibilityLabel={`${FILTER_LABELS[key]} filter`}
                accessibilityState={{ selected: active }}
              >
                <Image
                  source={{ uri: previewUri }}
                  style={[styles.filterPreview, { backgroundColor: colors.placeholder }]}
                  resizeMode="cover"
                />
                <Text
                  allowFontScaling={false}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.8}
                  style={[styles.filterLabel, { color: active ? colors.accent : colors.muted }, active && styles.filterLabelActive]}
                >
                  {FILTER_LABELS[key]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : (
        <View style={styles.adjustPanel}>
          <SimpleSlider
            label="Brightness"
            value={adj.brightness}
            onValueChange={v => onAdjust({ ...adj, brightness: v })}
          />
          <SimpleSlider
            label="Contrast"
            value={adj.contrast}
            onValueChange={v => onAdjust({ ...adj, contrast: v })}
          />
          <SimpleSlider
            label="Saturation"
            value={adj.saturation}
            onValueChange={v => onAdjust({ ...adj, saturation: v })}
          />
          <Pressable
            onPress={() => onAdjust(DEFAULT_ADJ)}
            disabled={adj.brightness === 0 && adj.contrast === 0 && adj.saturation === 0}
            style={({ pressed }) => [
              styles.resetBtn,
              adj.brightness === 0 && adj.contrast === 0 && adj.saturation === 0 && styles.hidden,
              pressed && styles.pressed,
            ]}
            accessibilityRole="button"
          >
            <Text style={[Type.subhead, { color: colors.accent }]}>Reset adjustments</Text>
          </Pressable>
        </View>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.lg,
  },
  actionBtn: {
    flex: 1,
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.sm,
    borderRadius: Radius.sm + 2,
    gap: 3,
  },
  mirror: { transform: [{ scaleX: -1 }] },
  actionLabel: { fontSize: 11, fontWeight: '500' },
  rotating: { position: 'absolute', alignSelf: 'center', top: Spacing.xxl + 6 },
  tabRow: {
    flexDirection: 'row',
    borderRadius: Radius.sm + 2,
    padding: 3,
    marginBottom: Spacing.lg,
  },
  tab: {
    flex: 1,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.sm,
  },
  filterRow: { flexDirection: 'row', gap: Spacing.sm },
  filterTile: {
    flex: 1,
    alignItems: 'center',
    borderRadius: Radius.sm + 2,
    padding: 3,
    borderWidth: 2,
  },
  filterPreview: { width: '100%', aspectRatio: 0.75, borderRadius: Spacing.xs + 2 },
  filterLabel: { fontSize: 12, marginTop: Spacing.xs + 2, marginBottom: 2 },
  filterLabelActive: { fontWeight: '600' },
  adjustPanel: { paddingHorizontal: Spacing.xs },
  resetBtn: { alignSelf: 'center', minHeight: HIT, justifyContent: 'center', paddingHorizontal: Spacing.lg },
  hidden: { opacity: 0 },
  pressed: { opacity: 0.6 },
  confirm: { alignItems: 'center', gap: Spacing.sm, paddingTop: Spacing.xs },
  confirmIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.xs,
  },
  confirmRow: { flexDirection: 'row', gap: Spacing.md, marginTop: Spacing.md, alignSelf: 'stretch' },
  confirmBtn: { flex: 1 },
});
