// components/text-prompt.tsx
//
// A text prompt (a PDF's password) that works on Android. React Native's
// Alert.prompt is iOS-only: on Android it does nothing at all, so a password
// could never be typed. iOS keeps Alert.prompt exactly as before (native,
// identical behaviour); Android gets this dialog, drawn by <TextPromptHost />
// (mounted once at the root, inside LockGate):
//
//  - Material-style centred card on the app's theme (light and dark), the
//    keyboard opening with it and the card kept above the keyboard;
//  - secure entry with a show / hide button for passwords; Return submits;
//  - the hardware back button and a tap outside cancel, as on any dialog;
//  - accessibility: modal for screen readers, the title a header, labelled
//    field and buttons, 48 dp targets;
//  - App Lock: like every sheet, it steps aside while the app is locked (the
//    typed text is cleared) and comes back after unlocking; a button pressed
//    while locked does nothing (lib/alert-guard.ts does the same for Alert).
//
// Call showTextPrompt(); the one call covers both platforms.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { useAppLocked } from '@/components/lock-gate';
import { isAppLocked } from '@/lib/nav-guard';
import { Radius, Spacing, Type } from '@/lib/theme';

export type TextPromptOptions = {
  title: string;
  message?: string;
  /** Password entry: hidden text (with a show button on Android). */
  secure?: boolean;
  /** The confirming button, e.g. 'Unlock'. Default 'OK'. */
  confirmLabel?: string;
  /** Default 'Cancel'. */
  cancelLabel?: string;
  /** Android: hint inside the empty field; also its accessibility label. */
  placeholder?: string;
};

type Request = TextPromptOptions & { id: number; resolve: (value: string | null) => void };

// ── The queue (one prompt at a time) ────────────────────────────────────────

let queue: Request[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) {
    try { l(); } catch {}
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const current = (): Request | null => queue[0] ?? null;

function settle(id: number, value: string | null): void {
  const req = queue.find(r => r.id === id);
  if (!req) return;
  queue = queue.filter(r => r.id !== id);
  emit();
  req.resolve(value);
}

/**
 * Android: asks for a line of text in the in-app dialog. Resolves with what
 * was typed ('' allowed), or null when cancelled. Exported for tests and for
 * callers that only run on Android; others use showTextPrompt.
 */
export function promptText(options: TextPromptOptions): Promise<string | null> {
  return new Promise(resolve => {
    queue = [...queue, { ...options, id: nextId++, resolve }];
    emit();
  });
}

/** Test helper: what the host would show now. */
export function currentTextPromptForTests(): TextPromptOptions | null {
  const r = current();
  return r ? { title: r.title, message: r.message, secure: r.secure, confirmLabel: r.confirmLabel, cancelLabel: r.cancelLabel, placeholder: r.placeholder } : null;
}

/** Test helper: answer the prompt on screen (null = Cancel). */
export function answerTextPromptForTests(value: string | null): void {
  const r = current();
  if (r) settle(r.id, value);
}

/**
 * Asks for text: iOS shows Alert.prompt (Cancel, then the preferred confirm
 * button; 'secure-text' when `secure`), Android the in-app dialog.
 * `onSubmit` gets the text ('' when empty); `onCancel` runs on Cancel.
 */
export function showTextPrompt(
  options: TextPromptOptions,
  onSubmit: (value: string) => void,
  onCancel?: () => void,
): void {
  const confirm = options.confirmLabel ?? 'OK';
  const cancel = options.cancelLabel ?? 'Cancel';
  if (Platform.OS === 'ios') {
    Alert.prompt(
      options.title,
      options.message,
      [
        onCancel ? { text: cancel, style: 'cancel', onPress: onCancel } : { text: cancel, style: 'cancel' },
        { text: confirm, isPreferred: true, onPress: (value?: string) => onSubmit(value ?? '') },
      ],
      options.secure ? 'secure-text' : 'plain-text',
    );
    return;
  }
  promptText({ ...options, confirmLabel: confirm, cancelLabel: cancel }).then(value => {
    if (value === null) onCancel?.();
    else onSubmit(value);
  });
}

// ── The dialog ──────────────────────────────────────────────────────────────

/** Renders the prompt on screen (Android). Mount once, inside LockGate. */
export function TextPromptHost() {
  const req = useSyncExternalStore(subscribe, current, current);
  const locked = useAppLocked();
  if (Platform.OS === 'ios' || !req) return null;
  return <PromptDialog key={req.id} request={req} hidden={locked} />;
}

function PromptDialog({ request, hidden }: { request: Request; hidden: boolean }) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const [value, setValueState] = useState('');
  // Return can fire before the last keystroke re-renders: read the ref.
  const valueRef = useRef('');
  const setValue = (v: string) => {
    valueRef.current = v;
    setValueState(v);
  };
  const [reveal, setReveal] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const confirmLabel = request.confirmLabel ?? 'OK';
  const cancelLabel = request.cancelLabel ?? 'Cancel';

  // Locked: what was typed (a password) doesn't wait behind the lock screen.
  useEffect(() => {
    if (hidden) {
      setValue('');
      setReveal(false);
    }
  }, [hidden]);

  const done = (text: string | null) => {
    if (isAppLocked()) return;
    settle(request.id, text);
  };

  const cardWidth = Math.min(360, width - 2 * Spacing.xxl);

  return (
    <Modal
      transparent
      visible={!hidden}
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={() => done(null)}
      onShow={() => setTimeout(() => inputRef.current?.focus(), 50)}
    >
      <KeyboardAvoidingView style={styles.fill} behavior="padding">
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.backdrop }]}
          onPress={() => done(null)}
          accessibilityRole="button"
          accessibilityLabel={cancelLabel}
          importantForAccessibility="no"
        />
        <View style={styles.center} pointerEvents="box-none">
          <View
            accessibilityViewIsModal
            style={[
              styles.card,
              { width: cardWidth, backgroundColor: colors.card, borderColor: colors.sheetBorder, shadowColor: colors.shadow },
            ]}
          >
            <Text
              style={[Type.title, styles.title, { color: colors.text }]}
              accessibilityRole="header"
              maxFontSizeMultiplier={1.4}
            >
              {request.title}
            </Text>
            {request.message ? (
              <Text style={[Type.callout, styles.message, { color: colors.subtext }]} maxFontSizeMultiplier={1.4}>
                {request.message}
              </Text>
            ) : null}
            <View style={[styles.field, { backgroundColor: colors.input, borderColor: colors.accent }]}>
              <TextInput
                ref={inputRef}
                style={[Type.body, styles.input, { color: colors.text }]}
                value={value}
                onChangeText={setValue}
                secureTextEntry={!!request.secure && !reveal}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete={request.secure ? 'off' : undefined}
                importantForAutofill={request.secure ? 'no' : 'auto'}
                textContentType={request.secure ? 'password' : 'none'}
                returnKeyType="done"
                enablesReturnKeyAutomatically={false}
                onSubmitEditing={() => done(valueRef.current)}
                placeholder={request.placeholder ?? (request.secure ? 'Password' : undefined)}
                placeholderTextColor={colors.muted}
                selectionColor={colors.accent}
                cursorColor={colors.accent}
                accessibilityLabel={request.placeholder ?? (request.secure ? 'Password' : request.title)}
                maxFontSizeMultiplier={1.4}
              />
              {request.secure ? (
                <Pressable
                  onPress={() => setReveal(r => !r)}
                  hitSlop={8}
                  style={styles.eye}
                  accessibilityRole="button"
                  accessibilityLabel={reveal ? 'Hide password' : 'Show password'}
                >
                  <Ionicons name={reveal ? 'eye-off-outline' : 'eye-outline'} size={22} color={colors.muted} />
                </Pressable>
              ) : null}
            </View>
            <View style={styles.buttons}>
              <DialogButton label={cancelLabel} color={colors.accent} onPress={() => done(null)} />
              <DialogButton label={confirmLabel} color={colors.accent} strong onPress={() => done(valueRef.current)} />
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function DialogButton({ label, color, strong, onPress }: { label: string; color: string; strong?: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      android_ripple={{ color: colors.accentLight, borderless: false }}
      style={({ pressed }) => [styles.button, pressed && Platform.OS !== 'android' ? { backgroundColor: colors.accentLight } : null]}
    >
      <Text style={[Type.subhead, { color, fontWeight: strong ? '700' : '600' }]} maxFontSizeMultiplier={1.3}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xxl },
  card: {
    borderRadius: 28,
    paddingTop: Spacing.xxl,
    paddingHorizontal: Spacing.xxl,
    paddingBottom: Spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    elevation: 12,
    shadowOpacity: 0.25,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
  },
  title: { fontSize: 20, marginBottom: Spacing.md },
  message: { marginBottom: Spacing.lg, lineHeight: 21 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.md,
    borderWidth: 2,
    paddingLeft: Spacing.lg,
    paddingRight: Spacing.xs,
    minHeight: 52,
  },
  input: { flex: 1, paddingVertical: Spacing.md },
  eye: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.xs, marginTop: Spacing.lg },
  button: {
    minHeight: 48,
    minWidth: 64,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
});
