// components/document-card.tsx
// Grid card (Files) plus the list row (Home) and their loading skeletons, so
// both tabs present a document the same way.
import { useEffect, useRef } from 'react';
import { Animated, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Document } from '@/types/document';
import { useTheme } from '@/contexts/theme-context';
import { formatDocDate, formatPageCount } from '@/lib/format';
import { Radius, Spacing, Type } from '@/lib/theme';

type Props = {
  document: Document;
  onPress: () => void;
  onLongPress: () => void;
  isSelected?: boolean;
  isMultiSelectMode?: boolean;
};

function Thumb({ document, iconSize, style }: { document: Document; iconSize: number; style: object }) {
  const { colors } = useTheme();
  // A hairline keeps a white page from melting into the white card.
  const edge = { borderColor: colors.thumbBorder };
  if (document.pdfUri) {
    return (
      <View style={[style, edge, styles.pdfThumb, { backgroundColor: colors.placeholder }]}>
        <Ionicons name="document-text-outline" size={iconSize} color={colors.muted} />
        <Text allowFontScaling={false} style={[styles.pdfLabel, { color: colors.muted }]}>PDF</Text>
      </View>
    );
  }
  if (document.pages[0]) {
    return <Image source={{ uri: `${document.pages[0]}?v=${document.updatedAt}` }} style={[style, edge, { backgroundColor: colors.placeholder }]} resizeMode="cover" />;
  }
  return <View style={[style, edge, { backgroundColor: colors.placeholder }]} />;
}

export function documentMeta(document: Document): string {
  return `${formatPageCount(document)}, ${formatDocDate(document.updatedAt)}`;
}

export function DocumentCard({ document, onPress, onLongPress, isSelected, isMultiSelectMode }: Props) {
  const { colors } = useTheme();
  return (
    <Pressable
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: colors.card, shadowColor: colors.shadow },
        isSelected && { borderColor: colors.accent },
        pressed && styles.pressed,
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${document.name}, ${documentMeta(document)}`}
      accessibilityState={isMultiSelectMode ? { selected: !!isSelected } : undefined}
      accessibilityHint={isMultiSelectMode ? undefined : 'Long-press for more actions'}
    >
      <Thumb document={document} iconSize={32} style={styles.thumbnail} />
      <View style={styles.info}>
        <Text style={[Type.footnote, styles.name, { color: colors.text }]} numberOfLines={2}>{document.name}</Text>
        <Text style={[Type.caption, { color: colors.muted }]} numberOfLines={1}>{documentMeta(document)}</Text>
      </View>
      {isMultiSelectMode && (
        <View
          style={[
            styles.checkbox,
            isSelected
              ? { backgroundColor: colors.accentFill, borderColor: colors.accentFill }
              : { backgroundColor: colors.scrimSoft, borderColor: colors.onScrim },
          ]}
        >
          {isSelected && <Ionicons name="checkmark" size={15} color={colors.onAccent} />}
        </View>
      )}
    </Pressable>
  );
}

/** Compact row used by Home's Recent list and Files' list view. */
export function DocumentRow({ document, onPress, onLongPress, isSelected, isMultiSelectMode }: Props) {
  const { colors } = useTheme();
  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: colors.card },
        // Selection ring only in select mode, so the normal row is unchanged.
        isMultiSelectMode && { borderWidth: 2, margin: -2, marginBottom: Spacing.sm - 2, borderColor: isSelected ? colors.accent : 'transparent' },
        pressed && styles.pressed,
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${document.name}, ${documentMeta(document)}`}
      accessibilityState={isMultiSelectMode ? { selected: !!isSelected } : undefined}
      accessibilityHint={isMultiSelectMode ? undefined : 'Long-press for more actions'}
    >
      <Thumb document={document} iconSize={24} style={styles.rowThumb} />
      <View style={styles.rowInfo}>
        <Text style={[Type.subhead, { color: colors.text, fontWeight: '600' }]} numberOfLines={1}>{document.name}</Text>
        <Text style={[Type.footnote, styles.rowMeta, { color: colors.muted }]} numberOfLines={1}>{documentMeta(document)}</Text>
      </View>
      {isMultiSelectMode ? (
        <View
          style={[
            styles.rowCheckbox,
            { borderColor: colors.border },
            isSelected ? { backgroundColor: colors.accentFill, borderColor: colors.accentFill } : null,
          ]}
        >
          {isSelected && <Ionicons name="checkmark" size={15} color={colors.onAccent} />}
        </View>
      ) : (
        <Ionicons name="chevron-forward" size={18} color={colors.muted} />
      )}
    </Pressable>
  );
}

// ── Loading skeletons ───────────────────────────────────────────────────────

function usePulse() {
  const v = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(v, { toValue: 0.5, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return v;
}

export function DocumentRowSkeleton() {
  const { colors } = useTheme();
  const opacity = usePulse();
  return (
    <Animated.View style={[styles.row, { backgroundColor: colors.card, opacity }]}>
      <View style={[styles.rowThumb, { backgroundColor: colors.placeholder, borderColor: colors.placeholder }]} />
      <View style={styles.rowInfo}>
        <View style={[styles.bar, { width: '60%', backgroundColor: colors.placeholder }]} />
        <View style={[styles.bar, { width: '35%', marginTop: Spacing.sm, backgroundColor: colors.placeholder }]} />
      </View>
    </Animated.View>
  );
}

export function DocumentCardSkeleton() {
  const { colors } = useTheme();
  const opacity = usePulse();
  return (
    <Animated.View style={[styles.card, { backgroundColor: colors.card, opacity }]}>
      <View style={[styles.thumbnail, { backgroundColor: colors.placeholder, borderColor: colors.placeholder }]} />
      <View style={styles.info}>
        <View style={[styles.bar, { width: '70%', backgroundColor: colors.placeholder }]} />
        <View style={[styles.bar, { width: '45%', marginTop: Spacing.sm, backgroundColor: colors.placeholder }]} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    // Caps a lone card at one column. FlatList lays each row out as a flex row,
    // so with numColumns={2} a row holding fewer items than columns stretches
    // them to fill it — one document rendered full-width and, at aspectRatio
    // 0.75, filled the whole screen. Also fixes the last row of an odd-length
    // grid, which stretched the same way.
    maxWidth: '50%',
    margin: Spacing.xs + 2,
    borderRadius: Radius.md,
    borderWidth: 2,
    borderColor: 'transparent',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
    overflow: 'hidden',
  },
  pressed: { opacity: 0.85 },
  thumbnail: { width: '100%', aspectRatio: 0.75, borderBottomWidth: StyleSheet.hairlineWidth },
  pdfThumb: { alignItems: 'center', justifyContent: 'center', gap: Spacing.xs },
  pdfLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  info: { paddingHorizontal: Spacing.md - 2, paddingVertical: Spacing.sm + 2 },
  name: { fontWeight: '600', marginBottom: 2 },
  checkbox: {
    position: 'absolute',
    top: Spacing.sm,
    end: Spacing.sm,
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.md,
    marginBottom: Spacing.sm,
    padding: Spacing.sm + 2,
    paddingRight: Spacing.md,
    gap: Spacing.md,
  },
  rowThumb: { width: 46, height: 60, borderRadius: 6, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  rowInfo: { flex: 1 },
  rowMeta: { marginTop: 2 },
  rowCheckbox: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  bar: { height: 10, borderRadius: 5 },
});
