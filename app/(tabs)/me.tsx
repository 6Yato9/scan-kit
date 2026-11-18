// app/(tabs)/me.tsx
// Settings tab.
import { useCallback, useEffect, useState } from 'react';
import { Alert, InteractionManager, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Directory, File, Paths } from 'expo-file-system';
import { SegmentedControl, SettingsGroup, SettingsRow } from '@/components/settings-list';
import { getAppLockEnabled, setAppLockEnabled, TRASH_RETENTION_DAYS } from '@/lib/storage';
import { authenticate, biometricKind, BiometricKind, canAuthenticate } from '@/lib/biometrics';
import { tapLight } from '@/lib/haptics';
import { useTheme } from '@/contexts/theme-context';
import { Spacing, TAB_BAR_CLEARANCE } from '@/lib/theme';

/** Recursively sums the byte size of every file under a directory. */
function dirSize(dir: Directory): number {
  let total = 0;
  for (const child of dir.list()) {
    if (child instanceof File) {
      total += child.size ?? 0;
    } else if (child instanceof Directory) {
      total += dirSize(child);
    }
  }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

const LOCK_METHOD: Record<BiometricKind, string> = {
  faceId: 'Face ID',
  touchId: 'Touch ID',
  passcode: 'your passcode',
};

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [storageUsed, setStorageUsed] = useState<string | null>(null);
  const [appLock, setAppLock] = useState(false);
  const [lockKind, setLockKind] = useState<BiometricKind>('passcode');
  const { preference, setPreference, colors } = useTheme();

  useEffect(() => { biometricKind().then(setLockKind); }, []);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    getAppLockEnabled().then(v => { if (!cancelled) setAppLock(v); });
    // Walking the folder is synchronous; let the screen paint (with its
    // spinner) first.
    const task = InteractionManager.runAfterInteractions(() => {
      let text = 'Unavailable';
      try {
        const root = new Directory(Paths.document, 'scan-kit');
        text = formatBytes(root.exists ? dirSize(root) : 0);
      } catch {}
      if (!cancelled) setStorageUsed(text);
    });
    return () => { cancelled = true; task.cancel(); };
  }, []));

  // Toggle the whole-app lock. Turning it on requires a successful check so a
  // user can't enable a lock they can't pass. Turning it off fails open when
  // the device can't authenticate, so a broken sensor never traps the lock on.
  const handleToggleAppLock = async (next: boolean) => {
    tapLight();
    if (next) {
      if (!(await canAuthenticate())) {
        Alert.alert(
          'Set up a passcode first',
          'App lock uses Face ID, Touch ID or your device passcode. Turn one on in the Settings app, then try again.',
        );
        return;
      }
      const result = await authenticate('Turn on app lock');
      if (result === 'success') {
        await setAppLockEnabled(true);
        setAppLock(true);
      } else if (result === 'unavailable') {
        Alert.alert('App lock isn’t available', 'This device can’t verify your identity right now.');
      }
      // 'failed' (cancelled): leave it off silently.
    } else {
      const result = await authenticate('Turn off app lock');
      if (result === 'success' || result === 'unavailable') {
        await setAppLockEnabled(false);
        setAppLock(false);
      }
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 14, paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }]}
      >
        <Text style={[styles.screenTitle, { color: colors.text }]} accessibilityRole="header">Settings</Text>

        <SettingsGroup title="Appearance">
          <View style={styles.segmentWrap}>
            <SegmentedControl
              value={preference}
              onChange={setPreference}
              options={[
                { value: 'system', label: 'Automatic', icon: 'phone-portrait-outline' },
                { value: 'light', label: 'Light', icon: 'sunny-outline' },
                { value: 'dark', label: 'Dark', icon: 'moon-outline' },
              ]}
            />
          </View>
        </SettingsGroup>

        <SettingsGroup
          title="Security"
          footer={`When on, Scan Kit asks for ${LOCK_METHOD[lockKind]} each time you return to it.`}
        >
          <SettingsRow
            icon="lock-closed-outline"
            label="App lock"
            accessory={{ type: 'switch', value: appLock, onChange: handleToggleAppLock }}
            last
          />
        </SettingsGroup>

        <SettingsGroup title="Scanning and documents">
          <SettingsRow icon="camera-outline" label="Scan settings" accessory={{ type: 'chevron' }} onPress={() => router.push('/settings/scan-settings')} />
          <SettingsRow icon="document-text-outline" label="Document settings" accessory={{ type: 'chevron' }} onPress={() => router.push('/settings/document-settings')} />
          <SettingsRow icon="print-outline" label="Printing" accessory={{ type: 'chevron' }} onPress={() => router.push('/settings/printer')} last />
        </SettingsGroup>

        <SettingsGroup title="Storage" footer={`Everything is stored on this device only. Deleted documents stay in Recently deleted for ${TRASH_RETENTION_DAYS} days.`}>
          <SettingsRow icon="server-outline" label="Space used" accessory={{ type: 'value', text: storageUsed }} />
          <SettingsRow
            icon="trash-outline"
            label="Recently deleted"
            accessory={{ type: 'chevron' }}
            onPress={() => router.push('/settings/recently-deleted' as never)}
            last
          />
        </SettingsGroup>

        <SettingsGroup title="Support">
          <SettingsRow icon="help-circle-outline" label="Help" accessory={{ type: 'chevron' }} onPress={() => router.push('/settings/help')} />
          <SettingsRow icon="information-circle-outline" label="About Scan Kit" accessory={{ type: 'chevron' }} onPress={() => router.push('/settings/about')} last />
        </SettingsGroup>

      </ScrollView>
      {/* Opaque mask over the status bar so the scrolling title and section
          labels never pass under the clock and battery. */}
      <View style={[styles.statusMask, { height: insets.top, backgroundColor: colors.bg }]} pointerEvents="none" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: Spacing.gutter },
  // Matches the large title on Home / Files / Tools.
  screenTitle: {
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: -0.5,
    paddingHorizontal: 20 - Spacing.gutter,
    marginBottom: Spacing.xs,
  },
  segmentWrap: { padding: 0 },
  statusMask: { position: 'absolute', top: 0, left: 0, right: 0 },
});
