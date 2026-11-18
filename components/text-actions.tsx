// components/text-actions.tsx
// What you can do with a page's recognized text besides copying it, shown
// under the text in the viewer's Recognized text sheet and the Extract text
// tool:
//   - Read aloud (system voices, in the text's language) with the sentence
//     being read shown above the chips, its current word highlighted;
//   - one chip per phone number, email, link, address and date found in the
//     text (NSDataDetector), each offering its action and Copy;
//   - one chip per QR code or barcode on the page image (Vision).
// Everything runs on the device. Nothing is shown when there is nothing to do.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActionSheetIOS,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { notifyError, notifySuccess, tapLight } from '@/lib/haptics';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';
import { hasReadableText, sentenceAt, useReadAloud } from '@/lib/read-aloud';
import {
  addDateToCalendar,
  barcodeTypeLabel,
  canAddToCalendar,
  detectBarcodes,
  detectData,
  detectionLabel,
  mapsUrl,
  openExternal,
  openWebLink,
  telUrl,
  webUrl,
  type DetectedBarcode,
  type DetectedData,
} from '@/lib/text-actions';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

const ICONS: Record<DetectedData['type'], IconName> = {
  phone: 'call-outline',
  email: 'mail-outline',
  url: 'globe-outline',
  address: 'location-outline',
  date: 'calendar-outline',
};

const KIND_NAMES: Record<DetectedData['type'], string> = {
  phone: 'Phone number',
  email: 'Email address',
  url: 'Link',
  address: 'Address',
  date: 'Date',
};

/** Height the chip row adds under the text (a sheet reserves it above the keyboard). */
export const TEXT_ACTIONS_HEIGHT = 36 + Spacing.xs * 2 + Spacing.sm;

type Props = {
  text: string;
  /** Center the chips (a short row under a centered message). */
  centered?: boolean;
  /**
   * The parent's horizontal padding: the chip row scrolls out to the screen or
   * sheet edges instead of being clipped inside the padding.
   */
  bleed?: number;
  /** The page image, to look for QR codes and barcodes on it. */
  imageUri?: string | null;
  style?: StyleProp<ViewStyle>;
};

/** Offers a choice of actions for one chip: an action sheet on iOS, an alert elsewhere. */
function chooseAction(title: string, message: string | undefined, actions: { label: string; run: () => void }[]) {
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      { title, message, options: [...actions.map(a => a.label), 'Cancel'], cancelButtonIndex: actions.length },
      i => {
        if (i >= 0 && i < actions.length) actions[i].run();
      },
    );
    return;
  }
  Alert.alert(title, message, [
    ...actions.map(a => ({ text: a.label, onPress: a.run })),
    { text: 'Cancel', style: 'cancel' as const },
  ]);
}

export function TextActions({ text, imageUri, centered = false, bleed = 0, style }: Props) {
  const { colors } = useTheme();
  const reader = useReadAloud(text);
  const [found, setFound] = useState<DetectedData[]>([]);
  const [codes, setCodes] = useState<DetectedBarcode[]>([]);
  // Brief confirmation shown in a chip ("Copied", "Added") instead of a toast,
  // which a sheet would cover.
  const [done, setDone] = useState<{ key: string; label: string } | null>(null);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
    if (doneTimer.current) clearTimeout(doneTimer.current);
  }, []);

  // Detect data in the text; wait while it is being typed.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      detectData(text).then(r => {
        if (!cancelled) setFound(r);
      });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [text]);

  useEffect(() => {
    let cancelled = false;
    setCodes([]);
    if (!imageUri) return;
    detectBarcodes(imageUri)
      .then(r => {
        if (!cancelled) setCodes(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [imageUri]);

  const confirm = useCallback((key: string, label: string) => {
    if (!mounted.current) return;
    if (doneTimer.current) clearTimeout(doneTimer.current);
    setDone({ key, label });
    AccessibilityInfo.announceForAccessibility(label);
    doneTimer.current = setTimeout(() => setDone(null), 1800);
  }, []);

  const copy = useCallback(
    async (key: string, value: string) => {
      await Clipboard.setStringAsync(value);
      notifySuccess();
      confirm(key, 'Copied');
    },
    [confirm],
  );

  const open = useCallback(async (url: string, failTitle: string, failText: string) => {
    if (!(await openExternal(url))) {
      notifyError();
      Alert.alert(failTitle, failText);
    }
  }, []);

  const onData = useCallback(
    (d: DetectedData, key: string) => {
      tapLight();
      const copyIt = { label: 'Copy', run: () => { copy(key, d.type === 'date' || d.type === 'address' ? d.text : d.value); } };
      const label = detectionLabel(d, 60);
      switch (d.type) {
        case 'phone':
          chooseAction(label, undefined, [
            { label: 'Call', run: () => { open(telUrl(d.value), 'Couldn’t start a call', 'This device can’t make phone calls. Copy the number instead.'); } },
            copyIt,
          ]);
          return;
        case 'email':
          chooseAction(label, undefined, [
            {
              label: 'Write email',
              run: () => {
                open(`mailto:${d.value}`, 'Couldn’t open Mail', 'Set up an email account in the Mail app, or copy the address instead.');
              },
            },
            copyIt,
          ]);
          return;
        case 'url':
          chooseAction(label, undefined, [
            {
              label: 'Open link',
              run: () => {
                openWebLink(d.value).then(ok => {
                  if (!ok) Alert.alert('Couldn’t open the link', 'Copy it and open it in your browser instead.');
                });
              },
            },
            copyIt,
          ]);
          return;
        case 'address':
          chooseAction(d.text.replace(/\s+/g, ' ').trim(), undefined, [
            { label: 'Open in Maps', run: () => { open(mapsUrl(d.text), 'Couldn’t open Maps', 'Copy the address instead.'); } },
            copyIt,
          ]);
          return;
        case 'date': {
          const actions = [copyIt];
          if (canAddToCalendar()) {
            actions.unshift({
              label: 'Add to calendar',
              run: () => {
                addDateToCalendar(d, text).then(outcome => {
                  if (outcome === 'saved') {
                    notifySuccess();
                    confirm(key, 'Added');
                  } else if (outcome === 'denied') {
                    Alert.alert(
                      'Calendar access is off',
                      'To add events, allow Scan Kit to use your calendars in Settings.',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Open Settings', onPress: () => { Linking.openSettings(); } },
                      ],
                    );
                  } else if (outcome === 'unavailable') {
                    Alert.alert('Couldn’t open Calendar', 'Try again in a moment.');
                  }
                });
              },
            });
          }
          chooseAction(label, undefined, actions);
        }
      }
    },
    [copy, open, confirm, text],
  );

  const onCode = useCallback(
    (c: DetectedBarcode, key: string) => {
      tapLight();
      const link = webUrl(c.payload);
      const actions = [{ label: 'Copy', run: () => { copy(key, c.payload); } }];
      if (link) {
        actions.unshift({
          label: 'Open link',
          run: () => {
            openWebLink(link).then(ok => {
              if (!ok) Alert.alert('Couldn’t open the link', 'Copy it and open it in your browser instead.');
            });
          },
        });
      }
      const preview = c.payload.length > 160 ? `${c.payload.slice(0, 159)}…` : c.payload;
      chooseAction(barcodeTypeLabel(c.symbology), preview, actions);
    },
    [copy],
  );

  const readable = reader.available && hasReadableText(text);
  const reading = reader.state !== 'idle';
  if (!readable && !found.length && !codes.length) return null;

  const chip = (key: string, icon: IconName, label: string, a11y: string, onPress: () => void) => {
    const confirmed = done?.key === key;
    return (
      <Pressable
        key={key}
        onPress={onPress}
        hitSlop={{ top: 4, bottom: 4 }}
        accessibilityRole="button"
        accessibilityLabel={a11y}
        style={({ pressed }) => [styles.chip, { backgroundColor: colors.accentLight }, pressed && styles.pressed]}
      >
        <Ionicons name={confirmed ? 'checkmark' : icon} size={16} color={colors.accent} />
        <Text style={[Type.footnote, styles.chipText, { color: colors.accent }]} numberOfLines={1}>
          {confirmed ? done.label : label}
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={[styles.wrap, style]}>
      {reading ? <ReadAlong reader={reader} /> : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.row, { paddingHorizontal: bleed }, centered && styles.rowCentered]}
        style={[styles.scroller, { marginHorizontal: -bleed }]}
      >
        {readable && !reading
          ? chip('read', 'volume-high-outline', 'Read aloud', 'Read aloud', () => {
              tapLight();
              reader.start();
            })
          : null}
        {found.map((d, i) => {
          const key = `${d.type}-${d.range[0]}-${i}`;
          return chip(key, ICONS[d.type], detectionLabel(d), `${KIND_NAMES[d.type]}: ${detectionLabel(d, 80)}`, () => onData(d, key));
        })}
        {codes.map((c, i) => {
          const key = `code-${i}`;
          const name = barcodeTypeLabel(c.symbology);
          const label = webUrl(c.payload) ? c.payload.replace(/^https?:\/\//i, '').replace(/\/$/, '') : c.payload;
          return chip(
            key,
            c.symbology === 'qr' ? 'qr-code-outline' : 'barcode-outline',
            label.length > 32 ? `${label.slice(0, 31).trimEnd()}…` : label,
            `${name} on this page: ${label}`,
            () => onCode(c, key),
          );
        })}
      </ScrollView>
    </View>
  );
}

/** A wrapped sentence on one line. */
const flat = (t: string) => t.replace(/\s*\n\s*/g, ' ');

/** The sentence being read, its current word highlighted, with pause / resume and stop. */
function ReadAlong({ reader }: { reader: ReturnType<typeof useReadAloud> }) {
  const { colors } = useTheme();
  // Where the sentence shown stays between words (no range is reported for spaces).
  const lastWord = useRef(0);
  const source = reader.spoken;
  if (reader.word) lastWord.current = reader.word[0];
  const at = lastWord.current;
  const [s, e] = sentenceAt(source, at);
  let word = reader.word && reader.word[0] >= s && reader.word[1] <= e ? reader.word : null;
  if (word) {
    // Highlight the word, not the comma or full stop after it.
    let end = word[1];
    while (end > word[0] + 1 && /[\s,.;:!?…)"'»]/.test(source[end - 1])) end--;
    word = [word[0], end];
  }
  const sentence = flat(source.slice(s, e));
  const paused = reader.state === 'paused';
  const starting = reader.state === 'starting';

  return (
    <View style={[styles.readAlong, { backgroundColor: colors.accentLight }]}>
      <View style={styles.readText}>
        <Text style={[Type.caption, styles.readLabel, { color: colors.accent }]}>
          {paused ? 'Paused' : starting ? 'Starting…' : 'Reading aloud'}
        </Text>
        <Text style={[Type.callout, styles.readSentence, { color: colors.text }]} numberOfLines={3} accessibilityLiveRegion="polite">
          {word ? (
            <>
              {flat(source.slice(s, word[0]))}
              <Text style={[styles.word, { backgroundColor: colors.accent, color: colors.onAccent }]}>
                {flat(source.slice(word[0], word[1]))}
              </Text>
              {flat(source.slice(word[1], e))}
            </>
          ) : (
            sentence
          )}
        </Text>
      </View>
      <Pressable
        onPress={() => {
          tapLight();
          if (paused) reader.resume();
          else reader.pause();
        }}
        disabled={starting}
        hitSlop={4}
        accessibilityRole="button"
        accessibilityLabel={paused ? 'Resume reading' : 'Pause reading'}
        style={({ pressed }) => [styles.readBtn, pressed && styles.pressed]}
      >
        <Ionicons name={paused ? 'play' : 'pause'} size={22} color={colors.accent} />
      </Pressable>
      <Pressable
        onPress={() => {
          tapLight();
          reader.stop();
        }}
        hitSlop={4}
        accessibilityRole="button"
        accessibilityLabel="Stop reading"
        style={({ pressed }) => [styles.readBtn, pressed && styles.pressed]}
      >
        <Ionicons name="stop" size={20} color={colors.accent} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Spacing.sm },
  scroller: { flexGrow: 0 },
  row: { gap: Spacing.sm, alignItems: 'center', paddingVertical: Spacing.xs },
  rowCentered: { flexGrow: 1, justifyContent: 'center' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs + 2,
    height: 36,
    maxWidth: 260,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.pill,
  },
  chipText: { fontWeight: '600', flexShrink: 1 },
  pressed: { opacity: 0.55 },
  readAlong: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.md,
    paddingLeft: Spacing.md,
    paddingRight: Spacing.xs,
    paddingVertical: Spacing.sm,
    gap: Spacing.xs,
  },
  readText: { flex: 1, gap: 2 },
  readLabel: { fontWeight: '600' },
  // Three lines tall whatever the sentence, so the sheet doesn't jump as reading moves on.
  readSentence: { lineHeight: 20, minHeight: 60 },
  word: { borderRadius: 3 },
  readBtn: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
});
