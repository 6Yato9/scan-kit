// components/tool-ui.tsx
// Building blocks shared by the screens under app/tools/: the screen frame
// (header + scroll body + pinned action bar), the document picker rows, the
// option list, the empty state and a progress line. Keeping them here is what
// makes the tools look like one product instead of fifteen.
import { Children, createContext, Fragment, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { useScan } from '@/contexts/scan-context';
import { SectionLabel } from '@/components/section-label';
import { HeaderTextButton, ScreenHeader } from '@/components/screen-header';
import { EmptyState } from '@/components/empty-state';
import { getDocuments } from '@/lib/storage';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';
import type { Document } from '@/types/document';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

/** Image-page documents (not imported PDFs) — what most page tools work on. */
export const isImageDoc = (d: Document) => !d.pdfUri && d.pages.length > 0;

/**
 * Loads the documents a tool can work on, refreshing whenever the screen
 * regains focus. `loaded` lets callers avoid flashing the empty state.
 */
export function useToolDocuments(predicate: (d: Document) => boolean = isImageDoc) {
  const [docs, setDocs] = useState<Document[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [version, setVersion] = useState(0);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      getDocuments()
        .then(all => {
          if (cancelled) return;
          setDocs(all.filter(predicate).sort((a, b) => b.updatedAt - a.updatedAt));
          setLoaded(true);
        })
        .catch(() => {
          if (!cancelled) setLoaded(true);
        });
      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [version]),
  );

  const reload = useCallback(() => setVersion(v => v + 1), []);
  return { docs, loaded, reload };
}

/** Human file size: "840 KB", "2.4 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function pageCountLabel(n: number): string {
  return `${n} page${n === 1 ? '' : 's'}`;
}

/**
 * Standard pushed screen (every tool and every settings screen): chevron-back
 * ScreenHeader, scrolling body, and an optional action bar pinned above the
 * home indicator (keep the PrimaryButton in it mounted and toggle `disabled`,
 * so the layout never jumps).
 */
export function ToolScreen({
  title,
  children,
  footer,
  scroll = true,
  scrollEnabled = true,
  right,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /** false when the body manages its own scrolling or is a centred hero. */
  scroll?: boolean;
  /** Temporarily lock scrolling (e.g. while drawing a signature). */
  scrollEnabled?: boolean;
  right?: ReactNode;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  // Opened on a specific document from the viewer, a tool is presented as a
  // full-screen modal (see toolOptions in app/_layout.tsx), so it closes with
  // an x rather than going back with a chevron.
  const { docId } = useLocalSearchParams<{ docId?: string }>();

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: colors.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScreenHeader
        title={title}
        onBack={() => router.back()}
        backIcon={docId ? 'close' : 'back'}
        right={right}
      />
      {scroll ? (
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.body, !footer && { paddingBottom: insets.bottom + Spacing.xxl }]}
          scrollEnabled={scrollEnabled}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {children}
        </ScrollView>
      ) : (
        <View style={styles.flex}>{children}</View>
      )}
      {footer ? (
        <View
          style={[
            styles.footer,
            { paddingBottom: insets.bottom + Spacing.md, borderTopColor: colors.border, backgroundColor: colors.bg },
          ]}
        >
          {footer}
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

type IntroPoint = { icon: IconName; text: string };

/**
 * The one hero used by tool intros and tool empty states: icon, heading and a
 * short explanation, top-aligned under the header (never vertically centred,
 * so every tool's hero sits at the same height). `points` adds a short "how it
 * works" card under it. `compact` is a single row for screens with content
 * below (Erase marks).
 */
export function ToolIntro({
  icon,
  title,
  text,
  points,
  compact = false,
}: {
  icon: IconName;
  title: string;
  text: string;
  points?: IntroPoint[];
  compact?: boolean;
}) {
  const { colors } = useTheme();
  if (compact) {
    return (
      <View style={[styles.introCompact, { backgroundColor: colors.card }]}>
        <View style={[styles.introCompactIcon, { backgroundColor: colors.accentLight }]}>
          <Ionicons name={icon} size={24} color={colors.accent} />
        </View>
        <View style={styles.flex}>
          <Text style={[Type.headline, { color: colors.text }]}>{title}</Text>
          <Text style={[Type.footnote, styles.introCompactText, { color: colors.muted }]}>{text}</Text>
        </View>
      </View>
    );
  }
  return (
    <View>
      <View style={styles.intro}>
        <View style={[styles.introIcon, { backgroundColor: colors.accentLight }]}>
          <Ionicons name={icon} size={36} color={colors.accent} />
        </View>
        <Text style={[Type.title, styles.center, { color: colors.text }]} accessibilityRole="header">
          {title}
        </Text>
        <Text style={[Type.callout, styles.center, styles.introText, { color: colors.muted }]}>{text}</Text>
      </View>
      {points?.length ? (
        <View style={[styles.group, styles.points, { backgroundColor: colors.card }]}>
          {points.map((pt, i) => (
            <View key={pt.text} style={styles.point}>
              {/* Same tinted 30pt tile as SettingsRow: one list-icon treatment app-wide. */}
              <View style={[styles.pointIcon, { backgroundColor: colors.accentLight }]}>
                <Ionicons name={pt.icon} size={18} color={colors.accent} />
              </View>
              <View
                style={[
                  styles.pointBody,
                  i < points.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
                ]}
              >
                <Text style={[Type.callout, styles.pointText, { color: colors.text }]}>{pt.text}</Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Height ÷ width of an image file, or √2 (A4 portrait) until it is known. */
export function useImageAspect(uri: string | null | undefined): number {
  const [aspect, setAspect] = useState(Math.SQRT2);
  useEffect(() => {
    if (!uri) return;
    let live = true;
    Image.getSize(
      uri.split('?')[0],
      (w, h) => {
        if (live && w > 0 && h > 0) setAspect(h / w);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [uri]);
  return aspect;
}

/**
 * A page image at a fixed width with an overlay layer of exactly the same size,
 * so tools can preview stamps where they will land in the PDF. `children`
 * receives the rendered page size in points.
 */
export function PagePreview({
  uri,
  aspect,
  width,
  children,
  onPress,
}: {
  uri: string;
  aspect: number;
  width: number;
  children?: (size: { width: number; height: number }) => ReactNode;
  onPress?: (pt: { x: number; y: number }) => void;
}) {
  const { colors } = useTheme();
  const height = width * aspect;
  const body = (
    <View style={{ width, height }}>
      <Image source={{ uri }} style={{ width, height }} resizeMode="stretch" />
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {children?.({ width, height })}
      </View>
      {/* The page's edge, drawn over it so the overlay keeps exact page
          coordinates: a white page must not melt into its frame. */}
      <View style={[StyleSheet.absoluteFill, styles.previewEdge, { borderColor: colors.thumbBorder }]} pointerEvents="none" />
    </View>
  );
  return (
    <View style={[styles.previewFrame, { backgroundColor: colors.input }]}>
      {onPress ? (
        <Pressable
          onPress={e => onPress({ x: e.nativeEvent.locationX / width, y: e.nativeEvent.locationY / height })}
          accessibilityRole="adjustable"
          accessibilityLabel="Page preview. Tap to place."
        >
          {body}
        </Pressable>
      ) : (
        body
      )}
    </View>
  );
}

/**
 * A section label with a text action on the right ("Retake", "Select all").
 * It occupies exactly the space a plain SectionLabel does, so labels sit at
 * the same height on every tool screen whether or not they carry an action:
 * the 44pt button overhangs the label line through negative margins instead
 * of making the row taller.
 */
export function SectionRow({ label, action, onAction }: { label: string; action?: string; onAction?: () => void }) {
  return (
    <View style={styles.sectionRow}>
      <SectionLabel style={styles.sectionRowLabel}>{label}</SectionLabel>
      {action && onAction ? (
        <View style={styles.sectionAction}>
          <HeaderTextButton title={action} onPress={onAction} />
        </View>
      ) : null}
    </View>
  );
}

/** Small explanatory text under a group. */
export function ToolNote({ children }: { children: string }) {
  const { colors } = useTheme();
  return <Text style={[Type.footnote, styles.note, { color: colors.muted }]}>{children}</Text>;
}

// Rows rendered inside a DocGroup draw no card of their own.
const InDocGroup = createContext(false);

/**
 * The one document picker: an inset grouped card with hairline separators
 * (like OptionList). Put DocRows inside it.
 */
export function DocGroup({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  const rows = Children.toArray(children);
  return (
    <InDocGroup.Provider value>
      <View style={[styles.group, { backgroundColor: colors.card }]}>
        {rows.map((row, i) => (
          <Fragment key={i}>
            {i > 0 ? <View style={[styles.docSeparator, { backgroundColor: colors.border }]} /> : null}
            {row}
          </Fragment>
        ))}
      </View>
    </InDocGroup.Provider>
  );
}

/** Multi-select indicator: an empty ring, or a filled accent disc with a check or a number. */
export function SelectionMark({ selected, order }: { selected: boolean; order?: number }) {
  const { colors } = useTheme();
  if (!selected) return <View style={[styles.mark, styles.markEmpty, { borderColor: colors.ring }]} />;
  return (
    <View style={[styles.mark, { backgroundColor: colors.accentFill }]}>
      {order ? (
        <Text style={[styles.badgeText, { color: colors.onAccent }]}>{order}</Text>
      ) : (
        <Ionicons name="checkmark" size={16} color={colors.onAccent} />
      )}
    </View>
  );
}

/** A document's first page at thumbnail size, with a hairline so white pages keep their edge. */
export function DocThumb({ doc, width = 40, height = 52 }: { doc: Document; width?: number; height?: number }) {
  const { colors } = useTheme();
  const frame = [styles.thumb, { width, height, backgroundColor: colors.placeholder, borderColor: colors.thumbBorder }];
  return doc.pages[0] ? (
    <Image source={{ uri: `${doc.pages[0]}?v=${doc.updatedAt}` }} style={frame} resizeMode="cover" />
  ) : (
    <View style={[frame, styles.thumbIcon]}>
      <Ionicons name="document-text-outline" size={20} color={colors.muted} />
    </View>
  );
}

/**
 * One document in a picker. Single choice shows a checkmark on the chosen row,
 * like OptionList and Settings; `multi` shows a ring on every row (filled when
 * chosen), and `order` numbers it for multi-select in a meaningful order. Wrap
 * rows in a DocGroup.
 */
export function DocRow({
  doc,
  selected,
  onPress,
  order,
  multi,
}: {
  doc: Document;
  selected: boolean;
  onPress: () => void;
  order?: number;
  multi?: boolean;
}) {
  const { colors } = useTheme();
  const grouped = useContext(InDocGroup);
  const meta = doc.pdfUri ? 'PDF' : pageCountLabel(doc.pages.length);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={multi ? 'checkbox' : 'radio'}
      accessibilityState={multi ? { checked: selected } : { selected, checked: selected }}
      accessibilityLabel={`${doc.name}, ${meta}`}
      style={({ pressed }) => [
        styles.row,
        !grouped && [styles.rowCard, { backgroundColor: colors.card }],
        pressed && { backgroundColor: colors.separator },
      ]}
    >
      <DocThumb doc={doc} />
      <View style={styles.flex}>
        <Text style={[Type.body, { color: colors.text }]} numberOfLines={1}>
          {doc.name}
        </Text>
        <Text style={[Type.footnote, styles.meta, { color: colors.muted }]}>{meta}</Text>
      </View>
      {multi || order ? (
        <SelectionMark selected={selected} order={order} />
      ) : (
        // Single choice: the app's one idiom, a checkmark on the chosen row
        // (circles are only for multi-select). The slot keeps its width so the
        // name never reflows as the choice moves.
        <View style={styles.checkSlot}>
          {selected ? <Ionicons name="checkmark" size={22} color={colors.accent} /> : null}
        </View>
      )}
    </Pressable>
  );
}

/**
 * A whole tool screen for "nothing to work on yet". Uses the app's one empty
 * state (EmptyState, centred, actions under the text), so a tool with no
 * documents looks exactly like an empty list anywhere else.
 */
export function NoDocumentsScreen({ toolTitle, title, subtitle }: { toolTitle: string; title?: string; subtitle?: string }) {
  const router = useRouter();
  const { triggerScan } = useScan();
  const insets = useSafeAreaInsets();
  return (
    <ToolScreen title={toolTitle} scroll={false}>
      <View style={[styles.flex, { paddingBottom: insets.bottom + Spacing.xxl }]}>
        <EmptyState
          icon="documents-outline"
          title={title ?? 'No documents yet'}
          subtitle={subtitle ?? 'Scan or import a document first, then come back to this tool.'}
          actionLabel="Scan a document"
          actionIcon="camera-outline"
          onAction={async () => {
            const id = await triggerScan();
            if (id) router.push({ pathname: '/viewer', params: { id } });
          }}
          secondaryLabel="Import photos"
          onSecondaryAction={() => router.navigate({ pathname: '/(tabs)/files', params: { action: 'importImages' } } as never)}
        />
      </View>
    </ToolScreen>
  );
}

/** A grouped list of mutually exclusive options with a checkmark on the chosen one. */
export function OptionList<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; detail?: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.group, { backgroundColor: colors.card }]}>
      {options.map((opt, i) => {
        const on = opt.value === value;
        return (
          <Pressable
            key={String(opt.value)}
            onPress={() => onChange(opt.value)}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            style={({ pressed }) => [
              styles.option,
              i < options.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
              pressed && { opacity: 0.6 },
            ]}
          >
            <View style={styles.flex}>
              <Text style={[Type.body, { color: colors.text }]}>{opt.label}</Text>
              {opt.detail ? (
                <Text style={[Type.footnote, styles.meta, { color: colors.muted }]}>{opt.detail}</Text>
              ) : null}
            </View>
            {on ? <Ionicons name="checkmark" size={22} color={colors.accent} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** A compact single-choice row (3–4 short options): the app's one segmented control. */
export { SegmentedControl as Segmented } from '@/components/segmented-control';

/** A row of round colour swatches (ink colours are content, so they come from data, not the theme). */
export function ColorSwatches<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; color: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.swatches, { backgroundColor: colors.card }]} accessibilityRole="radiogroup">
      {options.map(opt => {
        const on = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, selected: on }}
            accessibilityLabel={opt.label}
            style={styles.swatchHit}
          >
            <View style={[styles.swatchRing, { borderColor: on ? colors.accent : 'transparent' }]}>
              <View style={[styles.swatch, { backgroundColor: opt.color }]}>
                {on ? <Ionicons name="checkmark" size={18} color={colors.onScrim} /> : null}
              </View>
            </View>
            <Text style={[Type.caption, { color: on ? colors.text : colors.muted, fontWeight: on ? '600' : '400' }]}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** "Processing page 2 of 5" with a thin bar; render it above the action button. */
export function ToolProgress({ label, current, total }: { label: string; current: number; total: number }) {
  const { colors } = useTheme();
  const pct = total > 0 ? Math.min(1, Math.max(0, current / total)) : 0;
  return (
    <View style={styles.progress} accessibilityRole="progressbar" accessibilityLabel={label}>
      <Text style={[Type.footnote, { color: colors.muted }]}>{label}</Text>
      <View style={[styles.track, { backgroundColor: colors.border }]}>
        <View style={[styles.fill, { backgroundColor: colors.accent, width: `${pct * 100}%` }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  body: { paddingHorizontal: Spacing.gutter, paddingBottom: Spacing.xxl },
  footer: {
    paddingHorizontal: Spacing.gutter,
    paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: Spacing.sm,
  },
  center: { textAlign: 'center' },
  intro: {
    alignItems: 'center',
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.xxxl,
    paddingBottom: Spacing.xl,
    gap: Spacing.sm,
  },
  introIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  introText: { lineHeight: 21 },
  introCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.lg,
    borderRadius: Radius.md,
    marginTop: Spacing.lg,
  },
  introCompactIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  introCompactText: { marginTop: 2, lineHeight: 18 },
  points: { marginTop: Spacing.sm },
  point: { flexDirection: 'row', alignItems: 'center', paddingLeft: Spacing.lg },
  pointIcon: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginRight: Spacing.md },
  pointBody: { flex: 1, paddingVertical: Spacing.md, paddingRight: Spacing.lg, minHeight: HIT + 4, justifyContent: 'center' },
  pointText: { lineHeight: 20 },
  note: { marginTop: Spacing.sm, marginHorizontal: Spacing.xs, lineHeight: 18 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.sm + 2,
    paddingLeft: Spacing.md,
    paddingRight: Spacing.lg,
    minHeight: HIT + 16,
  },
  rowCard: { borderRadius: Radius.md, marginBottom: Spacing.sm },
  // Inset to the text column, like iOS list separators.
  docSeparator: { height: StyleSheet.hairlineWidth, marginLeft: Spacing.md + 40 + Spacing.md },
  thumb: { borderRadius: 5, borderWidth: StyleSheet.hairlineWidth },
  thumbIcon: { alignItems: 'center', justifyContent: 'center' },
  meta: { marginTop: 2 },
  checkSlot: { width: 24, alignItems: 'center' },
  mark: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  markEmpty: { borderWidth: 1.5 },
  badgeText: { fontSize: 13, fontWeight: '700' },
  swatches: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    borderRadius: Radius.md,
    paddingVertical: Spacing.md,
  },
  swatchHit: { alignItems: 'center', gap: Spacing.xs + 2, minWidth: HIT + 20 },
  swatchRing: { padding: 3, borderRadius: 24, borderWidth: 2 },
  swatch: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  group: { borderRadius: Radius.md, overflow: 'hidden' },
  // Same outer spacing as SectionLabel (marginTop xxl, marginBottom sm).
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.xxl,
    marginBottom: Spacing.sm,
  },
  sectionRowLabel: { marginTop: 0, marginBottom: 0 },
  sectionAction: { marginVertical: -(HIT - 16) / 2, marginRight: -Spacing.xs },
  // A neutral mat around the page (like a document on a desk), so the page
  // reads as a sheet in both modes.
  previewFrame: {
    alignSelf: 'center',
    // Callers size the page assuming this padding (sign.tsx); keep it at sm.
    padding: Spacing.sm,
    borderRadius: Radius.md,
  },
  previewEdge: { borderWidth: StyleSheet.hairlineWidth },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    minHeight: HIT + 4,
  },
  progress: { gap: Spacing.xs + 2 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
});
