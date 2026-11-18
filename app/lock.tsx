// app/lock.tsx
// The lock screen as a route, pushed by LockGate when the app returns from the
// background so it covers full-screen modals (viewer, annotate, tools) too.
// It can't be swiped or backed away.
//
// It dismisses ITSELF whenever it is the focused screen and the app is
// unlocked — not only at the moment of unlocking. Another screen may sit above
// it when the unlock happens ("Open in Scan Kit" pushes /import, which then
// becomes the viewer); once that screen closes this route is uncovered while
// already unlocked, and must get out of the way instead of trapping the user.
import { useCallback, useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { LockScreen, useAppLocked } from '@/components/lock-gate';
import { FilterBaker } from '@/components/filter-baker';

export default function LockRoute() {
  const router = useRouter();
  const locked = useAppLocked();
  const dismissed = useRef(false);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (locked || dismissed.current) return;
      dismissed.current = true;
      if (router.canGoBack()) router.back();
      else router.replace('/');
    }, [locked, router]),
  );

  return (
    <>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <LockScreen />
      {/* The lock covers every other screen's baker, so it hosts one itself —
          otherwise bakes queued just before locking would stall until unlock. */}
      <FilterBaker />
    </>
  );
}
