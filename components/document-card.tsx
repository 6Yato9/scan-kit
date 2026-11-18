// components/document-card.tsx
// Grid card (Files) plus the list row (Home) and their loading skeletons, so
// both tabs present a document the same way.
import { useEffect, useRef } from 'react';
import { Animated, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Document } from '@/types/document';
import { useTheme } from '@/contexts/theme-context';
import { formatDocDate, formatPageCount } from '@/lib/format';
import { highlightRuns } from '@/lib/highlight';
import { compactMeta } from '@/lib/doc-list';
import { Radius, Spacing, Type } from '@/lib/theme';

type Props = {
  document: Document;
  onPress: () => void;
  onLongPress: () => void;
  isSelected?: boolean;
  isMultiSelectMode?: boolean;
  /**
   * Search context: one line of the document's text that matched, shown muted
   * under the meta. Words matching `snippetQuery` are drawn bold (case- and
   * accent-insensitive), so pass the search text along with the snippet.
   */
  snippet?: string;
  snippetQuery?: string;
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

/** The matched line under a search result, with the hits in bold. */
function Snippet({ text, query, style }: { text: string; query?: string; style?: object }) {
  const { colors } = useTheme();
  return (
    <Text style={[Type.caption, styles.snippet, { color: colors.muted }, style]} numberOfLines={1}>
      {highlightRuns(text, query).map((run, i) =>
        run.match ? (
          <Text key={i} style={[styles.snippetHit, { color: colors.text }]}>{run.text}</Text>
        ) : (
          run.text
        ),
      )}
    </Text>
  );
}

const columnWidth = (columns: number) => `${100 / Math.max(1, columns)}%` as const;

function a11yLabel(document: Document, snippet?: string) {
  return `${document.name}, ${documentMeta(document)}${snippet ? `. Matches: ${snippet}` : ''}`;
}

/**
 * Selection ring drawn over the card or row instead of as its border, so the
 * thumbnail always meets the rounded corners exactly (a transparent border
 * would leave a ring of card colour around it).
 */
function SelectionRing() {
  const { colors } = useTheme();
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.ring, { borderColor: colors.accent }]} />;
}

/**
 * Grid card (Files). Renders its own fixed-width column cell — `columns` must
 * match the FlatList's numColumns — so a lone card on the last row is exactly
 * as wide as the cards above it instead of stretching.
 */
export function DocumentCard({
  document,
  onPress,
  onLongPress,
  isSelected,
  isMultiSelectMode,
  snippet,
  snippetQuery,
  columns = 2,
}: Props & { columns?: number }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.cell, { maxWidth: columnWidth(columns) }]}>
      <Pressable
        style={({ pressed }) => [
          styles.card,
          { backgroundColor: colors.card, shadowColor: colors.shadow },
          pressed && styles.pressed,
        ]}
        onPress={onPress}
        onLongPress={onLongPress}
        accessibilityRole="button"
        accessibilityLabel={a11yLabel(document, snippet)}
        accessibilityState={isMultiSelectMode ? { selected: !!isSelected } : undefined}
        accessibilityHint={isMultiSelectMode ? undefined : 'Long-press for more actions'}
      >
        <View style={styles.cardClip}>
          <Thumb document={document} iconSize={32} style={styles.thumbnail} />
          <View style={styles.info}>
            <Text style={[Type.footnote, styles.name, { color: colors.text }]} numberOfLines={2}>{document.name}</Text>
            <Text style={[Type.caption, { color: colors.muted }]} numberOfLines={1}>
              {columns >= 3 ? compactMeta(document) : documentMeta(document)}
            </Text>
            {snippet ? <Snippet text={snippet} query={snippetQuery} /> : null}
          </View>
        </View>
        {isSelected ? <SelectionRing /> : null}
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
    </View>
  );
}

/** Compact row used by Home's Recent list and Files' list view. */
export function DocumentRow({ document, onPress, onLongPress, isSelected, isMultiSelectMode, snippet, snippetQuery }: Props) {
  const { colors } = useTheme();
  return (
    <Pressable
      style={({ pressed }) => [styles.row, { backgroundColor: colors.card }, pressed && styles.pressed]}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel(document, snippet)}
      accessibilityState={isMultiSelectMode ? { selected: !!isSelected } : undefined}
      accessibilityHint={isMultiSelectMode ? undefined : 'Long-press for more actions'}
    >
      <Thumb document={document} iconSize={24} style={styles.rowThumb} />
      <View style={styles.rowInfo}>
        <Text style={[Type.subhead, { color: colors.text, fontWeight: '600' }]} numberOfLines={1}>{document.name}</Text>
        <Text style={[Type.footnote, styles.rowMeta, { color: colors.muted }]} numberOfLines={1}>{documentMeta(document)}</Text>
        {snippet ? <Snippet text={snippet} query={snippetQuery} style={Type.footnote} /> : null}
      </View>
      {isMultiSelectMode ? (
        <View
          style={[
            styles.rowCheckbox,
            { borderColor: colors.ring },
            isSelected ? { backgroundColor: colors.accentFill, borderColor: colors.accentFill } : null,
          ]}
        >
          {isSelected && <Ionicons name="checkmark" size={15} color={colors.onAccent} />}
        </View>
      ) : (
        <Ionicons name="chevron-forward" size={18} color={colors.muted} />
      )}
      {isMultiSelectMode && isSelected ? <SelectionRing /> : null}
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

export function DocumentCardSkeleton({ columns = 2 }: { columns?: number }) {
  const { colors } = useTheme();
  const opacity = usePulse();
  return (
    <View style={[styles.cell, { maxWidth: columnWidth(columns) }]}>
      <Animated.View style={[styles.card, styles.cardClip, { backgroundColor: colors.card, opacity }]}>
        <View style={[styles.thumbnail, { backgroundColor: colors.placeholder, borderColor: colors.placeholder }]} />
        <View style={styles.info}>
          <View style={[styles.bar, { width: '70%', backgroundColor: colors.placeholder }]} />
          <View style={[styles.bar, { width: '45%', marginTop: Spacing.sm, backgroundColor: colors.placeholder }]} />
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  // One grid column. FlatList lays each row out as a flex row, so with
  // numColumns={2} a row holding fewer items than columns would stretch them
  // to fill it. A cell is flex:1 capped at exactly one column's share (the
  // margin lives inside it as padding), so a lone last card matches the rest.
  cell: { flex: 1, padding: Spacing.xs + 2 },
  card: {
    flex: 1,
    borderRadius: Radius.md,
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  // Clips the thumbnail to the card's corners; a separate view so the card
  // itself keeps its shadow (overflow: hidden would clip it on iOS).
  cardClip: { flex: 1, borderRadius: Radius.md, overflow: 'hidden' },
  ring: { borderRadius: Radius.md, borderWidth: 2 },
  pressed: { opacity: 0.85 },
  thumbnail: { width: '100%', aspectRatio: 0.75, borderBottomWidth: StyleSheet.hairlineWidth },
  pdfThumb: { alignItems: 'center', justifyContent: 'center', gap: Spacing.xs },
  pdfLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  info: { paddingHorizontal: Spacing.md - 2, paddingVertical: Spacing.sm + 2 },
  name: { fontWeight: '600', marginBottom: 2 },
  snippet: { marginTop: Spacing.xs },
  snippetHit: { fontWeight: '700' },
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
