// components/bottom-sheet.tsx
// The one bottom sheet used across the app.
//
// The backdrop fades while only the sheet slides (the old animationType="slide"
// dragged the dim layer up with it). A grab handle sits on top, the sheet can
// be dragged down to dismiss, and the bottom padding follows the safe area.
//
// `onDismissed` fires once the sheet is fully off screen and its native modal
// is gone. Present anything native that must follow (share sheet, print,
// pickers, Alerts, another sheet) from there — iOS silently drops a
// presentation made while a modal is still dismissing.
import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { useAppLocked } from '@/components/lock-gate';
import { AppIcon, type AppIconName } from '@/components/app-icon';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

type Props = {
  visible: boolean;
  /** Omit to make the sheet non-dismissable (e.g. while an export runs). */
  onClose?: () => void;
  children: React.ReactNode;
  transparentBackdrop?: boolean;
  /** Called after the close animation has finished and the modal is gone. */
  onDismissed?: () => void;
  /**
   * 'plain' (default): card-coloured sheet. 'grouped': page-coloured sheet so
   * SheetGroup cards stand out, like an iOS grouped list.
   */
  variant?: 'plain' | 'grouped';
};

const OPEN_MS = 280;
const CLOSE_MS = 220;

export function BottomSheet({ visible: requested, onClose, children, transparentBackdrop, onDismissed, variant = 'plain' }: Props) {
  const { colors } = useTheme();
  // Step aside while the app lock is up: an open sheet would otherwise sit on
  // top of the lock screen. It comes back by itself after unlocking.
  const locked = useAppLocked();
  const visible = requested && !locked;
  const insets = useSafeAreaInsets();
  const { height: screenH } = useWindowDimensions();

  // `mounted` keeps the Modal up while the close animation plays.
  const [mounted, setMounted] = useState(visible);
  const backdrop = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(screenH)).current;
  const sheetH = useRef(screenH);
  const onDismissedRef = useRef(onDismissed);
  onDismissedRef.current = onDismissed;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const pendingDismiss = useRef(false);

  useEffect(() => {
    if (visible) {
      pendingDismiss.current = false;
      setMounted(true);
      translateY.setValue(sheetH.current);
      Animated.parallel([
        Animated.timing(backdrop, { toValue: 1, duration: OPEN_MS, useNativeDriver: true }),
        Animated.timing(translateY, {
          toValue: 0,
          duration: OPEN_MS,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();
    } else if (mounted) {
      Animated.parallel([
        Animated.timing(backdrop, { toValue: 0, duration: CLOSE_MS, useNativeDriver: true }),
        Animated.timing(translateY, {
          toValue: sheetH.current,
          duration: CLOSE_MS,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start(() => {
        pendingDismiss.current = true;
        setMounted(false);
        // iOS reports the end of the native dismissal through Modal.onDismiss;
        // Android has no such callback, so it is safe to fire right away. The
        // timer is a backstop in case onDismiss never arrives (fires once).
        if (Platform.OS !== 'ios') fireDismissed();
        else setTimeout(fireDismissed, 500);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  function fireDismissed() {
    if (!pendingDismiss.current) return;
    pendingDismiss.current = false;
    onDismissedRef.current?.();
  }

  // Drag-to-dismiss on the handle area.
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !!onCloseRef.current,
      onMoveShouldSetPanResponder: (_, g) => !!onCloseRef.current && g.dy > 4,
      onPanResponderMove: (_, g) => {
        if (g.dy > 0) translateY.setValue(g.dy);
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy > Math.min(120, sheetH.current * 0.3) || g.vy > 1.2) {
          Keyboard.dismiss();
          onCloseRef.current?.();
        } else {
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 0, speed: 18 }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 0, speed: 18 }).start();
      },
    }),
  ).current;

  // RN Modal warns + breaks Android hardware back when onRequestClose is undefined.
  const noop = () => {};
  const sheetBg = variant === 'grouped' ? colors.bg : colors.card;

  return (
    <Modal
      transparent
      visible={mounted}
      animationType="none"
      onRequestClose={onClose ?? noop}
      onDismiss={fireDismissed}
    >
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: transparentBackdrop ? 'transparent' : colors.backdrop, opacity: backdrop },
          ]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={() => {
              if (!onClose) return;
              Keyboard.dismiss();
              onClose();
            }}
          />
        </Animated.View>
        <Animated.View
          onLayout={e => { sheetH.current = e.nativeEvent.layout.height + 40; }}
          style={[
            styles.sheet,
            {
              backgroundColor: sheetBg,
              maxHeight: screenH - insets.top - Spacing.xl,
              paddingBottom: Math.max(insets.bottom, Spacing.lg) + Spacing.sm,
              transform: [{ translateY }],
            },
            { borderColor: colors.sheetBorder, borderWidth: StyleSheet.hairlineWidth, shadowColor: colors.shadow },
          ]}
        >
          <View {...pan.panHandlers} style={styles.handleArea}>
            <View style={[styles.handle, { backgroundColor: colors.handle }]} />
          </View>
          <View style={styles.content}>{children}</View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Building blocks for sheet content ───────────────────────────────────────

/** Title (and optional subtitle) at the top of a sheet. */
export function SheetHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.header}>
      <Text style={[Type.headline, { color: colors.text }]} numberOfLines={2} accessibilityRole="header">
        {title}
      </Text>
      {subtitle ? (
        <Text style={[Type.footnote, styles.headerSub, { color: colors.muted }]} numberOfLines={2}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

/** A rounded card holding SheetRows. Use inside a `variant="grouped"` sheet. */
export function SheetGroup({ children, style }: { children: React.ReactNode; style?: object }) {
  const { colors } = useTheme();
  return <View style={[styles.group, { backgroundColor: colors.card }, style]}>{children}</View>;
}

/** One tappable row: icon, label, optional detail, and a trailing accessory. */
export function SheetRow({
  icon,
  label,
  detail,
  onPress,
  destructive,
  selected,
  chevron,
  last,
  disabled,
  accessibilityLabel,
}: {
  icon?: AppIconName;
  label: string;
  detail?: string;
  onPress: () => void;
  destructive?: boolean;
  /** Shows a trailing checkmark and marks the row selected for VoiceOver. */
  selected?: boolean;
  chevron?: boolean;
  /** Hides the bottom separator. */
  last?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme();
  const fg = destructive ? colors.danger : colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.separator }, disabled && { opacity: 0.4 }]}
    >
      {icon ? (
        <View style={styles.rowIcon}>
          <AppIcon name={icon} size={22} color={destructive ? colors.danger : colors.accent} />
        </View>
      ) : null}
      <View style={[styles.rowBody, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}>
        <View style={styles.rowText}>
          <Text style={[Type.body, { color: fg }]} numberOfLines={1}>{label}</Text>
          {detail ? <Text style={[Type.footnote, { color: colors.muted, marginTop: 1 }]} numberOfLines={1}>{detail}</Text> : null}
        </View>
        {selected ? <Ionicons name="checkmark" size={20} color={colors.accent} /> : null}
        {chevron ? <Ionicons name="chevron-forward" size={18} color={colors.muted} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    shadowOpacity: 0.15,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: -4 },
    elevation: 16,
  },
  handleArea: { height: 24, alignItems: 'center', justifyContent: 'center' },
  handle: { width: 36, height: 5, borderRadius: 3 },
  content: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.xs, flexShrink: 1 },
  header: { marginBottom: Spacing.md, paddingHorizontal: Spacing.xs },
  headerSub: { marginTop: 2 },
  group: { borderRadius: Radius.md, overflow: 'hidden', marginBottom: Spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: HIT + 6, paddingLeft: Spacing.lg },
  rowIcon: { width: 28, marginRight: Spacing.md },
  rowBody: { flex: 1, flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', paddingRight: Spacing.lg, gap: Spacing.sm },
  rowText: { flex: 1, justifyContent: 'center', paddingVertical: Spacing.md },
});
