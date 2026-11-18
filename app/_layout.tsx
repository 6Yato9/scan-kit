// app/_layout.tsx
import { useEffect, useState } from 'react';
import { AppState, StatusBar as RNStatusBar } from 'react-native';
import { Stack, usePathname, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ScanProvider } from '@/contexts/scan-context';
import { ThemeProvider, useTheme } from '@/contexts/theme-context';
import { ToastProvider } from '@/components/toast';
import { ErrorBoundary } from '@/components/error-boundary';
import { FilterBaker } from '@/components/filter-baker';
import { BakeIndicator } from '@/components/bake-indicator';
import { LockGate } from '@/components/lock-gate';
import { bakePage } from '@/lib/bake';
import { statusBarStyleFor } from '@/lib/status-bar-style';
import { garbageCollectOrphans } from '@/lib/files';
import { documentIdsForCleanup, getOnboarded, getOnboardedSync, pendingBakeMigrations } from '@/lib/storage';

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
      router.replace('/onboarding');
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
 *   system sheet, the document camera — is never corrected.
 * - UIKit itself: a style set while the app is mid appearance change (light to
 *   dark at runtime) is recorded but not drawn, and setting the same style
 *   again is then a no-op.
 * So besides the declarative component, the style is re-asserted imperatively
 * — briefly flipping to the opposite style first so UIKit can't treat it as
 * unchanged — after every route, theme or foreground change, once right away
 * and again after the transition has settled. Both calls land in the same
 * frame, so nothing flickers.
 */
function StatusBarSync() {
  const pathname = usePathname();
  const { isDark } = useTheme();
  const style = statusBarStyleFor(pathname, isDark);

  useEffect(() => {
    const target = style === 'light' ? 'light-content' : 'dark-content';
    const opposite = style === 'light' ? 'dark-content' : 'light-content';
    const force = () => {
      RNStatusBar.setBarStyle(opposite, false);
      RNStatusBar.setBarStyle(target, false);
    };
    RNStatusBar.setBarStyle(target, true);
    const timers = [150, 400, 800, 1400].map(ms => setTimeout(force, ms));
    // Development only: Metro's "Refreshing…" banner is a native window over
    // the status bar, and when it hides iOS can leave the bar in the wrong
    // style with no event to react to. Re-assert it while a dev build runs.
    const devTimer = __DEV__ ? setInterval(force, 2000) : undefined;
    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active') return;
      force();
      timers.push(setTimeout(force, 500));
    });
    return () => {
      timers.forEach(clearTimeout);
      if (devTimer) clearInterval(devTimer);
      sub.remove();
    };
  }, [style, pathname]);

  return <StatusBar style={style} />;
}

// Tools opened on a document from the viewer (a `docId` param) must be modals:
// the viewer is a fullScreenModal, and a card pushed under it never shows.
const toolOptions = ({ route }: { route: { params?: object } }) => ({
  headerShown: false,
  presentation: (route.params as { docId?: string } | undefined)?.docId ? ('fullScreenModal' as const) : ('card' as const),
});

function ThemedStack() {
  const { colors } = useTheme();
  return (
    <>
    <StatusBarSync />
    <OnboardingGate />
    <FilterBaker />
    <LockGate>
    <Stack
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
      <Stack.Screen name="settings/scan-settings" options={{ title: 'Scan settings', presentation: 'card' }} />
      <Stack.Screen name="settings/document-settings" options={{ title: 'Document settings', presentation: 'card' }} />
      <Stack.Screen name="settings/printer" options={{ title: 'Printing', presentation: 'card' }} />
      <Stack.Screen name="settings/help" options={{ title: 'Help', presentation: 'card' }} />
      <Stack.Screen name="settings/about" options={{ title: 'About', presentation: 'card' }} />
      <Stack.Screen name="tools/qr" options={{ headerShown: false, presentation: 'fullScreenModal' }} />
      <Stack.Screen name="tools/id-card" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/compress" options={toolOptions} />
      <Stack.Screen name="tools/extract" options={toolOptions} />
      <Stack.Screen name="tools/watermark" options={toolOptions} />
      <Stack.Screen name="tools/timestamp" options={toolOptions} />
      <Stack.Screen name="tools/sign" options={toolOptions} />
      <Stack.Screen name="tools/long-image" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/book" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/whiteboard" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/erase-marks" options={toolOptions} />
      <Stack.Screen name="tools/extract-text" options={{ headerShown: false, presentation: 'card' }} />
    </Stack>
    </LockGate>
    {/* After the navigator so it draws above the tab screens; clears the
        floating tab bar. Full-screen surfaces (viewer) render their own. */}
    <BakeIndicator placement="bottom" offset={TAB_BAR_CLEARANCE} />
    </>
  );
}

export default function RootLayout() {
  useEffect(() => {
    // Fire-and-forget startup sweep of orphaned doc dirs and interrupted-
    // operation temp files. Delayed slightly so it never competes with render.
    // documentIdsForCleanup returns null when the list can't be trusted (doc
    // records exist that didn't parse), and then nothing is deleted.
    const t = setTimeout(() => {
      documentIdsForCleanup()
        .then(ids => (ids ? garbageCollectOrphans(ids) : 0))
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

    return () => clearTimeout(t);
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
