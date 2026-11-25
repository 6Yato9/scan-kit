// app/_layout.tsx
import { useEffect, useRef, useState } from 'react';
import { AppState, LogBox, Platform, StatusBar as RNStatusBar, useColorScheme } from 'react-native';
import { Stack, usePathname, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ScanProvider } from '@/contexts/scan-context';
import { ThemeProvider, useTheme } from '@/contexts/theme-context';
import { ToastProvider } from '@/components/toast';
import { ErrorBoundary } from '@/components/error-boundary';
import { FilterBaker } from '@/components/filter-baker';
import { BakeIndicator } from '@/components/bake-indicator';
import { LockCoverScreen, LockGate, selfLockingRoute } from '@/components/lock-gate';
import { QuickActionsHandler } from '@/components/quick-actions-handler';
import { TextPromptHost } from '@/components/text-prompt';
import { ActionSheetHost } from '@/components/action-sheet';
import { bakePage } from '@/lib/bake';
import { reassertCalls, statusBarStyleFor } from '@/lib/status-bar-style';
import { subscribeSystemUI } from '@/lib/system-ui';
import { setNavigationBarStyle } from '@/modules/system-chrome/src';
import { garbageCollectOrphans, sweepConvertLeftovers } from '@/lib/files';
import { ensureStorageLayout } from '@/lib/storage-layout';
import { clearLegacyOcrCache } from '@/lib/ocr-cache';
import { recoverInterruptedStamps } from '@/lib/page-stamp';
import { recoverInterruptedPdfEdits } from '@/lib/pdf-edit';
import { installPdfSessionWatch } from '@/lib/pdf-session';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { noteAppOpened } from '@/lib/review-prompt';
import {
  documentFileRefsForCleanup,
  documentIdsForCleanup,
  getAppLockEnabled,
  getOnboarded,
  getOnboardedSync,
  pendingBakeMigrations,
  subscribeAppLock,
  subscribeDocumentsRemoved,
  withDocumentFileRefs,
} from '@/lib/storage';

// The app's files moved out of Documents (which the Files app shows) into
// Library/Application Support. The move runs once, synchronously, before the
// first screen renders — anything asking for a path would also run it first
// (lib/storage-layout.ts). On failure everything stays where it was and is
// used from there.
ensureStorageLayout();

// The tabs are the root of the stack even when the app is cold-started on
// another route. "Open in Scan Kit" launches straight into /import, which then
// becomes the viewer: without an anchor the stack would hold only that screen,
// and closing the viewer (router.back()) would have nowhere to go.
export const unstable_settings = {
  anchor: '(tabs)',
};

// Dev-only warning from a library race, not from app code: native-stack
// (@react-navigation/native-stack 7.14 onHeaderHeightChange) and
// react-native-screens 4.16 (Screen onTransitionProgress) build a native-driven
// Animated.event on every render, and RN 0.81's Fabric animated props hook
// (createAnimatedPropsHook) re-attaches a no-op listener to its values each
// time. The native module can emit a value update in the gap between the old
// listener's removal and the new one's arrival (cold start, modal transitions)
// and logs this warning. Nothing is lost: the next update reaches the new listener.
LogBox.ignoreLogs(['Sending `onAnimatedValueUpdate` with no listeners registered']);

// First-run gate: after mount, read the onboarding flag and redirect to the
// onboarding screen if it hasn't been completed. Kept separate from the tabs
// review effect. Doesn't block render — a brief flash of tabs is acceptable.
//
// A first launch through "Open in Scan Kit" lands on /import, which saves the
// file and becomes the viewer. Replacing either with onboarding would abandon
// the import half-way and hide the file the user asked to open, so onboarding
// waits until they leave the viewer for the app itself.
const ONBOARDING_DEFERRED = ['/import', '/viewer'];

function OnboardingGate() {
  const router = useRouter();
  const pathname = usePathname();
  const [onboarded, setOnboardedState] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    getOnboarded().then(v => { if (!cancelled) setOnboardedState(v); });
    // When the app was first opened, for the rating prompt's "not in the first days" rule.
    noteAppOpened().catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    // Only redirect once the check has resolved false and we're not already
    // on the onboarding screen (avoids a redirect loop).
    //
    // `onboarded` is read once on mount and never refreshes, so after the user
    // finishes onboarding it is still false while pathname has moved to the
    // tabs — which used to bounce them straight back into onboarding, forever.
    // getOnboardedSync() reflects setOnboarded() immediately and breaks that loop.
    if (
      onboarded === false &&
      getOnboardedSync() !== true &&
      pathname !== '/onboarding' &&
      !ONBOARDING_DEFERRED.includes(pathname)
    ) {
      // `onboarded` arrives after an await: held while the app is locked.
      return navigateWhenUnlocked(() => {
        if (getOnboardedSync() !== true) router.replace('/onboarding');
      });
    }
  }, [onboarded, pathname, router]);

  return null;
}

// Height of the floating tab bar plus its gap above the home indicator.
const TAB_BAR_CLEARANCE = 104;

/**
 * One owner for the status bar style.
 *
 * Two things go stale and leave dark text on a dark screen:
 * - React Native's <StatusBar> only talks to iOS when its merged props change
 *   (it caches the last value it sent), so a change made behind its back — a
 *   system picker, the document camera — is never corrected.
 * - UIKit itself: a style set while the app is mid appearance change (light to
 *   dark at runtime) is recorded but not drawn, and setting the same style
 *   again is then a no-op.
 * So besides the declarative component, the style is re-asserted imperatively
 * after every route, theme or foreground change, once right away and again
 * after the transition has settled. HOW it is re-asserted matters: forcing a
 * redraw means passing through another style, and that style is drawn for a
 * moment (lib/status-bar-style.ts reassertCalls). Routine re-asserts therefore
 * only ever pass through a style that looks the same; the visible "opposite"
 * step is kept for the moments a stale draw is actually likely — a theme or
 * appearance change, coming back from the background or from a system picker.
 */
function StatusBarSync() {
  const pathname = usePathname();
  const { isDark } = useTheme();
  const systemDark = useColorScheme() === 'dark';
  const style = statusBarStyleFor(pathname, isDark);
  const lastAppearance = useRef<string | null>(null);

  useEffect(() => {
    const apply = (redraw: boolean) => {
      if (Platform.OS === 'android') {
        // No UIKit draw to unstick on Android, and its 'default' means light
        // icons (not "dark on a light system"): passing through it flickered
        // the clock white on light screens. Just the target, and the
        // navigation bar's buttons to match.
        RNStatusBar.setBarStyle(style === 'light' ? 'light-content' : 'dark-content', false);
        setNavigationBarStyle(style);
        return;
      }
      reassertCalls(style, systemDark, redraw).forEach(s => RNStatusBar.setBarStyle(s, false));
    };
    // Only a change of theme / system appearance can leave UIKit's draw stale;
    // a route change just needs the target (sent through the invisible path
    // where there is one).
    const appearance = `${isDark}|${systemDark}`;
    const appearanceChanged = lastAppearance.current !== null && lastAppearance.current !== appearance;
    lastAppearance.current = appearance;

    RNStatusBar.setBarStyle(style === 'light' ? 'light-content' : 'dark-content', true);
    // Android: the navigation bar's buttons follow the same style (light over
    // the dark viewer and camera, and under the app's own Dark setting).
    if (Platform.OS === 'android') setNavigationBarStyle(style);
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, redraw: boolean) => { timers.push(setTimeout(() => apply(redraw), ms)); };
    [150, 400, 800, 1400].forEach(ms => later(ms, appearanceChanged && ms <= 400));
    // Development only: Metro's "Refreshing…" banner is a native window over
    // the status bar, and when it hides iOS can leave the bar in the wrong
    // style with no event to react to. Re-assert it (never visibly) while a
    // dev build runs.
    const devTimer = __DEV__ ? setInterval(() => apply(false), 2000) : undefined;
    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active') return;
      apply(true);
      later(500, false);
    });
    // A system picker / the document camera can change the drawn style behind
    // UIKit's back; redraw once it has finished closing.
    const unsubscribeUI = subscribeSystemUI(isOpen => {
      if (isOpen) return;
      later(450, true);
      later(900, false);
    });
    return () => {
      timers.forEach(clearTimeout);
      if (devTimer) clearInterval(devTimer);
      sub.remove();
      unsubscribeUI();
    };
  }, [style, pathname, isDark, systemDark]);

  return <StatusBar style={style} />;
}

// Tools opened on a document from the viewer (a `docId` param) must be modals:
// the viewer is a fullScreenModal, and a card pushed under it never shows.
const toolOptions = ({ route }: { route: { params?: object } }) => ({
  headerShown: false,
  presentation: (route.params as { docId?: string } | undefined)?.docId ? ('fullScreenModal' as const) : ('card' as const),
});

// App Lock, second line of defence: every presented screen draws the lock over
// itself while locked (components/lock-gate.tsx LockCoverScreen), so a screen
// can't be usable without unlocking even if the /lock route above it is gone.
const lockCoverLayout = ({ route, children }: { route: { name: string }; children: React.ReactElement }) =>
  selfLockingRoute(route.name) ? <LockCoverScreen>{children}</LockCoverScreen> : children;

function ThemedStack() {
  const { colors } = useTheme();
  return (
    <>
    <StatusBarSync />
    <OnboardingGate />
    <FilterBaker />
    <LockGate>
    <Stack
      screenLayout={lockCoverLayout}
      screenOptions={{
        // One header system: every screen draws components/screen-header.tsx
        // (chevron back, centred title) itself, so the native bar is off app-wide.
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      {/* App lock (components/lock-gate.tsx): covers full-screen modals too. */}
      <Stack.Screen name="lock" options={{ presentation: 'fullScreenModal', headerShown: false, gestureEnabled: false, animation: 'fade' }} />
      {/* "Open in Scan Kit" (app/import.tsx). Full screen: it may land on top of
          /lock and then shows the lock itself, which must cover the whole screen
          (a card pushed over a modal becomes a page sheet with the screen below
          peeking out at the top). */}
      <Stack.Screen name="import" options={{ presentation: 'fullScreenModal', headerShown: false, gestureEnabled: false, animation: 'fade' }} />
      <Stack.Screen
        name="onboarding"
        options={{ headerShown: false, presentation: 'fullScreenModal' }}
      />
      <Stack.Screen
        name="viewer"
        options={{ presentation: 'fullScreenModal', headerShown: false }}
      />
      <Stack.Screen
        name="annotate"
        options={{ presentation: 'fullScreenModal', headerShown: false }}
      />
      {/* Fill & sign an imported PDF in place (app/pdf-fill.tsx). */}
      <Stack.Screen
        name="pdf-fill"
        options={{ presentation: 'fullScreenModal', headerShown: false, gestureEnabled: false }}
      />
      {/* Scan Kit's document camera and its review (app/camera.tsx, lib/capture-session.ts). */}
      <Stack.Screen
        name="camera"
        options={{ presentation: 'fullScreenModal', headerShown: false, gestureEnabled: false, contentStyle: { backgroundColor: colors.chrome } }}
      />
      <Stack.Screen name="settings/scan-settings" options={{ title: 'Scan settings', presentation: 'card' }} />
      <Stack.Screen name="settings/document-settings" options={{ title: 'Document settings', presentation: 'card' }} />
      <Stack.Screen name="settings/printer" options={{ title: 'Printing', presentation: 'card' }} />
      <Stack.Screen name="settings/help" options={{ title: 'Help', presentation: 'card' }} />
      <Stack.Screen name="settings/about" options={{ title: 'About', presentation: 'card' }} />
      <Stack.Screen name="settings/recovered-files" options={{ title: 'Recovered files', presentation: 'card' }} />
      <Stack.Screen name="tools/qr" options={{ headerShown: false, presentation: 'fullScreenModal' }} />
      <Stack.Screen name="tools/id-card" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/compress" options={toolOptions} />
      <Stack.Screen name="tools/extract" options={toolOptions} />
      <Stack.Screen name="tools/merge" options={toolOptions} />
      <Stack.Screen name="tools/create-pdf" options={toolOptions} />
      <Stack.Screen name="tools/split" options={toolOptions} />
      <Stack.Screen name="tools/unrestrict" options={toolOptions} />
      <Stack.Screen name="tools/protect" options={toolOptions} />
      <Stack.Screen name="tools/flatten" options={toolOptions} />
      <Stack.Screen name="tools/watermark" options={toolOptions} />
      <Stack.Screen name="tools/timestamp" options={toolOptions} />
      <Stack.Screen name="tools/sign" options={toolOptions} />
      {/* toolOptions: the viewer's Tools sheet opens Long image on the document. */}
      <Stack.Screen name="tools/long-image" options={toolOptions} />
      <Stack.Screen name="tools/book" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/whiteboard" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/erase-marks" options={toolOptions} />
      <Stack.Screen name="tools/redact" options={toolOptions} />
      <Stack.Screen name="tools/find-text" options={toolOptions} />
      <Stack.Screen name="tools/extract-text" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/business-card" options={{ headerShown: false, presentation: 'card' }} />
    </Stack>
    {/* Android's text prompts (components/text-prompt.tsx; iOS uses Alert.prompt).
        Inside LockGate: it steps aside while the app is locked. */}
    <TextPromptHost />
    </LockGate>
    {/* Home-screen quick actions (lib/quick-actions.ts). After LockGate, so App
        Lock reads its flag first; it waits for the unlock itself. */}
    <QuickActionsHandler />
    {/* The app's own action sheets (Android, iPad; components/action-sheet.tsx). Full-screen modals mount their own. */}
    <ActionSheetHost />
    {/* After the navigator so it draws above the tab screens; clears the
        floating tab bar. Full-screen surfaces (viewer) render their own. */}
    <BakeIndicator placement="bottom" offset={TAB_BAR_CLEARANCE} />
    </>
  );
}

export default function RootLayout() {
  useEffect(() => {
    // A Sign / Watermark / Timestamp the app died in the middle of is rolled
    // back first, from its journal (lib/page-stamp.ts), before anything opens
    // the document or the sweep below looks at its folder.
    const stampsRecovered = recoverInterruptedStamps().catch(() => 0);
    // Likewise a PDF page edit (lib/pdf-edit.ts): its search text is re-read.
    recoverInterruptedPdfEdits().catch(() => 0);
    // Protected PDFs unlocked for the session lock again when it ends
    // (background with App Lock on, a long absence without), and copies an
    // earlier process left behind are removed (lib/pdf-session.ts).
    const stopPdfSessions = installPdfSessionWatch({ getAppLockEnabled, subscribeAppLock, subscribeDocumentsRemoved });
    // Fire-and-forget startup sweep of orphaned doc dirs and interrupted-
    // operation temp files. Delayed slightly so it never competes with render.
    // documentIdsForCleanup returns null when the list can't be trusted (doc
    // records exist that didn't parse), and then nothing is deleted.
    const t = setTimeout(() => {
      // Recognised text used to be cached outside the documents' folders,
      // where it outlived deleted documents (lib/ocr-cache.ts).
      clearLegacyOcrCache();
      stampsRecovered
        .then(() => documentIdsForCleanup())
        .then(ids => (ids ? garbageCollectOrphans(ids) : 0))
        // Then files a record no longer references, left by an interrupted
        // "Convert to pages" or its Undo (lib/files.ts sweepConvertLeftovers).
        .then(() => documentFileRefsForCleanup())
        .then(records => (records ? sweepConvertLeftovers(records, withDocumentFileRefs) : 0))
        .catch(() => {});
    }, 2000);

    // v3 migration: bake any filter/adjustment a pre-v3 app version only ever
    // recorded as metadata (see pendingBakeMigrations). All jobs are requested
    // together: the queue still runs them one at a time, but every page is
    // tracked from the start, so an edit made meanwhile (deleting a page)
    // re-targets them instead of a sequential loop baking stale indices. One
    // page's failure doesn't stop the rest.
    (async () => {
      const jobs = await pendingBakeMigrations();
      await Promise.all(jobs.map(job =>
        bakePage(job.docId, job.pageIndex, job.filter, job.adjustment).catch(() => false),
      ));
    })().catch(() => {});

    return () => {
      clearTimeout(t);
      stopPdfSessions();
    };
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ErrorBoundary>
        <ThemeProvider>
          <ToastProvider>
            <ScanProvider>
              <ThemedStack />
            </ScanProvider>
          </ToastProvider>
        </ThemeProvider>
      </ErrorBoundary>
    </GestureHandlerRootView>
  );
}
