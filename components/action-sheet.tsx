// components/action-sheet.tsx
// A list of choices, as ActionSheetIOS shows it, on every platform.
//
// An iPhone keeps the system action sheet exactly as before: the call goes
// straight to ActionSheetIOS.showActionSheetWithOptions (an iPad too, when the
// call names an anchor view; without one it gets the sheet below). Android has no action sheet,
// and its native dialog shows at most three buttons (neutral, negative,
// positive), so a fourth choice was silently dropped and `destructive` was
// ignored. There the same call opens one of the app's own bottom sheets
// (components/bottom-sheet.tsx): title and message, one row per option with
// an optional icon, the destructive option in red, disabled options dimmed,
// and Cancel set apart at the bottom. The hardware back button, a tap on the
// dimmed backdrop and a drag down all cancel.
//
// Usage is ActionSheetIOS's, so call sites only change the import:
//
//   ActionSheet.showActionSheetWithOptions(
//     { title, options: ['Keep', 'Delete', 'Cancel'], cancelButtonIndex: 2, destructiveButtonIndex: 1 },
//     i => { … },
//   );
//
// The callback runs once, after the sheet has fully gone (like the other
// sheets' onDismissed), with the chosen index, or the cancel index (-1
// without one) when it was dismissed. Anything native the choice presents
// (a share sheet, an alert, another sheet) can open straight from it.
//
// <ActionSheetHost /> is mounted in app/_layout.tsx and inside the full-screen
// modals (see Hosts below). Its sheet is an RN Modal, so it opens above
// whatever is showing, another sheet included.
// Requests made while one is open wait their turn.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActionSheetIOS, Platform, Pressable, ScrollView, StyleSheet, Text, View, type ActionSheetIOSOptions } from 'react-native';
import { BottomSheet } from '@/components/bottom-sheet';
import { AppIcon, type AppIconName } from '@/components/app-icon';
import { DarkThemeScope, useTheme } from '@/contexts/theme-context';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

/** Everything ActionSheetIOS takes (tint colours and `anchor` are iOS-only), plus icons. */
export type ActionSheetOptions = ActionSheetIOSOptions & {
  /** Android only: an icon per option (same order as `options`); iOS's sheet has none. */
  icons?: (AppIconName | null | undefined)[];
};

export type ActionSheetRow = {
  /** Index in `options`, what the callback receives. */
  index: number;
  label: string;
  destructive: boolean;
  disabled: boolean;
  icon?: AppIconName;
};

/** The rows the sheet lists (every option but Cancel), in order. Pure: unit-tested. */
export function actionSheetRows(o: ActionSheetOptions): ActionSheetRow[] {
  const destructive = new Set(
    o.destructiveButtonIndex === undefined || o.destructiveButtonIndex === null
      ? []
      : Array.isArray(o.destructiveButtonIndex) ? o.destructiveButtonIndex : [o.destructiveButtonIndex],
  );
  const disabled = new Set(o.disabledButtonIndices ?? []);
  const rows: ActionSheetRow[] = [];
  o.options.forEach((label, index) => {
    if (index === o.cancelButtonIndex) return;
    rows.push({
      index,
      label,
      destructive: destructive.has(index),
      disabled: disabled.has(index),
      icon: o.icons?.[index] ?? undefined,
    });
  });
  return rows;
}

/** The Cancel button's label, or null when the options have none. */
export function actionSheetCancelLabel(o: ActionSheetOptions): string | null {
  const i = o.cancelButtonIndex;
  return i === undefined || i === null || i < 0 || i >= o.options.length ? null : o.options[i];
}

/** What the callback gets when the sheet is dismissed without a choice (ActionSheetIOS's iPad behaviour). */
export function actionSheetDismissIndex(o: ActionSheetOptions): number {
  const i = o.cancelButtonIndex;
  return i === undefined || i === null ? -1 : i;
}

// ── Request queue (Android, iPad) ─────────────────────────────────────────────────

type Request = { id: number; options: ActionSheetOptions; callback: (index: number) => void };

let queue: Request[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};
const current = () => queue[0] ?? null;

function finish(id: number, index: number) {
  const req = queue.find(r => r.id === id);
  if (!req) return;
  queue = queue.filter(r => r.id !== id);
  emit();
  req.callback(index);
}

function showActionSheetWithOptions(options: ActionSheetOptions, callback: (buttonIndex: number) => void): void {
  // On an iPad, UIKit shows an action sheet as a popover, and without an
  // anchor view it floats in the middle of the screen with no arrow: there
  // the app's own sheet is used, docked at the bottom like its other sheets.
  if (Platform.OS === 'ios' && !(Platform.isPad && options.anchor == null)) {
    // Exactly what the call sites passed before (icons are ours, not UIKit's).
    const { icons: _icons, ...native } = options;
    ActionSheetIOS.showActionSheetWithOptions(native, callback);
    return;
  }
  queue = [...queue, { id: nextId++, options, callback }];
  emit();
}

/** Drop-in for ActionSheetIOS's list sheet (see the top of this file). */
export const ActionSheet = { showActionSheetWithOptions };

// ── The sheet ───────────────────────────────────────────────────────────────

// ── Hosts ───────────────────────────────────────────────────────────────────
// On iOS an RN Modal presents from its own screen, and a screen covered by a
// full-screen modal (the viewer, a tool opened from it, Fill & sign) can't
// present anything: a sheet from the root host stayed hidden until the user
// went back to Home. So those screens mount a host of their own, and only the
// most recently mounted host (the top screen's) shows the sheet.

let hosts: number[] = [];
let nextHostId = 1;
const topHost = () => hosts[hosts.length - 1] ?? 0;

/**
 * Shows the app's action sheets. Mounted after the navigator (app/_layout.tsx)
 * and again inside every full-screen modal that raises one. Renders nothing
 * on an iPhone.
 */
export function ActionSheetHost() {
  const [id] = useState(() => nextHostId++);
  useEffect(() => {
    hosts = [...hosts, id];
    emit();
    return () => {
      hosts = hosts.filter(h => h !== id);
      emit();
    };
  }, [id]);
  const top = useSyncExternalStore(subscribe, topHost, topHost);
  const req = useSyncExternalStore(subscribe, current, current);
  if (!req || top !== id) return null;
  // A sheet raised over the always-dark screens (viewer, camera review) asks
  // for the dark look, as it did from UIKit.
  const sheet = <RequestSheet key={req.id} req={req} />;
  return req.options.userInterfaceStyle === 'dark' ? <DarkThemeScope>{sheet}</DarkThemeScope> : sheet;
}

function RequestSheet({ req }: { req: Request }) {
  const { colors } = useTheme();
  const [visible, setVisible] = useState(false);
  // Shown on the next frame so the sheet slides up instead of appearing.
  useEffect(() => {
    setVisible(true);
  }, []);
  const chosen = useRef<number | null>(null);
  const o = req.options;
  const rows = actionSheetRows(o);
  const cancelLabel = actionSheetCancelLabel(o);

  const close = (index: number | null) => {
    if (chosen.current !== null) return;
    chosen.current = index ?? actionSheetDismissIndex(o);
    setVisible(false);
  };

  return (
    <BottomSheet
      visible={visible}
      variant="grouped"
      onClose={() => close(null)}
      onDismissed={() => finish(req.id, chosen.current ?? actionSheetDismissIndex(o))}
    >
      {o.title || o.message ? (
        <View style={styles.header} accessible accessibilityRole="header">
          {o.title ? (
            <Text style={[Type.headline, { color: colors.text }]} numberOfLines={3}>{o.title}</Text>
          ) : null}
          {o.message ? (
            <Text style={[Type.footnote, styles.message, { color: colors.muted }]}>{o.message}</Text>
          ) : null}
        </View>
      ) : null}
      <ScrollView bounces={false} style={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={[styles.group, { backgroundColor: colors.card }]}>
          {rows.map((row, i) => {
            const fg = row.destructive ? colors.danger : colors.text;
            return (
              <Pressable
                key={row.index}
                onPress={() => close(row.index)}
                disabled={row.disabled}
                accessibilityRole="button"
                accessibilityLabel={row.label}
                accessibilityState={{ disabled: row.disabled }}
                android_ripple={{ color: colors.separator }}
                style={[styles.row, row.disabled && styles.disabled]}
              >
                {row.icon ? (
                  <View style={[styles.icon, { backgroundColor: row.destructive ? colors.dangerBg : colors.accentLight }]}>
                    <AppIcon name={row.icon} size={18} color={row.destructive ? colors.danger : colors.accent} />
                  </View>
                ) : null}
                <View
                  style={[
                    styles.rowBody,
                    i < rows.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
                  ]}
                >
                  <Text style={[Type.body, { color: fg }]} numberOfLines={2}>{row.label}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
      {cancelLabel !== null ? (
        <View style={[styles.group, styles.cancelGroup, { backgroundColor: colors.card }]}>
          <Pressable
            onPress={() => close(o.cancelButtonIndex ?? null)}
            accessibilityRole="button"
            accessibilityLabel={cancelLabel}
            android_ripple={{ color: colors.separator }}
            style={styles.cancel}
          >
            <Text style={[Type.headline, { color: colors.accent }]} numberOfLines={1}>{cancelLabel}</Text>
          </Pressable>
        </View>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  header: { marginBottom: Spacing.md, paddingHorizontal: Spacing.xs },
  message: { marginTop: Spacing.xxs, lineHeight: 18 },
  scroll: { flexGrow: 0, flexShrink: 1 },
  group: { borderRadius: Radius.md, overflow: 'hidden' },
  cancelGroup: { marginTop: Spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: HIT + 6, paddingLeft: Spacing.lg },
  disabled: { opacity: 0.4 },
  icon: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginRight: Spacing.md },
  rowBody: { flex: 1, alignSelf: 'stretch', justifyContent: 'center', paddingVertical: Spacing.md, paddingRight: Spacing.lg },
  cancel: { minHeight: HIT + 6, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.lg },
});
