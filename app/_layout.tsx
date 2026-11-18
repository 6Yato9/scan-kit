// app/_layout.tsx
import { useEffect, useState } from 'react';
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
import { garbageCollectOrphans } from '@/lib/files';
import { documentIdsForCleanup, getOnboarded, getOnboardedSync, pendingBakeMigrations } from '@/lib/storage';

// First-run gate: after mount, read the onboarding flag and redirect to the
// onboarding screen if it hasn't been completed. Kept separate from the tabs
// review effect. Doesn't block render — a brief flash of tabs is acceptable.
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
    if (onboarded === false && getOnboardedSync() !== true && pathname !== '/onboarding') {
      router.replace('/onboarding');
    }
  }, [onboarded, pathname, router]);

  return null;
}

// Height of the floating tab bar plus its gap above the home indicator.
const TAB_BAR_CLEARANCE = 104;

function ThemedStack() {
  const { colors, isDark } = useTheme();
  return (
    <>
    <StatusBar style={isDark ? 'light' : 'dark'} />
    <OnboardingGate />
    <FilterBaker />
    <LockGate>
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.card },
        headerTintColor: colors.text,
        headerTitleStyle: { color: colors.text, fontWeight: '600' },
        // react-navigation 7 ignores headerBackTitle:'' and falls back to the
        // route name, which surfaced the internal "(tabs)" label to users.
        headerBackButtonDisplayMode: 'minimal',
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      {/* App lock (components/lock-gate.tsx): covers full-screen modals too. */}
      <Stack.Screen name="lock" options={{ presentation: 'fullScreenModal', headerShown: false, gestureEnabled: false, animation: 'fade' }} />
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
      <Stack.Screen
        name="settings/scan-settings"
        options={{ title: 'Scan Settings', presentation: 'card' }}
      />
      <Stack.Screen
        name="settings/document-settings"
        options={{ title: 'Document Settings', presentation: 'card' }}
      />
      <Stack.Screen
        name="settings/printer"
        options={{ title: 'Printing', presentation: 'card' }}
      />
      <Stack.Screen
        name="settings/about"
        options={{ title: 'About', presentation: 'card' }}
      />
      <Stack.Screen name="tools/qr" options={{ headerShown: false, presentation: 'fullScreenModal' }} />
      <Stack.Screen name="tools/id-card" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/compress" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/extract" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/watermark" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/timestamp" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/sign" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/merge" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/long-image" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/book" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/whiteboard" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/erase-marks" options={{ headerShown: false, presentation: 'card' }} />
      <Stack.Screen name="tools/ask-ai" options={{ headerShown: false, presentation: 'card' }} />
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
