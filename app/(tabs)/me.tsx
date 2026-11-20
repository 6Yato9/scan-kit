// app/(tabs)/me.tsx
// Settings tab.
import { useCallback, useEffect, useState } from 'react';
import { Alert, InteractionManager, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Directory, File } from 'expo-file-system';
import { scanRoots, signaturesDir } from '@/lib/storage-layout';
import { SegmentedControl, SettingsGroup, SettingsRow } from '@/components/settings-list';
import { getAppLockEnabled, getDocuments, setAppLockEnabled, TRASH_RETENTION_DAYS } from '@/lib/storage';
import { MultiShareSheet } from '@/components/multi-share-sheet';
import { useToast } from '@/components/toast';
import type { Document } from '@/types/document';
import { authenticate, biometricKind, BiometricKind, canAuthenticate, lockMethodLabel } from '@/lib/biometrics';
import { tapLight } from '@/lib/haptics';
import { filesCopyAvailable, getFilesCopyEnabled, removeFilesCopies, setFilesCopyEnabled } from '@/lib/files-copy';
import { getRecoveredGroups } from '@/lib/recovered-files';
import { useTheme } from '@/contexts/theme-context';
import { LargeTitle } from '@/components/screen-header';
import { SectionLabel } from '@/components/section-label';
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

/** Decimal units (1 MB = 1,000,000 bytes), as iOS Settings › iPhone Storage counts. */
function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [storageUsed, setStorageUsed] = useState<string | null>(null);
  const [appLock, setAppLock] = useState(false);
  const [lockKind, setLockKind] = useState<BiometricKind>('passcode');
  const { preference, setPreference, colors } = useTheme();
  const toast = useToast();
  // Export all: every live document as a PDF, packed in one ZIP.
  const [exportDocs, setExportDocs] = useState<Document[]>([]);
  const [exportVisible, setExportVisible] = useState(false);

  const openExportAll = useCallback(() => {
    getDocuments()
      .then(docs => {
        const exportable = docs.filter(d => !!d.pdfUri || d.pages.length > 0);
        if (exportable.length === 0) {
          toast.show('There are no documents to export yet');
          return;
        }
        setExportDocs(exportable);
        setExportVisible(true);
      })
      .catch(() => Alert.alert('Couldn’t read your documents', 'Try again.'));
  }, [toast]);

  useEffect(() => { biometricKind().then(setLockKind); }, []);

  // Keep a copy in Files: a searchable PDF of every document in the app's
  // folder in the Files app, kept up to date (lib/files-copy.ts).
  const [filesCopy, setFilesCopy] = useState(false);
  useEffect(() => { getFilesCopyEnabled().then(setFilesCopy); }, []);
  const handleToggleFilesCopy = (next: boolean) => {
    tapLight();
    setFilesCopy(next);
    if (next) {
      setFilesCopyEnabled(true)
        .then(() => toast.show('Saving your documents to Files'))
        .catch(() => {
          setFilesCopy(false);
          Alert.alert('Couldn’t turn this on', 'Try again.');
        });
      return;
    }
    void setFilesCopyEnabled(false);
    Alert.alert('Remove the copies from Files?', 'Your documents in Scan Kit stay as they are.', [
      { text: 'Keep copies', style: 'cancel' },
      {
        text: 'Remove copies',
        style: 'destructive',
        onPress: () => {
          removeFilesCopies()
            .then(n => toast.show(n === 1 ? 'Removed 1 copy from Files' : `Removed ${n} copies from Files`))
            .catch(() => Alert.alert('Couldn’t remove the copies', 'Delete them in the Files app instead.'));
        },
      },
    ]);
  };

  // Files an update set aside (lib/recovered-files.ts): the row shows only when there are some.
  const [recoveredCount, setRecoveredCount] = useState(0);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    getAppLockEnabled().then(v => { if (!cancelled) setAppLock(v); });
    getRecoveredGroups().then(g => { if (!cancelled) setRecoveredCount(g.length); }).catch(() => {});
    // Walking the folder is synchronous; let the screen paint (with its
    // spinner) first.
    const task = InteractionManager.runAfterInteractions(() => {
      let text = 'Unavailable';
      try {
        // Every document folder (both places while the move out of Documents
        // is part done, lib/storage-layout.ts) plus the saved signatures.
        const total = [...scanRoots(), signaturesDir()].reduce((sum, d) => sum + (d.exists ? dirSize(d) : 0), 0);
        text = formatBytes(total);
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
          Platform.OS === 'android' ? 'Set up a screen lock first' : 'Set up a passcode first',
          Platform.OS === 'android'
            ? 'App lock uses your fingerprint, your face or your screen lock. Set up a screen lock in the Settings app, then try again.'
            : 'App lock uses Face ID, Touch ID or your device passcode. Turn one on in the Settings app, then try again.',
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
        contentContainerStyle={{ paddingTop: insets.top, paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}
      >
        <LargeTitle title="Settings" />
        <View style={styles.content}>
          <SectionLabel>Appearance</SectionLabel>
          <SegmentedControl
            value={preference}
            onChange={setPreference}
            options={[
              { value: 'system', label: 'Automatic', icon: 'phone-portrait-outline' },
              { value: 'light', label: 'Light', icon: 'sunny-outline' },
              { value: 'dark', label: 'Dark', icon: 'moon-outline' },
            ]}
          />

          <SettingsGroup title="Security">
            <SettingsRow
              icon="lock-closed-outline"
              label="App lock"
              description={`Ask for ${lockMethodLabel(lockKind)} on return`}
              accessory={{ type: 'switch', value: appLock, onChange: handleToggleAppLock }}
              last
            />
          </SettingsGroup>

          <SettingsGroup title="Scanning and documents">
            <SettingsRow icon="camera-outline" label="Scan settings" accessory={{ type: 'chevron' }} onPress={() => router.push('/settings/scan-settings')} />
            <SettingsRow icon="document-text-outline" label="Document settings" accessory={{ type: 'chevron' }} onPress={() => router.push('/settings/document-settings')} />
            <SettingsRow icon="print-outline" label="Printing" accessory={{ type: 'chevron' }} onPress={() => router.push('/settings/printer')} last />
          </SettingsGroup>

          {/* No loose footers: at rest the floating tab bar sits over the end
              of the list, and a sentence cut by the camera button looks broken.
              The notes live in the rows instead. */}
          <SettingsGroup title="Storage">
            <SettingsRow
              icon="server-outline"
              label="Space used on this device"
              accessory={{ type: 'value', text: storageUsed }}
            />
            <SettingsRow
              icon="contract-outline"
              label="Free up space"
              description="Shrink the pages of a scanned document"
              accessory={{ type: 'chevron' }}
              onPress={() => router.push('/tools/compress')}
            />
            <SettingsRow
              icon="archive-outline"
              label="Export all documents"
              description="Searchable PDFs in one ZIP file"
              accessory={{ type: 'chevron' }}
              onPress={openExportAll}
            />
            {filesCopyAvailable() && <SettingsRow
              icon="copy-outline"
              label="Keep a copy in Files"
              description={
                appLock
                  ? 'A PDF of every document in the Files app, kept up to date. App lock doesn’t cover it.'
                  : 'A PDF of every document in the Files app, kept up to date'
              }
              accessory={{ type: 'switch', value: filesCopy, onChange: handleToggleFilesCopy }}
            />}
            <SettingsRow
              icon="trash-outline"
              label="Recently deleted"
              description={`Restore deleted documents for ${TRASH_RETENTION_DAYS} days`}
              accessory={{ type: 'chevron' }}
              onPress={() => router.push('/settings/recently-deleted' as never)}
              last={recoveredCount === 0}
            />
            {recoveredCount > 0 && <SettingsRow
              icon="file-tray-full-outline"
              label="Recovered files"
              description="Pages an update set aside"
              accessory={{ type: 'chevron' }}
              onPress={() => router.push('/settings/recovered-files' as never)}
              last
            />}
          </SettingsGroup>

          <SettingsGroup>
            <SettingsRow icon="help-circle-outline" label="Help" accessory={{ type: 'chevron' }} onPress={() => router.push('/settings/help')} />
            <SettingsRow icon="information-circle-outline" label="About Scan Kit" accessory={{ type: 'chevron' }} onPress={() => router.push('/settings/about')} last />
          </SettingsGroup>
        </View>
      </ScrollView>
      <MultiShareSheet
        visible={exportVisible}
        documents={exportDocs}
        exportAll
        onClose={() => setExportVisible(false)}
      />
      {/* Opaque mask over the status bar so the scrolling title and section
          labels never pass under the clock and battery. */}
      <View style={[styles.statusMask, { height: insets.top, backgroundColor: colors.bg }]} pointerEvents="none" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: Spacing.gutter },
  statusMask: { position: 'absolute', top: 0, left: 0, right: 0 },
});
