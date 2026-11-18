// components/tool-ui.tsx
// Building blocks shared by the screens under app/tools/: the screen frame
// (header + scroll body + pinned action bar), the document picker rows, the
// option list, the empty state and a progress line. Keeping them here is what
// makes the tools look like one product instead of fifteen.
import { ReactNode, useCallback, useEffect, useState } from 'react';
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
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { ScreenHeader } from '@/components/screen-header';
import { EmptyState } from '@/components/empty-state';
import { SectionLabel } from '@/components/section-label';
import { HeaderTextButton } from '@/components/screen-header';
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
 * Standard tool screen: chevron-back header, scrolling body, and an optional
 * action bar pinned above the home indicator (keep the PrimaryButton in it
 * mounted and toggle `disabled`, so the layout never jumps).
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

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: colors.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScreenHeader title={title} onBack={() => router.back()} right={right} />
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

/** Centred icon + heading + explanation, for the camera-first tools. */
export function ToolIntro({ icon, title, text }: { icon: IconName; title: string; text: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.intro}>
      <View style={[styles.introIcon, { backgroundColor: colors.accentLight }]}>
        <Ionicons name={icon} size={40} color={colors.accent} />
      </View>
      <Text style={[Type.title, styles.center, { color: colors.text }]}>{title}</Text>
      <Text style={[Type.callout, styles.center, styles.introText, { color: colors.muted }]}>{text}</Text>
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
    </View>
  );
  return (
    <View style={[styles.previewFrame, { backgroundColor: colors.card }]}>
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

/** A section label with a text action on the right ("Retake", "Select all"), baseline-aligned. */
export function SectionRow({ label, action, onAction }: { label: string; action?: string; onAction?: () => void }) {
  return (
    <View style={styles.sectionRow}>
      <SectionLabel style={styles.sectionRowLabel}>{label}</SectionLabel>
      {action && onAction ? <HeaderTextButton title={action} onPress={onAction} /> : null}
    </View>
  );
}

/** Small explanatory text under a group. */
export function ToolNote({ children }: { children: string }) {
  const { colors } = useTheme();
  return <Text style={[Type.footnote, styles.note, { color: colors.muted }]}>{children}</Text>;
}

/**
 * One document in a picker list. `order` shows a numbered badge (multi-select
 * in a meaningful order, e.g. merge); otherwise a checkmark marks the selection.
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
  const meta = doc.pdfUri ? 'PDF' : pageCountLabel(doc.pages.length);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${doc.name}, ${meta}`}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: colors.card, borderColor: selected ? colors.accent : colors.card },
        pressed && { opacity: 0.7 },
      ]}
    >
      {doc.pages[0] ? (
        <Image
          source={{ uri: `${doc.pages[0]}?v=${doc.updatedAt}` }}
          style={[styles.thumb, { backgroundColor: colors.placeholder }]}
          resizeMode="cover"
        />
      ) : (
        <View style={[styles.thumb, styles.thumbIcon, { backgroundColor: colors.placeholder }]}>
          <Ionicons name="document-text-outline" size={22} color={colors.muted} />
        </View>
      )}
      <View style={styles.flex}>
        <Text style={[Type.subhead, { color: colors.text }]} numberOfLines={1}>
          {doc.name}
        </Text>
        <Text style={[Type.footnote, styles.meta, { color: colors.muted }]}>{meta}</Text>
      </View>
      {order ? (
        <View style={[styles.badge, { backgroundColor: colors.accentFill }]}>
          <Text style={[styles.badgeText, { color: colors.onAccent }]}>{order}</Text>
        </View>
      ) : selected ? (
        <Ionicons name="checkmark" size={22} color={colors.accent} />
      ) : multi ? (
        <View style={[styles.badge, styles.badgeEmpty, { borderColor: colors.border }]} />
      ) : null}
    </Pressable>
  );
}

/**
 * Empty state for a tool that has no documents to work on, with a way out:
 * importing photos (the Files tab handles the flow).
 */
export function NoDocuments({ title, subtitle }: { title?: string; subtitle?: string }) {
  const router = useRouter();
  return (
    <View style={styles.empty}>
      <EmptyState
        icon="documents-outline"
        title={title ?? 'No documents yet'}
        subtitle={subtitle ?? 'Scan or import a document first, then come back to this tool.'}
        actionLabel="Import photos"
        onAction={() =>
          router.navigate({ pathname: '/(tabs)/files', params: { action: 'importImages' } } as never)
        }
      />
    </View>
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

/** A compact single-choice row (3–4 short options). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.segment, { backgroundColor: colors.input }]} accessibilityRole="radiogroup">
      {options.map(opt => {
        const on = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            style={[styles.segmentItem, on && [styles.segmentOn, { backgroundColor: colors.card }]]}
          >
            <Text style={[Type.subhead, { color: on ? colors.text : colors.muted }]} numberOfLines={1}>
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
  intro: { alignItems: 'center', paddingHorizontal: Spacing.xl, paddingVertical: Spacing.lg, gap: Spacing.md },
  introIcon: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.xs,
  },
  introText: { lineHeight: 21 },
  note: { marginTop: Spacing.sm, marginHorizontal: Spacing.xs, lineHeight: 18 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.sm + 2,
    paddingRight: Spacing.lg,
    borderRadius: Radius.md,
    marginBottom: Spacing.sm,
    borderWidth: 1.5,
    minHeight: HIT,
  },
  thumb: { width: 44, height: 58, borderRadius: 6 },
  thumbIcon: { alignItems: 'center', justifyContent: 'center' },
  meta: { marginTop: 2 },
  badge: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  badgeEmpty: { borderWidth: 1.5 },
  badgeText: { fontSize: 13, fontWeight: '700' },
  empty: { paddingVertical: Spacing.xxxl, minHeight: 360 },
  group: { borderRadius: Radius.md, overflow: 'hidden' },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.lg,
    marginBottom: Spacing.xs,
    minHeight: HIT,
  },
  sectionRowLabel: { marginTop: 0, marginBottom: 0 },
  segment: { flexDirection: 'row', borderRadius: Radius.sm + 2, padding: 3 },
  segmentItem: {
    flex: 1,
    minHeight: HIT - 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.xs,
  },
  segmentOn: {
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  previewFrame: {
    alignSelf: 'center',
    padding: Spacing.sm,
    borderRadius: Radius.md,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
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
