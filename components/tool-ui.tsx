// components/tool-ui.tsx
// Building blocks shared by the screens under app/tools/: the screen frame
// (header + scroll body + pinned action bar), the document picker rows, the
// option list, the empty state and a progress line. Keeping them here is what
// makes the tools look like one product instead of fifteen.
import { Children, createContext, Fragment, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
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
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { PageThumb } from '@/components/page-thumb';
import { useScan } from '@/contexts/scan-context';
import { SectionLabel } from '@/components/section-label';
import { HeaderTextButton, ScreenHeader } from '@/components/screen-header';
import { BottomSheet, SheetHeader } from '@/components/bottom-sheet';
import { PrimaryButton } from '@/components/primary-button';
import { AppIcon, type AppIconName } from '@/components/app-icon';
import { getDocuments } from '@/lib/storage';
import { usePdfThumbnail } from '@/lib/pdf-thumb';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';
import type { Document } from '@/types/document';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { noteNewDocument } from '@/lib/new-doc-note';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

/** Image-page documents (not imported PDFs) — what most page tools work on. */
export const isImageDoc = (d: Document) => !d.pdfUri && d.pages.length > 0;
/** Image-page documents with exactly one page (nothing to join or split yet). */
export const isSinglePageDoc = (d: Document) => !d.pdfUri && d.pages.length === 1;

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
  busy = false,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /** false when the body manages its own scrolling or is a centred hero. */
  scroll?: boolean;
  /** Temporarily lock scrolling (e.g. while drawing a signature). */
  scrollEnabled?: boolean;
  right?: ReactNode;
  /**
   * A change is being written to the document: the screen can't be closed
   * (back/close dimmed, swipe-back and Android back off) until it finishes,
   * so it is never left half-done (Sign / Watermark / Timestamp).
   */
  busy?: boolean;
}) {
  const router = useRouter();
  const navigation = useNavigation();
  useEffect(() => {
    if (!busy) return;
    navigation.setOptions({ gestureEnabled: false });
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => {
      sub.remove();
      navigation.setOptions({ gestureEnabled: true });
    };
  }, [busy, navigation]);
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
        backDisabled={busy}
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
 * The one intro every tool screen opens with: icon, heading and a short
 * explanation, top-aligned under the header (never vertically centred, so
 * every tool's intro sits at the same height). Below it comes either `points`,
 * a short "how it works" card (Book mode, Whiteboard, Extract text), or the
 * screen's own controls (Compress, Erase marks).
 */
export function ToolIntro({
  icon,
  title,
  text,
  points,
}: {
  icon: AppIconName;
  title: string;
  text: string;
  points?: IntroPoint[];
}) {
  const { colors } = useTheme();
  return (
    <View>
      <View style={styles.intro}>
        <View style={[styles.introIcon, { backgroundColor: colors.accentLight }]}>
          <AppIcon name={icon} size={32} color={colors.accent} />
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
 * receives the rendered page size in points. Until a document is chosen
 * (`uri` null) it is a dashed, page-shaped slot of exactly the same size, so
 * nothing below moves when the page arrives.
 */
export function PagePreview({
  uri,
  aspect,
  width,
  children,
  onPress,
}: {
  /** null: no document chosen yet, so an empty "Choose a document to preview" slot. */
  uri: string | null;
  aspect: number;
  width: number;
  children?: (size: { width: number; height: number }) => ReactNode;
  onPress?: (pt: { x: number; y: number }) => void;
}) {
  const { colors } = useTheme();
  const height = width * aspect;
  if (!uri) {
    return (
      <View
        style={[
          styles.emptySlot,
          { width: width + Spacing.sm * 2, height: height + Spacing.sm * 2, borderColor: colors.ring },
        ]}
        accessible
        accessibilityLabel="Preview. Choose a document to preview it here."
      >
        <View style={[styles.emptySlotIcon, { backgroundColor: colors.accentLight }]}>
          <Ionicons name="document-outline" size={22} color={colors.accent} />
        </View>
        <Text style={[Type.footnote, styles.center, styles.emptySlotText, { color: colors.muted }]}>
          {'Choose a document\nto preview'}
        </Text>
      </View>
    );
  }
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

/**
 * Single-choice indicator: the app's one selection idiom, a trailing accent
 * checkmark on the chosen row (as in Settings and every sheet). Unchosen rows
 * keep the same empty slot, so labels never shift when the choice moves.
 */
export function RadioMark({ selected }: { selected: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={styles.checkSlot}>
      {selected ? <Ionicons name="checkmark" size={22} color={colors.accent} /> : null}
    </View>
  );
}

/** A document's first page at thumbnail size, with a hairline so white pages keep their edge. */
export function DocThumb({ doc, width = 40, height = 52 }: { doc: Document; width?: number; height?: number }) {
  const { colors } = useTheme();
  const frame = [styles.thumb, { width, height, backgroundColor: colors.placeholder, borderColor: colors.thumbBorder }];
  // An imported PDF shows its first page once rendered (lib/pdf-thumb.ts), as in Files.
  const pdfThumb = usePdfThumbnail(doc.id, doc.pdfUri);
  if (doc.pdfUri && pdfThumb) return <PageThumb uri={pdfThumb} style={frame} />;
  return doc.pages[0] ? (
    <PageThumb uri={`${doc.pages[0]}?v=${doc.updatedAt}`} style={frame} />
  ) : (
    <View style={[frame, styles.thumbIcon]}>
      <Ionicons name="document-text-outline" size={20} color={colors.muted} />
    </View>
  );
}

/**
 * One document in a picker. Single choice shows a trailing checkmark on the
 * chosen row, like OptionList and Settings; `multi` shows a check ring on every row
 * (filled when chosen), and `order` numbers it for multi-select in a
 * meaningful order. Wrap rows in a DocGroup.
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
      {multi || order ? <SelectionMark selected={selected} order={order} /> : <RadioMark selected={selected} />}
    </Pressable>
  );
}

/**
 * A whole tool screen for "nothing to work on yet", laid out like every other
 * tool's first screen (Book mode, Whiteboard, Free up space): the tool's intro
 * at the top, the actions pinned in the footer.
 *
 * `addPagesTo`: the tool needs two or more pages (Long image, Extract pages)
 * and these documents have only one. Instead of a dead end, the main action
 * opens one of them in the viewer, where Add puts more pages in it.
 */
export function NoDocumentsScreen({
  toolTitle,
  icon,
  title,
  subtitle,
  addPagesTo,
}: {
  toolTitle: string;
  /** The tool's own icon, as on the Tools tab, so the tool keeps one glyph everywhere. */
  icon: AppIconName;
  title?: string;
  subtitle?: string;
  addPagesTo?: Document[];
}) {
  const router = useRouter();
  const { triggerScan } = useScan();
  const { colors } = useTheme();
  const [scanning, setScanning] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const chosen = useRef<Document | null>(null);
  const singles = addPagesTo ?? [];

  const scan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const id = await triggerScan();
      if (id) noteNewDocument(id);
      if (id) navigateWhenUnlocked(() => router.push({ pathname: '/viewer', params: { id } }));
    } finally {
      setScanning(false);
    }
  };
  const importPhotos = () =>
    router.navigate({ pathname: '/(tabs)/files', params: { action: 'importImages' } } as never);

  return (
    <ToolScreen
      title={toolTitle}
      footer={
        singles.length ? (
          <>
            <PrimaryButton title="Add pages to a document" icon="add" onPress={() => setChoosing(true)} />
            <PrimaryButton title="Scan a document" icon="camera-outline" variant="secondary" onPress={scan} loading={scanning} />
          </>
        ) : (
          <>
            <PrimaryButton title="Scan a document" icon="camera-outline" onPress={scan} loading={scanning} />
            <PrimaryButton title="Import photos" icon="images-outline" variant="secondary" onPress={importPhotos} />
          </>
        )
      }
    >
      <ToolIntro
        icon={icon}
        title={title ?? 'No documents yet'}
        text={subtitle ?? 'Scan or import a document first, then come back to this tool.'}
      />
      {singles.length ? (
        <BottomSheet
          visible={choosing}
          onClose={() => setChoosing(false)}
          variant="grouped"
          onDismissed={() => {
            const d = chosen.current;
            chosen.current = null;
            // Opens it in the viewer; its Add button (after the last page) adds more.
            if (d) {
              navigateWhenUnlocked(() =>
                router.push({ pathname: '/viewer', params: { id: d.id, notice: 'Tap Add to scan or import more pages' } }),
              );
            }
          }}
        >
          <SheetHeader title="Add pages to a document" subtitle="Choose one, then tap Add after its page." />
          <ScrollView style={styles.sheetList} showsVerticalScrollIndicator={false} bounces={false}>
            <DocGroup>
              {singles.map(d => (
                <Pressable
                  key={d.id}
                  onPress={() => {
                    chosen.current = d;
                    setChoosing(false);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`${d.name}, 1 page`}
                  accessibilityHint="Opens it to add pages"
                  style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.separator }]}
                >
                  <DocThumb doc={d} />
                  <View style={styles.flex}>
                    <Text style={[Type.body, { color: colors.text }]} numberOfLines={1}>{d.name}</Text>
                    <Text style={[Type.footnote, styles.meta, { color: colors.muted }]}>{pageCountLabel(d.pages.length)}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={colors.muted} />
                </Pressable>
              ))}
            </DocGroup>
          </ScrollView>
        </BottomSheet>
      ) : null}
    </ToolScreen>
  );
}

/** A grouped list of mutually exclusive options; the chosen one carries a trailing checkmark. */
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
            accessibilityState={{ checked: on, selected: on }}
            style={({ pressed }) => [
              styles.option,
              opt.detail ? styles.optionTall : null,
              i < options.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
              pressed && { opacity: 0.6 },
            ]}
          >
            <View style={styles.flex}>
              <Text style={[Type.body, styles.optionLabel, { color: colors.text }]}>{opt.label}</Text>
              {opt.detail ? (
                <Text style={[Type.footnote, styles.meta, styles.optionDetail, { color: colors.muted }]}>{opt.detail}</Text>
              ) : null}
            </View>
            <RadioMark selected={on} />
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

/**
 * Two footer actions side by side: a quieter alternative on the left, the
 * main action on the right (Sign / Watermark / Timestamp: "Save as a copy" and
 * "Add watermark"). One row instead of two stacked full-width buttons, so the
 * pinned footer doesn't cover the screen's last options. Both stay mounted;
 * pass `disabled` rather than leaving one out, so neither changes width.
 */
export function FooterActions({ secondary, primary }: { secondary: ReactNode; primary: ReactNode }) {
  return (
    <View style={styles.actions}>
      <View style={styles.actionSecondary}>{secondary}</View>
      <View style={styles.actionPrimary}>{primary}</View>
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
    paddingTop: Spacing.xxl,
    paddingBottom: Spacing.lg,
    gap: Spacing.sm,
  },
  introIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  introText: { lineHeight: 21 },
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
  mark: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  markEmpty: { borderWidth: 1.5 },
  checkSlot: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
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
  emptySlot: {
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.md,
    borderWidth: 1.5,
    borderStyle: 'dashed',
  },
  emptySlotIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  emptySlotText: { lineHeight: 18 },
  // Same metrics as SettingsRow (components/settings-list.tsx), so a choice
  // list in a tool and a list in Settings have rows of the same height: 52pt
  // for one line, label 22 / detail 18 line heights with 12pt padding for two.
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    minHeight: HIT + 8,
  },
  optionTall: { paddingVertical: Spacing.md },
  optionLabel: { lineHeight: 22 },
  optionDetail: { lineHeight: 18 },
  progress: { gap: Spacing.xs + 2 },
  sheetList: { flexGrow: 0, flexShrink: 1 },
  actions: { flexDirection: 'row', gap: Spacing.sm },
  // The main action gets the larger share: its label names the outcome
  // ("Sign all 3 pages"), the alternative is always "Save as a copy".
  actionSecondary: { flex: 4 },
  actionPrimary: { flex: 5 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
});
