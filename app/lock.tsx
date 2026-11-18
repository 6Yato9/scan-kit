// app/lock.tsx
// The lock screen as a route, pushed by LockGate when the app returns from the
// background so it covers full-screen modals (viewer, annotate, tools) too.
// It can't be swiped or backed away; LockGate dismisses it after unlocking.
import { useEffect } from 'react';
import { BackHandler } from 'react-native';
import { Stack } from 'expo-router';
import { LockScreen } from '@/components/lock-gate';

export default function LockRoute() {
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  return (
    <>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <LockScreen />
    </>
  );
}
