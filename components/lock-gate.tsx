// components/lock-gate.tsx
// Whole-app biometric lock. The navigator underneath always stays mounted;
// unmounting it (as an earlier version did) threw the user back to Home and
// lost viewer / crop / annotate state and the viewer's baker.
//
// How the lock is drawn:
//   - Cold start: an opaque in-tree overlay above the tabs (nothing native is
//     presented yet).
//   - Returning from the background: the `/lock` route, pushed as a
//     full-screen modal. Native-stack presents it on top of whatever is
//     already presented (viewer, annotate, tools), which an in-tree overlay or
//     an RN <Modal> owned by the root cannot do. Bottom sheets hide themselves
//     while locked (see useAppLocked in BottomSheet).
//   - The /lock route dismisses ITSELF whenever it is focused while unlocked
//     (app/lock.tsx). The gate never pops it: something may have been pushed
//     above it meanwhile ("Open in Scan Kit" lands on /import), and popping
//     from the gate would then close the wrong screen or none at all, leaving
//     a dead lock screen behind once the screen above it closes.
//   - Screens that can appear above /lock while locked (app/import.tsx)
//     render <LockScreen /> themselves and hold any navigation until unlock.
//
// Behaviour:
//   - Locks on a cold start and whenever the app goes to the BACKGROUND. It
//     does not lock on 'inactive' (Face ID prompt, Control Center, app
//     switcher peek), which used to cause a double prompt.
//   - Reacts to the setting immediately (subscribeAppLock), no restart needed.
//
// SAFETY: the user's documents are local-only with no backup, so this gate is
// biased toward never trapping them:
//   - Nothing to authenticate with (no passcode, nothing enrolled, no
//     hardware) or auth throws → FAIL OPEN (unlock).
//   - Auth returns failure (cancel/fail) → stay locked but ALWAYS show a
//     manual Unlock button. Never auto-loop the prompt.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus, StyleSheet, Text, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { authenticate, biometricKind, BiometricKind } from '@/lib/biometrics';
import { getAppLockEnabled, subscribeAppLock } from '@/lib/storage';
import { Spacing, Type } from '@/lib/theme';

const LOCK_ROUTE = '/lock';
/** Shows the lock screen itself while locked (app/import.tsx). */
const IMPORT_ROUTE = '/import';

type LockState = { locked: boolean; kind: BiometricKind; tryUnlock: () => void };

const LockContext = createContext<LockState>({ locked: false, kind: 'passcode', tryUnlock: () => {} });

/** True while the app lock is engaged. Sheets use it to step aside. */
export function useAppLocked(): boolean {
  return useContext(LockContext).locked;
}

export function useLockState(): LockState {
  return useContext(LockContext);
}

const METHOD_LABEL: Record<BiometricKind, string> = {
  faceId: 'Face ID',
  touchId: 'Touch ID',
  passcode: 'your passcode',
};

/** The lock screen itself, used by the cold-start overlay and the /lock route. */
export function LockScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { kind, tryUnlock } = useLockState();
  const method = METHOD_LABEL[kind];
  return (
    <View
      style={[styles.lockScreen, { backgroundColor: colors.bg, paddingTop: insets.top, paddingBottom: insets.bottom + Spacing.xxl }]}
      accessibilityViewIsModal
    >
      <View style={styles.lockBody}>
        <View style={[styles.iconCircle, { backgroundColor: colors.accentLight }]}>
          <Ionicons name="lock-closed" size={40} color={colors.accent} />
        </View>
        <Text style={[Type.title, styles.title, { color: colors.text }]} accessibilityRole="header">
          Scan Kit is locked
        </Text>
        <Text style={[Type.callout, styles.subtitle, { color: colors.muted }]}>
          Use {method} to see your documents.
        </Text>
      </View>
      <View style={styles.footer}>
        <PrimaryButton
          title={kind === 'passcode' ? 'Unlock' : `Unlock with ${method}`}
          icon={kind === 'touchId' ? 'finger-print' : 'lock-open-outline'}
          onPress={tryUnlock}
        />
      </View>
    </View>
  );
}

export function LockGate({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const router = useRouter();
  const pathname = usePathname();

  // null = still loading the persisted flag (cover the app so nothing flashes).
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [locked, setLocked] = useState(false);
  const [kind, setKind] = useState<BiometricKind>('passcode');
  // The /lock route is on screen: it takes the touches, not the overlay below.
  const routeShown = pathname === LOCK_ROUTE;

  // Prevents concurrent authenticate() prompts.
  const authingRef = useRef(false);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  // The /lock route sees `locked` turn false and dismisses itself.
  const unlock = useCallback(() => {
    setLocked(false);
  }, []);

  const tryUnlock = useCallback(async () => {
    if (authingRef.current) return;
    authingRef.current = true;
    try {
      const result = await authenticate('Unlock Scan Kit');
      if (result === 'success' || result === 'unavailable') {
        // 'unavailable' → FAIL OPEN: a missing/broken sensor or a removed
        // passcode must never brick the app.
        unlock();
      }
      // 'failed' → stay locked; the Unlock button lets the user retry.
    } finally {
      authingRef.current = false;
    }
  }, [unlock]);

  // Load the flag once, then follow every change made in Settings.
  useEffect(() => {
    let cancelled = false;
    biometricKind().then(k => { if (!cancelled) setKind(k); });
    getAppLockEnabled().then(on => {
      if (cancelled) return;
      setEnabled(on);
      if (on) {
        setLocked(true);
        tryUnlock();
      }
    });
    const unsubscribe = subscribeAppLock(on => {
      setEnabled(on);
      biometricKind().then(setKind);
      // Turning the lock on doesn't lock the current session (the user just
      // authenticated to enable it); turning it off unlocks immediately.
      if (!on) unlock();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [tryUnlock, unlock]);

  // Lock when the app is backgrounded; prompt once when it comes back.
  useEffect(() => {
    if (!enabled) return;
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if (next === 'background') {
        setLocked(true);
        // Push even when another /lock is lower in the stack (covered by an
        // import): each one pops itself once it is on top and unlocked.
        if (pathnameRef.current !== LOCK_ROUTE) router.push(LOCK_ROUTE);
      } else if (next === 'active' && prev === 'background' && lockedRef.current) {
        // Safety net: if the route was presented while a system sheet (print,
        // share) was being torn down, native-stack can drop it again. Cover the
        // app before prompting. A spare /lock is harmless: each one dismisses
        // itself once unlocked.
        if (pathnameRef.current !== LOCK_ROUTE && pathnameRef.current !== IMPORT_ROUTE) router.push(LOCK_ROUTE);
        // Only after a real background trip: the Face ID sheet itself makes the
        // app go inactive → active, and re-prompting then would loop.
        tryUnlock();
      }
    });
    return () => sub.remove();
  }, [enabled, tryUnlock, router]);

  const isLocked = enabled === true && locked;
  const value: LockState = { locked: isLocked, kind, tryUnlock };

  return (
    <LockContext.Provider value={value}>
      <View style={styles.root}>
        {children}
        {enabled === null && <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]} />}
        {/* In-tree cover for a cold start, and a backstop under the /lock route. */}
        {isLocked && (
          <View style={StyleSheet.absoluteFill} pointerEvents={routeShown ? 'none' : 'auto'}>
            <LockScreen />
          </View>
        )}
      </View>
    </LockContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  lockScreen: { flex: 1 },
  lockBody: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.xxxl },
  iconCircle: { width: 88, height: 88, borderRadius: 44, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.xxl },
  title: { textAlign: 'center', marginBottom: Spacing.sm },
  subtitle: { textAlign: 'center' },
  footer: { paddingHorizontal: Spacing.xxl },
});
