// components/pdf-convert-banner.tsx
// The suggestion above an imported PDF to turn it into editable pages, styled
// like an iOS tip: icon, title, one plain sentence about what converting does,
// the action as a link, and a close button. Closing it hides it for that
// document for good (Convert to pages stays in the … menu); while a
// conversion runs it shows the progress instead, however it was started.
import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';
import type { ConvertProgress } from '@/lib/convert-pdf';

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

export function PdfConvertBanner({
  converting,
  onConvert,
  onDismiss,
}: {
  converting: ConvertProgress | null;
  onConvert: () => void;
  onDismiss: () => void;
}) {
  const { colors } = useTheme();
  const busy = !!converting;
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
