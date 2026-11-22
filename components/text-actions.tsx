// components/text-actions.tsx
// What you can do with a page's recognized text besides copying it, shown
// under the text in the viewer's Recognized text sheet and the Extract text
// tool:
//   - Read aloud (system voices, in the text's language) with the sentence
//     being read shown, its current word highlighted;
//   - one chip per phone number, email, link, address and date found in the
//     text (NSDataDetector), each offering its action and Copy;
//   - one chip per QR code or barcode on the page image (Vision).
// Everything runs on the device. Nothing is shown when there is nothing to do.
//
// RecognizedTextPanel is the viewer's whole Recognized text body: the text,
// Read aloud as a control beside Edit (not a chip: chips are data found in
// the text), the chips and the sheet's footer. While the text is edited the
// chips and the footer step aside for the keyboard; while it is read aloud
// the player takes the place of the chips and the footer, at their height,
// so nothing jumps.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { ActionSheet } from '@/components/action-sheet';
import type { AppIconName } from '@/components/app-icon';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { notifyError, notifySuccess, tapLight } from '@/lib/haptics';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';
import { hasReadableText, sentenceAt, useReadAloud } from '@/lib/read-aloud';
import { RecognizedText } from '@/components/recognized-text';
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
  /**
   * Offer Read aloud as the first chip, with the player above the chips
   * (default). RecognizedTextPanel turns it off and offers it beside Edit.
   */
  readAloud?: boolean;
  style?: StyleProp<ViewStyle>;
};

type ChipAction = { label: string; run: () => void; icon?: AppIconName };

/**
 * Offers a choice of actions for one chip: the system action sheet on iOS,
 * the app's own action sheet on Android (components/action-sheet.tsx; its
 * dialogs drop every button past the third).
 */
function chooseAction(title: string, message: string | undefined, actions: ChipAction[]) {
  ActionSheet.showActionSheetWithOptions(
    {
      title,
      message,
      options: [...actions.map(a => a.label), 'Cancel'],
      cancelButtonIndex: actions.length,
      icons: actions.map(a => a.icon),
    },
    i => {
      if (i >= 0 && i < actions.length) actions[i].run();
    },
  );
}

export function TextActions({ text, imageUri, centered = false, bleed = 0, readAloud = true, style }: Props) {
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
      const copyIt: ChipAction = { label: 'Copy', icon: 'copy-outline', run: () => { copy(key, d.type === 'date' || d.type === 'address' ? d.text : d.value); } };
      const label = detectionLabel(d, 60);
      switch (d.type) {
        case 'phone':
          chooseAction(label, undefined, [
            { label: 'Call', icon: 'call-outline', run: () => { open(telUrl(d.value), 'Couldn’t start a call', 'This device can’t make phone calls. Copy the number instead.'); } },
            copyIt,
          ]);
          return;
        case 'email':
          chooseAction(label, undefined, [
            {
              label: 'Write email',
              icon: 'mail-outline',
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
              icon: 'open-outline',
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
            { label: 'Open in Maps', icon: 'map-outline', run: () => { open(mapsUrl(d.text), 'Couldn’t open Maps', 'Copy the address instead.'); } },
            copyIt,
          ]);
          return;
        case 'date': {
          const actions: ChipAction[] = [copyIt];
          if (canAddToCalendar()) {
            actions.unshift({
              label: 'Add to calendar',
              icon: 'calendar-outline',
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
      const actions: ChipAction[] = [{ label: 'Copy', icon: 'copy-outline', run: () => { copy(key, c.payload); } }];
      if (link) {
        actions.unshift({
          label: 'Open link',
          icon: 'open-outline',
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

  const readable = readAloud && reader.available && hasReadableText(text);
  const reading = readAloud && reader.state !== 'idle';
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

const READ_LINE = 20;

/**
 * The sentence being read, its current word highlighted, with pause / resume
 * (and stop, unless `height` is given). With `height` it is laid out to fill
 * exactly that height (RecognizedTextPanel puts it in the place of the chips
 * and the footer): as many lines as fit, and on a single line the words just
 * before the current one are skipped so it stays in view.
 */
function ReadAlong({ reader, height }: { reader: ReturnType<typeof useReadAloud>; height?: number }) {
  const { colors } = useTheme();
  // Where the sentence shown stays between words (no range is reported for spaces).
  const lastWord = useRef(0);
  const source = reader.spoken;
  if (reader.word) lastWord.current = reader.word[0];
  const at = lastWord.current;
  const [s0, e] = sentenceAt(source, at);
  let word = reader.word && reader.word[0] >= s0 && reader.word[1] <= e ? reader.word : null;
  if (word) {
    // Highlight the word, not the comma or full stop after it.
    let end = word[1];
    while (end > word[0] + 1 && /[\s,.;:!?…)"'»]/.test(source[end - 1])) end--;
    word = [word[0], end];
  }
  const fitted = height !== undefined;
  const lines = fitted ? Math.max(1, Math.min(4, Math.floor((height - Spacing.sm * 2) / READ_LINE))) : 3;
  // One line: start a few words before the current one, so it is never cut off.
  let s = s0;
  let lead = '';
  if (lines === 1 && word && word[0] - s0 > 24) {
    const from = source.lastIndexOf(' ', word[0] - 16);
    if (from > s0) {
      s = from + 1;
      lead = '…';
    }
  }
  const sentence = flat(source.slice(s, e));
  const paused = reader.state === 'paused';
  const starting = reader.state === 'starting';

  return (
    <View
      style={[
        styles.readAlong,
        { backgroundColor: colors.accentLight },
        fitted && { height, paddingVertical: 0 },
      ]}
    >
      <View style={styles.readText}>
        {fitted ? null : (
          <Text style={[Type.caption, styles.readLabel, { color: colors.accent }]}>
            {paused ? 'Paused' : starting ? 'Starting…' : 'Reading aloud'}
          </Text>
        )}
        <Text
          style={[Type.callout, styles.readSentence, { color: colors.text }, fitted ? { minHeight: 0 } : null]}
          numberOfLines={lines}
          accessibilityLiveRegion="polite"
        >
          {starting && fitted ? (
            <Text style={{ color: colors.muted }}>Starting…</Text>
          ) : word ? (
            <>
              {lead}
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
      {fitted ? null : (
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
      )}
    </View>
  );
}

/**
 * The viewer's Recognized text body (see the header): the selectable,
 * editable text with Read aloud beside Edit, then the chips and `footer`
 * (Copy all / Share). Editing hides the chips and the footer so the text gets
 * the room above the keyboard; reading aloud lays the player over them.
 */
export function RecognizedTextPanel({
  value,
  onChangeText,
  onSave,
  keyboardReserve,
  imageUri,
  bleed = 0,
  footer,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onSave?: (text: string) => Promise<boolean>;
  /** Height the sheet's other rows need above the keyboard while editing (header, Edit row, padding). */
  keyboardReserve: number;
  imageUri?: string | null;
  bleed?: number;
  footer?: ReactNode;
}) {
  const { colors } = useTheme();
  const [editing, setEditing] = useState(false);
  const reader = useReadAloud(value);
  const readable = reader.available && hasReadableText(value);
  const reading = reader.state !== 'idle';
  // The chips + footer zone's height, which the player takes over exactly.
  const [zoneH, setZoneH] = useState(0);

  const readButton = readable ? (
    <Pressable
      onPress={() => {
        tapLight();
        if (reading) reader.stop();
        else reader.start();
      }}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={reading ? 'Stop reading' : 'Read aloud'}
      style={({ pressed }) => [styles.textBtn, pressed && { opacity: 0.5 }]}
    >
      <Ionicons name={reading ? 'stop-circle-outline' : 'volume-high-outline'} size={18} color={colors.accent} />
      <Text style={[Type.subhead, { color: colors.accent, fontWeight: '500' }]}>{reading ? 'Stop' : 'Read aloud'}</Text>
    </Pressable>
  ) : null;

  return (
    <>
      <RecognizedText
        value={value}
        onChangeText={onChangeText}
        onSave={onSave}
        onEditingChange={setEditing}
        keyboardReserve={keyboardReserve}
        accessory={readButton}
      />
      {/* Kept mounted while editing (hidden), so detections and codes found
          on the page aren't looked for again afterwards. */}
      <View style={editing ? styles.hidden : null}>
        <View
          onLayout={e => setZoneH(Math.round(e.nativeEvent.layout.height))}
          style={reading ? styles.covered : null}
          importantForAccessibility={reading ? 'no-hide-descendants' : 'auto'}
          accessibilityElementsHidden={reading}
          pointerEvents={reading ? 'none' : 'auto'}
          collapsable={false}
        >
          <TextActions text={value} imageUri={imageUri} bleed={bleed} readAloud={false} />
          {footer}
        </View>
        {reading && zoneH > 0 ? (
          <View style={[styles.player, { height: zoneH }]}>
            <ReadAlong reader={reader} height={zoneH} />
          </View>
        ) : null}
      </View>
    </>
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
  textBtn: {
    minHeight: HIT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    paddingHorizontal: Spacing.xs,
  },
  hidden: { display: 'none' },
  covered: { opacity: 0 },
  player: { position: 'absolute', left: 0, right: 0, top: 0, justifyContent: 'center' },
});
