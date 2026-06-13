// app/_layout.tsx
import { useEffect, useState } from 'react';
import { Stack, usePathname, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ScanProvider } from '@/contexts/scan-context';
import { ThemeProvider, useTheme } from '@/contexts/theme-context';
import { ToastProvider } from '@/components/toast';
import { ErrorBoundary } from '@/components/error-boundary';
import { LockGate } from '@/components/lock-gate';
import { garbageCollectOrphans } from '@/lib/files';
import { getDocuments, getOnboarded } from '@/lib/storage';

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
    if (onboarded === false && pathname !== '/onboarding') {
      router.replace('/onboarding');
    }
  }, [onboarded, pathname, router]);

  return null;
}

function ThemedStack() {
  const { colors, isDark } = useTheme();
  return (
    <>
    <StatusBar style={isDark ? 'light' : 'dark'} />
    <OnboardingGate />
    <LockGate>
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.card },
        headerTintColor: colors.text,
        headerTitleStyle: { color: colors.text, fontWeight: '600' },
        headerBackTitle: '',           // hide "(tabs)" back label
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="onboarding"
        options={{ headerShown: false, presentation: 'fullScreenModal' }}
      />
      <Stack.Screen
        name="viewer"
        options={{ presentation: 'fullScreenModal', headerShown: false }}
      />
      <Stack.Screen
        name="review"
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
        options={{ title: 'My Printer', presentation: 'card' }}
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
    </>
  );
}

export default function RootLayout() {
  useEffect(() => {
    // Fire-and-forget startup sweep of orphaned doc dirs and interrupted-
    // operation temp files. Delayed slightly so it never competes with render.
    const t = setTimeout(() => {
      getDocuments()
        .then(docs => garbageCollectOrphans(docs.map(d => d.id)))
        .catch(() => {});
    }, 2000);
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
