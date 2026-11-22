// components/document-card.tsx
// Grid card (Files) plus the list row (Home) and their loading skeletons, so
// both tabs present a document the same way.
import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Document } from '@/types/document';
import { useTheme } from '@/contexts/theme-context';
import { formatDocDate, formatPageCount } from '@/lib/format';
import { highlightRuns } from '@/lib/highlight';
import { compactMeta, windowAround } from '@/lib/doc-list';
import { WordClampText } from '@/components/word-clamp-text';
import { PageThumb } from '@/components/page-thumb';
import { usePdfThumbnail } from '@/lib/pdf-thumb';
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
  // A PDF shows its first page once rendered (lib/pdf-thumb.ts), else the icon.
  const pdfThumb = usePdfThumbnail(document.id, document.pdfUri);
  if (document.pdfUri && pdfThumb) {
    return <PageThumb uri={pdfThumb} style={[style, edge, { backgroundColor: colors.placeholder }]} />;
  }
  if (document.pdfUri) {
    return (
      <View style={[style, edge, styles.pdfThumb, { backgroundColor: colors.placeholder }]}>
        <Ionicons name="document-text-outline" size={iconSize} color={colors.muted} />
        <Text allowFontScaling={false} style={[styles.pdfLabel, { color: colors.muted }]}>PDF</Text>
      </View>
    );
  }
  if (document.pages[0]) {
    return <PageThumb uri={`${document.pages[0]}?v=${document.updatedAt}`} style={[style, edge, { backgroundColor: colors.placeholder }]} />;
  }
  return <View style={[style, edge, { backgroundColor: colors.placeholder }]} />;
}

export function documentMeta(document: Document): string {
  return `${formatPageCount(document)}, ${formatDocDate(document.updatedAt)}`;
}

/**
 * Average advance of a character as a share of the font size, leaning wide
 * (recognized text is often capitals and digits, and the hit is bold), so the
 * window rather than the row's tail truncation decides what is cut.
 */
const SNIPPET_CHAR_EM = 0.6;

/**
 * The matched line under a search result, with the hits in bold. It is cut to
 * the width the row really has, with the hit in the middle and "…" on each cut
 * side, so the matched word is visible in a narrow grid card as in a list row.
 */
function Snippet({ text, query, style }: { text: string; query?: string; style?: { fontSize: number } }) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const fontSize = style?.fontSize ?? Type.caption.fontSize;
  // Until the row is laid out, a window that fits the narrowest grid card.
  const capacity = width > 0 ? Math.floor(width / (fontSize * SNIPPET_CHAR_EM)) : 18;
  const shown = query ? windowAround(text, query, capacity) : text;
  return (
    <Text
      style={[Type.caption, styles.snippet, { color: colors.muted }, style]}
      numberOfLines={1}
      onLayout={e => {
        const w = Math.round(e.nativeEvent.layout.width);
        if (w !== width) setWidth(w);
      }}
    >
      {highlightRuns(shown, query).map((run, i) =>
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

/**
 * The card is one VoiceOver element, so the More button inside it isn't
 * reachable on its own: the same menu is offered as the card's "More actions"
 * action (swipe up or down to it).
 */
function moreAction(selecting: boolean | undefined, open: () => void) {
  if (selecting) return {};
  return {
    accessibilityActions: [{ name: 'longpress', label: 'More actions' }],
    onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => {
      if (e.nativeEvent.actionName === 'longpress') open();
    },
  };
}

/**
 * The visible way into a document's actions (share, rename, move, delete…),
 * the same menu a long-press opens: an ellipsis at the end of the meta line.
 * Its 44pt touch target overhangs the card's padding instead of growing it.
 */
function MoreButton({ name, onPress, size = 18 }: { name: string; onPress: () => void; size?: number }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={{ top: 12, bottom: 12, left: 10, right: 10 }}
      accessibilityRole="button"
      accessibilityLabel={`More actions for ${name}`}
      style={({ pressed }) => [styles.more, pressed && { opacity: 0.5 }]}
    >
      <Ionicons name="ellipsis-horizontal" size={size} color={colors.muted} />
    </Pressable>
  );
}

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
        {...moreAction(isMultiSelectMode, onLongPress)}
      >
        <View style={styles.cardClip}>
          <View>
            <Thumb document={document} iconSize={32} style={styles.thumbnail} />
            {/* More in the page's lower corner, so the text below keeps its
                full width even three columns across. The selection check
                takes the upper corner while selecting. */}
            {isMultiSelectMode ? null : <MoreChip name={document.name} onPress={onLongPress} />}
          </View>
          <View style={styles.info}>
            <WordClampText style={[Type.footnote, styles.name, { color: colors.text }]} numberOfLines={2} maxFontSizeMultiplier={1.3}>{document.name}</WordClampText>
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

/** Compact row used by Home's Recent list, search results and Files' list view. Names wrap to two lines. */
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
      {...moreAction(isMultiSelectMode, onLongPress)}
    >
      <Thumb document={document} iconSize={24} style={styles.rowThumb} />
      <View style={styles.rowInfo}>
        <WordClampText style={[Type.subhead, styles.rowName, { color: colors.text }]} numberOfLines={2} maxFontSizeMultiplier={1.4}>{document.name}</WordClampText>
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
        <MoreButton name={document.name} onPress={onLongPress} size={20} />
      )}
      {isMultiSelectMode && isSelected ? <SelectionRing /> : null}
    </Pressable>
  );
}

/**
 * A fixed-width page tile for Home's "Continue editing" shelf: a large first
 * page, the name on two lines and when it was last changed, with the same
 * More button as the Files grid. Not a grid cell — it sits in a horizontal row.
 */
export function DocumentTile({
  document,
  onPress,
  onLongPress,
  width,
}: Pick<Props, 'document' | 'onPress' | 'onLongPress'> & { width: number }) {
  const { colors } = useTheme();
  return (
    <Pressable
      style={({ pressed }) => [styles.card, styles.tile, { width, backgroundColor: colors.card, shadowColor: colors.shadow }, pressed && styles.pressed]}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${document.name}, ${formatPageCount(document)}, edited ${formatDocDate(document.updatedAt)}`}
      {...moreAction(false, onLongPress)}
    >
      <View style={styles.cardClip}>
        <Thumb document={document} iconSize={32} style={styles.thumbnail} />
        <View style={styles.info}>
          <WordClampText style={[Type.footnote, styles.name, { color: colors.text }]} numberOfLines={2} maxFontSizeMultiplier={1.3}>{document.name}</WordClampText>
          <View style={styles.metaRow}>
            <Text style={[Type.caption, styles.metaText, { color: colors.muted }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
              {formatDocDate(document.updatedAt)}
            </Text>
            <MoreButton name={document.name} onPress={onLongPress} size={16} />
          </View>
        </View>
      </View>
    </Pressable>
  );
}

/** The grid card's More button: a small dark disc over the page's lower corner. */
function MoreChip({ name, onPress }: { name: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={9}
      accessibilityRole="button"
      accessibilityLabel={`More actions for ${name}`}
      style={({ pressed }) => [styles.moreChip, { backgroundColor: colors.scrimSoft }, pressed && { opacity: 0.6 }]}
    >
      <Ionicons name="ellipsis-horizontal" size={16} color={colors.onScrim} />
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

export function DocumentTileSkeleton({ width }: { width: number }) {
  const { colors } = useTheme();
  const opacity = usePulse();
  return (
    <Animated.View style={[styles.card, styles.tile, styles.cardClip, { width, backgroundColor: colors.card, opacity }]}>
      <View style={[styles.thumbnail, { backgroundColor: colors.placeholder, borderColor: colors.placeholder }]} />
      <View style={styles.info}>
        <View style={[styles.bar, { width: '75%', backgroundColor: colors.placeholder }]} />
        <View style={[styles.bar, { width: '50%', marginTop: Spacing.sm, backgroundColor: colors.placeholder }]} />
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
  // Two lines reserved so the date lines of neighbouring cards align.
  name: { fontWeight: '600', marginBottom: 2, lineHeight: 17, minHeight: 34 },
  snippet: { marginTop: Spacing.xs },
  snippetHit: { fontWeight: '700' },
  moreChip: {
    position: 'absolute',
    end: Spacing.sm,
    bottom: Spacing.sm,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  rowInfo: { flex: 1, minWidth: 0 },
  rowName: { fontWeight: '600', lineHeight: 20 },
  rowMeta: { marginTop: 2 },
  // A shelf tile keeps its width in a horizontal row.
  tile: { flex: 0 },
  metaRow: { flexDirection: 'row', alignItems: 'center' },
  metaText: { flex: 1, minWidth: 0 },
  more: { alignItems: 'center', justifyContent: 'center', marginLeft: Spacing.xxs, marginRight: -Spacing.xxs },
  rowCheckbox: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  bar: { height: 10, borderRadius: 5 },
});
