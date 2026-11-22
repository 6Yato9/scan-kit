// components/pdf-convert-banner.tsx
// The suggestion above an imported PDF to turn it into editable pages, styled
// like an iOS tip: icon, title, one plain sentence about what converting does,
// the action as a link, and a close button. Closing it hides it for that
// document for good (Convert to pages stays in the … menu); while a
// conversion runs it shows the progress instead, however it was started.
//
// On a PDF with a form, or one already filled in or signed here, converting is
// rarely what you want (Fill & sign works on it as it is) and it flattens the
// form: the suggestion shrinks to one quiet row whose text says so.
import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@/contexts/theme-context';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';
import type { ConvertProgress } from '@/lib/convert-pdf';
import { useFillAccess, useFilledPdf } from '@/lib/fill-access';

const DISMISSED_KEY = 'pdfConvertBanner.dismissed';
/** Plenty for every PDF anyone keeps; the oldest ids fall off first. */
const MAX_REMEMBERED = 500;

/** The ids list after hiding the banner for `id` (deduplicated, capped). */
export function withDismissed(ids: string[], id: string, max = MAX_REMEMBERED): string[] {
  return [...ids.filter(x => x !== id), id].slice(-max);
}

async function readDismissed(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Whether the convert suggestion is hidden for this document. `null` until
 * read, so the banner never flashes in and back out.
 */
export function useConvertBannerDismissed(docId: string | undefined): [boolean | null, () => void] {
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  useEffect(() => {
    if (!docId) return;
    let alive = true;
    readDismissed().then(ids => { if (alive) setDismissed(ids.includes(docId)); });
    return () => { alive = false; };
  }, [docId]);
  const dismiss = useCallback(() => {
    if (!docId) return;
    setDismissed(true);
    readDismissed()
      .then(ids => AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify(withDismissed(ids, docId))))
      .catch(() => {});
  }, [docId]);
  return [dismissed, dismiss];
}

/** What converting would flatten, for the quiet variant (null: nothing to warn about). */
export function convertWarning(hasFields: boolean, filled: boolean): string | null {
  if (hasFields) return 'Its form fields and any signatures become part of the page image.';
  if (filled) return 'Its signatures and added text become part of the page image.';
  return null;
}

export function PdfConvertBanner({
  converting,
  onConvert,
  onDismiss,
  docId,
  pdfUri,
}: {
  converting: ConvertProgress | null;
  onConvert: () => void;
  onDismiss: () => void;
  /** The PDF shown: a form, or one filled in here, gets the quiet variant. */
  docId?: string;
  pdfUri?: string | null;
}) {
  const { colors } = useTheme();
  const busy = !!converting;
  const access = useFillAccess(pdfUri ?? null);
  const filled = useFilledPdf(docId);
  const warning = convertWarning(!!access?.hasFields, !!filled);
  // Which variant isn't known yet: nothing, rather than the big one flashing first.
  if (!busy && ((pdfUri && access === null) || (docId && filled === null))) return null;

  if (!busy && warning) {
    return (
      <View style={[styles.quiet, { borderColor: colors.chromeBorder }]}>
        <Pressable
          onPress={onConvert}
          accessibilityRole="button"
          accessibilityLabel="Convert to pages"
          accessibilityHint={`Turns each page into an image you can crop, filter and mark up. ${warning}`}
          style={({ pressed }) => [styles.quietBody, pressed && { opacity: 0.6 }]}
        >
          <Ionicons name="images-outline" size={18} color={colors.chromeMuted} style={styles.quietIcon} />
          <View style={styles.body}>
            <Text style={[Type.footnote, styles.quietTitle, { color: colors.chromeText }]} numberOfLines={1} maxFontSizeMultiplier={1.4}>
              Convert to pages
            </Text>
            <Text style={[Type.footnote, styles.quietText, { color: colors.chromeMuted }]} numberOfLines={2} maxFontSizeMultiplier={1.4}>
              {warning}
            </Text>
          </View>
        </Pressable>
        <Pressable
          onPress={onDismiss}
          style={({ pressed }) => [styles.quietClose, pressed && { opacity: 0.6 }]}
          accessibilityRole="button"
          accessibilityLabel="Hide this suggestion"
          accessibilityHint="Convert to pages stays in the More actions menu"
        >
          <Ionicons name="close" size={16} color={colors.chromeMuted} />
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.banner, { backgroundColor: colors.chromeRaised }]} accessibilityLiveRegion="polite">
      <View style={styles.icon}>
        {busy ? (
          <ActivityIndicator color={colors.chromeText} />
        ) : (
          <Ionicons name="images-outline" size={22} color={colors.chromeAccent} />
        )}
      </View>
      <View style={styles.body}>
        <Text style={[Type.subhead, styles.title, { color: colors.chromeText }]} numberOfLines={1}>
          {busy ? 'Converting to pages…' : 'Edit this PDF as pages'}
        </Text>
        <Text style={[Type.footnote, styles.text, { color: colors.chromeMuted }]}>
          {busy
            ? converting.stage === 'saving'
              ? `Saving page ${converting.done} of ${converting.total}`
              : 'Reading the PDF'
            : 'Turns each page into an image you can crop, filter and mark up. You can undo it straight after.'}
        </Text>
        {busy ? null : (
          <Pressable
            onPress={onConvert}
            hitSlop={{ top: 8, bottom: 10, left: 8, right: 16 }}
            accessibilityRole="button"
            accessibilityLabel="Convert to pages"
            style={({ pressed }) => [styles.action, pressed && { opacity: 0.6 }]}
          >
            <Text style={[Type.subhead, styles.actionText, { color: colors.chromeAccent }]}>Convert to pages</Text>
          </Pressable>
        )}
      </View>
      {busy ? null : (
        <Pressable
          onPress={onDismiss}
          style={({ pressed }) => [styles.close, pressed && { opacity: 0.6 }]}
          accessibilityRole="button"
          accessibilityLabel="Hide this suggestion"
          accessibilityHint="Convert to pages stays in the More actions menu"
        >
          <Ionicons name="close" size={18} color={colors.chromeMuted} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginHorizontal: Spacing.gutter,
    marginBottom: Spacing.sm,
    paddingLeft: Spacing.md,
    paddingVertical: Spacing.md,
    borderRadius: Radius.md,
    gap: Spacing.md,
  },
  icon: { width: 24, height: 20, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, minWidth: 0, paddingRight: Spacing.md },
  title: { fontWeight: '600', lineHeight: 20 },
  text: { marginTop: 2, lineHeight: 18 },
  action: { alignSelf: 'flex-start', marginTop: Spacing.sm },
  actionText: { fontWeight: '600' },
  // The quiet variant: one hairline-framed row, no fill, muted icon.
  quiet: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: Spacing.gutter,
    marginBottom: Spacing.sm,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  quietBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: Spacing.sm + 2, paddingLeft: Spacing.md, paddingVertical: Spacing.sm, minHeight: HIT },
  quietIcon: { width: 20, textAlign: 'center' },
  quietTitle: { fontWeight: '600' },
  quietText: { lineHeight: 17 },
  quietClose: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  // The glyph sits in the corner; the 44pt target extends into the padding.
  close: {
    width: HIT,
    height: HIT,
    marginTop: -Spacing.md,
    marginLeft: -Spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
