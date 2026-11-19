// components/viewer-toolbar.tsx
// The viewer's always-visible edit toolbar: Crop · Filters · Rotate · Mark up ·
// Text. Each button opens its tool directly, so fixing a page never means
// hunting behind "…". Always-dark chrome, like the rest of the viewer.
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/contexts/theme-context';
import { AppIcon, type AppIconName } from '@/components/app-icon';
import { HIT, Spacing, Type } from '@/lib/theme';

export type ToolbarItem = {
  key: string;
  /** An Ionicon, or one of the app's SF Symbol glyphs (components/app-icon). */
  icon: AppIconName;
  label: string;
  /** VoiceOver label when it should say more than the visible label. */
  a11y?: string;
  hint?: string;
  onPress: () => void;
  /** Optional secondary action on touch-and-hold (also offered to VoiceOver). */
  onLongPress?: () => void;
  longPressLabel?: string;
  busy?: boolean;
  disabled?: boolean;
};

export function ViewerToolbar({ items }: { items: ToolbarItem[] }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.bar, { backgroundColor: colors.chromeRaised, borderBottomColor: colors.chromeBorder }]}>
      {items.map(item => (
        <Pressable
          key={item.key}
          onPress={item.onPress}
          onLongPress={item.onLongPress}
          disabled={item.disabled || item.busy}
          style={({ pressed }) => [styles.item, (pressed || item.disabled) && { opacity: item.disabled ? 0.35 : 0.55 }]}
          accessibilityRole="button"
          accessibilityLabel={item.a11y ?? item.label}
          accessibilityHint={item.hint}
          accessibilityState={{ disabled: !!item.disabled, busy: !!item.busy }}
          accessibilityActions={item.onLongPress ? [{ name: 'longpress', label: item.longPressLabel }] : undefined}
          onAccessibilityAction={e => { if (e.nativeEvent.actionName === 'longpress') item.onLongPress?.(); }}
        >
          <View style={styles.iconBox}>
            {item.busy ? (
              <ActivityIndicator size="small" color={colors.chromeText} />
            ) : (
              <AppIcon name={item.icon} size={24} color={colors.chromeText} />
            )}
          </View>
          <Text
            style={[Type.caption, styles.label, { color: colors.chromeText }]}
            numberOfLines={1}
            maxFontSizeMultiplier={1.3}
          >
            {item.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.xs,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  item: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: HIT + 12, gap: 3 },
  iconBox: { height: 26, justifyContent: 'center' },
  label: { fontWeight: '500' },
});
