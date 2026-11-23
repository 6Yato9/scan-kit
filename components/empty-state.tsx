// components/empty-state.tsx
// Every empty list uses this, with an action wherever one makes sense.
import { StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppIcon, type AppIconName } from '@/components/app-icon';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { Colors, READABLE_WIDTH, Spacing, Type } from '@/lib/theme';

type Variant = 'no-docs' | 'empty-folder' | 'no-search-results';
type IconName = keyof typeof Ionicons.glyphMap;

type Props = {
  variant?: Variant;
  folderName?: string;
  query?: string;
  onAction?: () => void;
  actionLabel?: string;
  actionIcon?: IconName;
  /** The primary action is running (spinner, not tappable). */
  actionLoading?: boolean;
  /** Optional second, quieter action (e.g. "Import file"). */
  onSecondaryAction?: () => void;
  secondaryLabel?: string;
  /** Icon for the second action; give it one whenever the primary has one. */
  secondaryIcon?: IconName;
  /** Override the variant's copy. */
  title?: string;
  subtitle?: string;
  icon?: AppIconName;
  /** On the always-dark viewer chrome (e.g. a PDF that can't be shown). */
  chrome?: boolean;
  /**
   * 'top' (default): the hero sits at the top of the space, at the same height
   * as every tool's intro (ToolIntro), so an empty list and a tool's first
   * screen look alike. 'center' only where the space is a page frame (the
   * viewer's PDF that can't be shown).
   */
  placement?: 'top' | 'center';
};

/** The one hero size: a 72pt tinted disc with a 32pt glyph (EmptyState, ToolIntro). */
export const HERO_DISC = 72;
const HERO_GLYPH = 32;
/** A comfortable line length for the title and text on a wide screen. */
const TEXT_MAX_WIDTH = 520;

/** The tinted disc and glyph that heads every empty state and tool intro. */
export function HeroIcon({ name, tint, color }: { name: AppIconName; tint: string; color: string }) {
  return (
    <View style={[styles.iconCircle, { backgroundColor: tint }]}>
      <AppIcon name={name} size={HERO_GLYPH} color={color} />
    </View>
  );
}

const COPY: Record<Variant, { title: string; subtitle: string; icon: IconName }> = {
  'no-docs':           { icon: 'scan-outline',        title: 'No documents yet',      subtitle: 'Scan a document with the camera or import one to get started.' },
  'empty-folder':      { icon: 'folder-open-outline', title: 'This folder is empty',  subtitle: 'Tap the More button on a document and choose Move to folder to add it here.' },
  'no-search-results': { icon: 'search-outline',      title: 'No results',            subtitle: 'Try a different search term.' },
};

export function EmptyState({
  variant = 'no-docs',
  folderName,
  query,
  onAction,
  actionLabel,
  actionIcon,
  actionLoading,
  onSecondaryAction,
  secondaryLabel,
  secondaryIcon,
  title,
  subtitle,
  icon,
  chrome = false,
  placement = 'top',
}: Props) {
  const { colors } = useTheme();
  // The viewer is dark in both themes: the dark palette's tint, chrome text.
  const tint = chrome ? Colors.dark.accentLight : colors.accentLight;
  const iconColor = chrome ? colors.chromeAccent : colors.accent;
  const titleColor = chrome ? colors.chromeText : colors.text;
  const bodyColor = chrome ? colors.chromeMuted : colors.muted;
  const copy = COPY[variant];
  const heading = title
    ?? (variant === 'empty-folder' && folderName ? `“${folderName}” is empty` : copy.title);
  const body = subtitle
    ?? (variant === 'no-search-results' && query ? `No documents match “${query}”.` : copy.subtitle);
  return (
    <View style={[styles.container, placement === 'center' && styles.centered]}>
      <HeroIcon name={icon ?? copy.icon} tint={tint} color={iconColor} />
      <Text style={[Type.title, styles.title, { color: titleColor }]}>{heading}</Text>
      <Text style={[Type.callout, styles.subtitle, { color: bodyColor }]}>{body}</Text>
      {onAction && actionLabel ? (
        <View style={styles.actions}>
          <PrimaryButton title={actionLabel} icon={actionIcon} onPress={onAction} loading={actionLoading} />
          {onSecondaryAction && secondaryLabel ? (
            <PrimaryButton title={secondaryLabel} icon={secondaryIcon} variant="secondary" onPress={onSecondaryAction} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    // Buttons sit at the screen gutter like every other full-width button;
    // the text is held narrower so it wraps into a comfortable measure.
    paddingHorizontal: Spacing.gutter,
    // Same top inset as ToolIntro, so the hero lands at the same height.
    paddingTop: Spacing.xxl,
    paddingBottom: Spacing.xxxl,
  },
  centered: { justifyContent: 'center', paddingTop: Spacing.xxxl },
  // ToolIntro's spacing: 20pt from the disc to the title.
  iconCircle: {
    width: HERO_DISC,
    height: HERO_DISC,
    borderRadius: HERO_DISC / 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.xl,
  },
  // On an iPad the text keeps a readable measure and the buttons the same
  // column as the tool screens' (a phone is unchanged).
  title: { marginBottom: Spacing.sm, textAlign: 'center', paddingHorizontal: Spacing.xxl, maxWidth: TEXT_MAX_WIDTH },
  subtitle: { textAlign: 'center', lineHeight: 21, paddingHorizontal: Spacing.xxl, maxWidth: TEXT_MAX_WIDTH },
  actions: { marginTop: Spacing.xxl, width: '100%', maxWidth: READABLE_WIDTH, gap: Spacing.sm },
});
