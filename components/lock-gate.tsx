// components/lock-gate.tsx
// Whole-app biometric lock overlay. Wraps the app's navigator; when the lock is
// enabled it covers ALL screens with a themed lock screen until the user
// authenticates.
//
// SAFETY: the user's documents are local-only with no backup, so this gate is
// biased toward never trapping them:
//   - No biometric hardware / auth throws → FAIL OPEN (unlock).
//   - Auth returns failure (cancel/fail) → stay locked but ALWAYS show a
//     manual "Unlock" button. Never auto-loop the prompt.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/theme-context';
import { authenticate } from '@/lib/biometrics';
import { getAppLockEnabled } from '@/lib/storage';

export function LockGate({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  // null = still loading the persisted flag (avoid flashing app content first).
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [locked, setLocked] = useState(false);

  // Prevents concurrent authenticate() prompts (mount + AppState 'active' could
  // otherwise fire two prompts on top of each other).
  const authingRef = useRef(false);
  // Read the latest `locked` inside the AppState listener without re-subscribing.
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  const tryUnlock = useCallback(async () => {
    if (authingRef.current) return;
    authingRef.current = true;
    try {
      const result = await authenticate('Unlock Scan Kit');
      if (result === 'success' || result === 'unavailable') {
        // 'unavailable' → FAIL OPEN: a missing/broken sensor must never brick.
        setLocked(false);
      }
      // 'failed' → stay locked; the Unlock button lets the user retry.
    } finally {
      authingRef.current = false;
    }
  }, []);

  // On mount: load the flag. If enabled, lock immediately and prompt once.
  useEffect(() => {
    let cancelled = false;
    getAppLockEnabled().then(on => {
      if (cancelled) return;
      setEnabled(on);
      if (on) {
        setLocked(true);
        tryUnlock();
      }
    });
    return () => { cancelled = true; };
  }, [tryUnlock]);

  // Re-lock on background; re-prompt when returning to foreground (if locked).
  useEffect(() => {
    if (!enabled) return;
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'background' || next === 'inactive') {
        setLocked(true);
      } else if (next === 'active') {
        if (lockedRef.current) tryUnlock();
      }
    });
    return () => sub.remove();
  }, [enabled, tryUnlock]);

  // Brief: don't flash app content before the lock can engage.
  if (enabled === null) return null;

  if (enabled && locked) {
    return (
      <View style={[styles.lockScreen, { backgroundColor: colors.bg, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.lockBody}>
          <View style={[styles.iconCircle, { backgroundColor: colors.accentLight }]}>
            <Ionicons name="lock-closed" size={44} color={colors.accent} />
          </View>
          <Text style={[styles.title, { color: colors.text }]}>Scan Kit is locked</Text>
          <Pressable
            onPress={tryUnlock}
            style={({ pressed }) => [
              styles.unlockBtn,
              { backgroundColor: colors.accent, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Ionicons name="finger-print" size={18} color="#fff" style={{ marginRight: 8 }} />
            <Text style={styles.unlockText}>Unlock</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return <>{children}</>;
}

const styles = StyleSheet.create({
  lockScreen: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  lockBody: { alignItems: 'center', paddingHorizontal: 32 },
  iconCircle: { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
  title: { fontSize: 20, fontWeight: '700', marginBottom: 32 },
  unlockBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 14, paddingHorizontal: 36, borderRadius: 12 },
  unlockText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
