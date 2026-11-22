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
//   - Every other screen of the root stack is wrapped in LockCoverScreen
//     (app/_layout.tsx screenLayout) and draws the lock over itself while
//     locked, so even a screen uncovered by a stray back() stays locked.
//   - System UI shown over the top screen when the app goes to the background
//     (share sheet, print dialog, action sheet) is dismissed by native-stack
//     before it presents /lock, so it never stays above the lock.
//     A React Native Alert is the exception: it has its own window above the
//     app and can't be closed from JS. Its buttons do nothing while locked
//     (lib/alert-guard.ts), so it can't be used to act without unlocking.
//   - A system PICKER (document camera, photo picker, Files) must not be
//     closed that way: its promise would never settle and the screen that
//     opened it would stay busy, and the user would lose the capture session.
//     While one is open (lib/system-ui.ts) the lock is drawn in a
//     FullWindowOverlay instead — a view added to the window above everything,
//     presented controllers included — so nothing is presented or dismissed.
//     After unlocking the user is back in the camera or picker where they were.
//     If the picker closes while still locked (its promise settles late, or
//     "Open in Scan Kit" dismissed it), the overlay hands over to the /lock
//     route: it stays until /lock is on screen, so there is no uncovered frame,
//     and a modal presented afterwards can't draw above an overlay that is
//     still in the window.
//   - Work that finishes while locked must not navigate or present over the
//     lock: replace would swap /lock itself out for the viewer, push would
//     present the viewer above it, a share sheet or print dialog would open
//     above it. Every post-await navigation goes through lib/nav-guard.ts
//     navigateWhenUnlocked(), and every native presenter awaits
//     whenUnlocked() (lib/share.ts, lib/photos.ts, lib/system-ui.ts, alerts
//     raised while locked via lib/alert-guard.ts) — all fed by this gate.
//     ESLint (eslint-rules/lock-safe.js) rejects code that bypasses them.
//
// App-switcher privacy: when the app goes 'inactive' (app switcher, Control
// Center, a call) with App Lock on, a plain cover is drawn in the same kind of
// overlay so the snapshot iOS takes doesn't show a document. It never prompts
// for Face ID and disappears as soon as the app is active again.
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
import { FullWindowOverlay } from 'react-native-screens';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { PrimaryButton } from '@/components/primary-button';
import { authenticate, biometricKind, BiometricKind, isAuthenticating, lockMethodLabel } from '@/lib/biometrics';
import { getAppLockEnabled, subscribeAppLock } from '@/lib/storage';
import { installAlertGuard } from '@/lib/alert-guard';
import { isSystemUIOpen, subscribeSystemUI } from '@/lib/system-ui';
import { isAppLocked, isNavigationHeld, navigateWhenUnlocked, pickerHandoffStep, setNavLockState } from '@/lib/nav-guard';
import { BrandMark } from '@/components/brand-mark';
import { Spacing, Type } from '@/lib/theme';

const LOCK_ROUTE = '/lock';
/** Shows the lock screen itself while locked (app/import.tsx). */
const IMPORT_ROUTE = '/import';
/** Routes that show the lock screen themselves. */
const LOCK_SCREEN_ROUTES: readonly string[] = [LOCK_ROUTE, IMPORT_ROUTE];

// Read synchronously by the alert guard at the moment a button is pressed, so it
// is set together with the `locked` state, without waiting for a render.
// An alert raised while locked (an export that failed behind the lock
// screen) is held and shown once the app is unlocked.
installAlertGuard(isAppLocked, { hold: isNavigationHeld, later: navigateWhenUnlocked });

/** How long a closing picker gets to finish its dismissal before /lock is presented over it. */
const PICKER_HANDOFF_DELAY_MS = 350;
/** How long the overlay stays once /lock is in the stack: its fade-in has to finish. */
const OVERLAY_RELEASE_DELAY_MS = 500;

type LockState = { locked: boolean; kind: BiometricKind; tryUnlock: () => void };

const LockContext = createContext<LockState>({ locked: false, kind: 'passcode', tryUnlock: () => {} });

/** True while the app lock is engaged. Sheets use it to step aside. */
export function useAppLocked(): boolean {
  return useContext(LockContext).locked;
}

export function useLockState(): LockState {
  return useContext(LockContext);
}

/** The lock screen itself, used by the cold-start overlay and the /lock route. */
export function LockScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { kind, tryUnlock } = useLockState();
  const method = lockMethodLabel(kind);
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

/** Routes that never need the self-drawn lock (see LockCoverScreen). */
const NO_SELF_LOCK: readonly string[] = [
  'lock', // is the lock
  'import', // draws the lock itself and holds its navigation (app/import.tsx)
  '(tabs)', // under the in-tree cover LockGate draws over the navigator
];

/** True for every route LockCoverScreen should wrap (app/_layout.tsx screenLayout). */
export function selfLockingRoute(routeName: string): boolean {
  return !NO_SELF_LOCK.includes(routeName);
}

/**
 * Wraps a screen so it draws the lock screen over itself while the app is
 * locked. Used for every screen of the root stack (app/_layout.tsx
 * screenLayout) except those listed in NO_SELF_LOCK.
 *
 * Why: presented screens (viewer, annotate, tools opened from the viewer, QR)
 * are separate native controllers, so LockGate's in-tree cover can't reach
 * them; normally the /lock route sits above them. If anything ever removes
 * /lock while still locked — a router.back() that ran after slow work, which
 * closes the TOP screen — the screen below must still not be usable. This is
 * the second line of defence behind lib/nav-guard; nothing has to remember to
 * add it to a new screen.
 */
export function LockCoverScreen({ children }: { children: React.ReactNode }) {
  const locked = useAppLocked();
  return (
    <View style={styles.root}>
      {children}
      {locked && (
        <View style={StyleSheet.absoluteFill} testID="screen-lock-cover">
          <LockScreen />
        </View>
      )}
    </View>
  );
}

/** What the app-switcher snapshot shows while App Lock is on: no document, no prompt. */
function PrivacyCover() {
  const { colors } = useTheme();
  return (
    <View style={[styles.privacy, { backgroundColor: colors.bg }]} accessibilityElementsHidden>
      <BrandMark size={72} />
    </View>
  );
}

export function LockGate({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const router = useRouter();
  const pathname = usePathname();

  // null = still loading the persisted flag (cover the app so nothing flashes).
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [locked, setLockedState] = useState(false);
  const setLocked = useCallback((next: boolean) => {
    setNavLockState({ locked: next });
    setLockedState(next);
  }, []);
  const [kind, setKind] = useState<BiometricKind>('passcode');
  // Locked while a system picker was open: the lock is drawn in a
  // FullWindowOverlay over the picker instead of the /lock route.
  const [overPicker, setOverPickerState] = useState(false);
  const overPickerRef = useRef(false);
  const setOverPicker = useCallback((next: boolean) => {
    overPickerRef.current = next;
    setOverPickerState(next);
  }, []);
  // A tracked system picker is on screen (lib/system-ui).
  const [pickerOpen, setPickerOpen] = useState(isSystemUIOpen);
  // The /lock route has been pushed to take over from the picker overlay.
  const handoffRef = useRef(false);
  // App switcher / Control Center: hide the content without locking.
  const [privacy, setPrivacy] = useState(false);
  // The /lock route is on screen: it takes the touches, not the overlay below.
  const routeShown = pathname === LOCK_ROUTE;

  // Held navigations (lib/nav-guard) also wait for the lock route to close.
  useEffect(() => {
    setNavLockState({ lockRouteShown: routeShown });
  }, [routeShown]);

  useEffect(() => subscribeSystemUI(setPickerOpen), []);

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
    setOverPicker(false);
  }, [setLocked, setOverPicker]);

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
  }, [tryUnlock, unlock, setLocked]);

  // Lock when the app is backgrounded; prompt once when it comes back.
  useEffect(() => {
    if (!enabled) return;
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if (next === 'inactive') {
        // Snapshot cover only; an already-locked app is covered by the lock,
        // and our own Face ID sheet (turning App Lock off) makes the app
        // inactive without leaving it.
        if (!lockedRef.current && !isAuthenticating()) setPrivacy(true);
      } else if (next === 'active') {
        setPrivacy(false);
      }
      if (next === 'background') {
        setLocked(true);
        if (overPickerRef.current || isSystemUIOpen()) {
          // A camera or picker is open: cover it, don't close it (see header).
          setOverPicker(true);
        } else if (pathnameRef.current !== LOCK_ROUTE) {
          // Push even when another /lock is lower in the stack (covered by an
          // import): each one pops itself once it is on top and unlocked.
          router.push(LOCK_ROUTE);
        }
      } else if (next === 'active' && prev === 'background' && lockedRef.current) {
        // Safety net: if the route was presented while a system sheet (print,
        // share) was being torn down, native-stack can drop it again. Cover the
        // app before prompting. A spare /lock is harmless: each one dismisses
        // itself once unlocked. Not over a picker: the overlay covers it.
        if (
          !overPickerRef.current &&
          pathnameRef.current !== LOCK_ROUTE &&
          pathnameRef.current !== IMPORT_ROUTE
        ) {
          router.push(LOCK_ROUTE);
        }
        // Only after a real background trip: the Face ID sheet itself makes the
        // app go inactive → active, and re-prompting then would loop.
        tryUnlock();
      }
    });
    return () => sub.remove();
  }, [enabled, tryUnlock, router, setLocked, setOverPicker]);

  const isLocked = enabled === true && locked;

  // The last picker closed while the app is still locked over it: present the
  // /lock route and keep the overlay until it is on screen (no uncovered frame).
  // /import draws the lock itself, so it needs no route.
  useEffect(() => {
    if (!overPicker) {
      handoffRef.current = false;
      return;
    }
    const step = pickerHandoffStep({ overPicker, locked: isLocked, pickerOpen, pathname, lockRoutes: LOCK_SCREEN_ROUTES });
    if (step === 'none') return;
    if (step === 'clear-overlay') {
      // The route is in the stack now, but still fading in: keep the overlay
      // until it is fully on screen.
      const t = setTimeout(() => setOverPicker(false), OVERLAY_RELEASE_DELAY_MS);
      return () => clearTimeout(t);
    }
    if (handoffRef.current) return;
    handoffRef.current = true;
    // Let the picker finish its own dismissal first: presenting over a
    // controller that is still going away fails silently. Should the push fail
    // anyway, the overlay simply stays until the user unlocks.
    // Not cleared when the effect re-runs (the pathname may change meanwhile);
    // it re-checks the state itself.
    setTimeout(() => {
      if (!overPickerRef.current || !lockedRef.current || isSystemUIOpen()) {
        handoffRef.current = false;
        return;
      }
      if (!LOCK_SCREEN_ROUTES.includes(pathnameRef.current)) router.push(LOCK_ROUTE);
    }, PICKER_HANDOFF_DELAY_MS);
  }, [overPicker, isLocked, pickerOpen, pathname, router, setOverPicker]);
  const value: LockState = { locked: isLocked, kind, tryUnlock };

  return (
    <LockContext.Provider value={value}>
      <View style={styles.root}>
        {children}
        {enabled === null && <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]} />}
        {/* In-tree cover for a cold start, and a backstop under the /lock route. */}
        {isLocked && (
          <View style={StyleSheet.absoluteFill} pointerEvents={routeShown ? 'none' : 'auto'} collapsable={false}>
            <LockScreen />
          </View>
        )}
        {/* Above everything in the window, presented pickers included. The
            privacy cover stays through the trip to the background, until the
            /lock route it hides has been presented and the app is active. */}
        {enabled === true && ((isLocked && overPicker) || privacy) && (
          <FullWindowOverlay>
            {isLocked && overPicker ? <LockScreen /> : <PrivacyCover />}
          </FullWindowOverlay>
        )}
      </View>
    </LockContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  lockScreen: { flex: 1 },
  privacy: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  lockBody: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.xxxl },
  iconCircle: { width: 88, height: 88, borderRadius: 44, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.xxl },
  title: { textAlign: 'center', marginBottom: Spacing.sm },
  subtitle: { textAlign: 'center' },
  footer: { paddingHorizontal: Spacing.xxl },
});
