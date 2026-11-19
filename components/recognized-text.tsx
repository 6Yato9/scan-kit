// components/recognized-text.tsx
// The recognized text of a page, as the user reads, selects and corrects it
// (viewer's Recognized text sheet, Extract text tool).
//
// Why a TextInput: on iOS an RN <Text selectable> only offers "Copy" for the
// WHOLE text — you can't drag the handles to pick a range. A multiline
// UITextView can: read-only (editable={false}) it still supports touch and
// hold, selection handles and the system menu (Copy, Look Up, Translate,
// Share), without bringing up the keyboard. "Edit" makes it editable so OCR
// mistakes can be fixed before copying; with `onSave` the correction is kept
// (lib/recognized-text.ts).
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import {
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/theme-context';
import { AppIcon } from '@/components/app-icon';
import { notifyError, tapLight } from '@/lib/haptics';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

export type RecognizedTextHandle = {
  /** Ends editing (saving a change when `onSave` is set). */
  finishEditing: () => void;
};

type Props = {
  value: string;
  onChangeText: (text: string) => void;
  /**
   * Keeps a correction (resolves false if it couldn't be saved). Omit when the
   * text only lives on screen, as in the Extract text tool.
   */
  onSave?: (text: string) => Promise<boolean>;
  /** Called when editing starts or ends (e.g. to hide a footer under the keyboard). */
  onEditingChange?: (editing: boolean) => void;
  /** Fill the parent (a full screen) instead of growing with the text up to `maxHeight` (a sheet). */
  fill?: boolean;
  maxHeight?: number;
  /**
   * Height the rest of the layout needs while the keyboard is up, so the text
   * box shrinks and nothing ends up under the keyboard (sheet only).
   */
  keyboardReserve?: number;
  /** Background of the text box. Defaults to the page colour. */
  surface?: string;
  /**
   * Selectable but never editable, with no Edit / status row under it (a
   * scanned code's content, for example).
   */
  readOnly?: boolean;
  /** A control shown beside Edit while not editing (Read aloud). */
  accessory?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export const RecognizedText = forwardRef<RecognizedTextHandle, Props>(function RecognizedText(
  { value, onChangeText, onSave, onEditingChange, fill = false, maxHeight = 320, keyboardReserve = 0, surface, readOnly = false, accessory, style },
  ref,
) {
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowH } = useWindowDimensions();
  const inputRef = useRef<TextInput>(null);
  const [editing, setEditing] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [keyboardH, setKeyboardH] = useState(0);

  // What the text was when editing began, to save only a real change.
  const startText = useRef(value);
  // Latest values for the unmount save (the sheet can be swiped away mid-edit).
  const latest = useRef({ value, editing, onSave });
  latest.current = { value, editing, onSave };
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const { value: v, editing: e, onSave: save } = latest.current;
      // Closed while editing: keep the correction rather than drop it silently.
      if (e && save && v !== startText.current) save(v).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (fill || !keyboardReserve) return;
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s = Keyboard.addListener(showEvt, e => setKeyboardH(e.endCoordinates.height));
    const h = Keyboard.addListener(hideEvt, () => setKeyboardH(0));
    return () => { s.remove(); h.remove(); };
  }, [fill, keyboardReserve]);

  const setEditingState = useCallback((next: boolean) => {
    setEditing(next);
    onEditingChange?.(next);
  }, [onEditingChange]);

  const startEditing = () => {
    tapLight();
    startText.current = value;
    setSaveState('idle');
    setEditingState(true);
    // After the re-render that makes the field editable.
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const finishEditing = useCallback(() => {
    if (!latest.current.editing) return;
    inputRef.current?.blur();
    setEditingState(false);
    const { value: v, onSave: save } = latest.current;
    if (!save || v === startText.current) return;
    startText.current = v;
    setSaveState('saving');
    save(v).then(
      ok => {
        if (!mounted.current) return;
        setSaveState(ok ? 'saved' : 'failed');
        if (!ok) notifyError();
      },
      () => {
        if (mounted.current) setSaveState('failed');
      },
    );
  }, [setEditingState]);

  useImperativeHandle(ref, () => ({ finishEditing }), [finishEditing]);

  // In a sheet the box grows with the text, capped so the sheet's other rows
  // stay on screen above the keyboard.
  const cap = keyboardH > 0 && keyboardReserve
    ? Math.max(120, Math.min(maxHeight, windowH - keyboardH - insets.top - keyboardReserve))
    : maxHeight;

  const status = (() => {
    if (editing) return onSave ? 'Changes are saved with this page.' : 'Fix any mistakes before you copy.';
    if (saveState === 'saving') return 'Saving…';
    if (saveState === 'saved') return 'Changes saved.';
    if (saveState === 'failed') return 'Couldn’t save your changes. Try again.';
    return 'Touch and hold to select.';
  })();

  return (
    <View style={[fill && styles.fill, style]}>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={t => {
          if (saveState !== 'idle') setSaveState('idle');
          onChangeText(t);
        }}
        editable={editing}
        multiline
        scrollEnabled
        textAlignVertical="top"
        autoCorrect={false}
        autoCapitalize="sentences"
        spellCheck
        keyboardAppearance={isDark ? 'dark' : 'light'}
        selectionColor={colors.accent}
        accessibilityLabel="Recognized text"
        accessibilityHint={editing ? undefined : 'Touch and hold to select text'}
        style={[
          Type.body,
          styles.input,
          {
            color: colors.text,
            backgroundColor: surface ?? colors.bg,
            borderColor: editing ? colors.accent : surface ?? colors.bg,
          },
          fill ? styles.fill : { maxHeight: cap },
          readOnly && styles.readOnly,
        ]}
      />
      {readOnly ? null : (
        <View style={styles.meta}>
          <View style={styles.statusRow}>
            {saveState === 'saved' && !editing ? (
              <Ionicons name="checkmark" size={15} color={colors.muted} />
            ) : null}
            <Text
              style={[Type.footnote, styles.status, { color: saveState === 'failed' && !editing ? colors.danger : colors.muted }]}
              numberOfLines={2}
            >
              {status}
            </Text>
          </View>
          {editing ? null : accessory}
          <Pressable
            onPress={editing ? finishEditing : startEditing}
            disabled={saveState === 'saving'}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel={editing ? 'Done editing' : 'Edit text'}
            style={({ pressed }) => [styles.toggle, pressed && { opacity: 0.5 }]}
          >
            {editing ? null : <AppIcon name="rename" size={16} color={colors.accent} />}
            <Text style={[Type.subhead, { color: colors.accent, fontWeight: editing ? '600' : '500' }]}>
              {editing ? 'Done' : 'Edit'}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  fill: { flex: 1 },
  readOnly: { minHeight: 0 },
  input: {
    lineHeight: 24,
    borderRadius: Radius.md,
    borderWidth: 1,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.md,
    minHeight: 96,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: HIT,
    gap: Spacing.md,
  },
  statusRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, paddingLeft: Spacing.xs },
  status: { flexShrink: 1 },
  toggle: {
    minHeight: HIT,
    minWidth: HIT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: Spacing.xs,
    paddingLeft: Spacing.sm,
    paddingRight: Spacing.xs,
  },
});
