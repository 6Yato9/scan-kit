// app/import.tsx
// Landing screen for "Open in Scan Kit" (see app/+native-intent.tsx): saves the
// incoming PDF or image as a new document and replaces itself with the viewer.
// Images are auto-cropped like any other photo import. iOS copies the shared
// file into Documents/Inbox; that copy is removed once it has been imported.
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { File, Paths } from 'expo-file-system';
import { useTheme } from '@/contexts/theme-context';
import { useImportDocuments } from '@/components/use-import';
import { PrimaryButton } from '@/components/primary-button';
import { displayNameOf, documentNameFor, importKindOf } from '@/lib/incoming-file';
import { Spacing, Type } from '@/lib/theme';

type Status = { state: 'working' } | { state: 'failed'; title: string; body: string };

/** Copy into our cache first: the original may live in a location iOS cleans up. */
function stageCopy(uri: string): string {
  const src = new File(uri);
  const name = displayNameOf(uri).replace(/[^\w .()-]/g, '_') || 'import';
  const dest = new File(Paths.cache, `incoming-${Date.now()}-${name}`);
  src.copy(dest);
  return dest.uri;
}

function removeInboxCopy(uri: string) {
  // Only the copy iOS made for us in Documents/Inbox — never a file elsewhere.
  if (!/\/Documents\/Inbox\//.test(uri)) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // Left for the next import; harmless.
  }
}

export default function ImportScreen() {
  const { uri } = useLocalSearchParams<{ uri?: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const { saveFiles } = useImportDocuments();
  const [status, setStatus] = useState<Status>({ state: 'working' });
  const started = useRef(false);
  const fileName = uri ? displayNameOf(uri) : 'this file';

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const kind = uri ? importKindOf(uri) : null;
      if (!uri || !kind) {
        setStatus({
          state: 'failed',
          title: 'Scan Kit can’t open this file',
          body: 'Only PDFs and images can be imported.',
        });
        return;
      }
      let staged: string;
      try {
        staged = stageCopy(uri.split('?')[0]);
      } catch (err) {
        console.warn('Stage incoming file failed', err);
        setStatus({
          state: 'failed',
          title: 'Couldn’t open the file',
          body: 'It may have been moved or deleted. Try sharing it again.',
        });
        return;
      }
      const id = await saveFiles([staged], kind, documentNameFor(uri)).catch(err => {
        console.error('Import incoming file failed', err);
        return null;
      });
      if (!id) {
        // saveAndOpen has already explained a storage failure.
        setStatus({
          state: 'failed',
          title: 'Couldn’t import the file',
          body: 'Check that your device has free space, then try again.',
        });
        return;
      }
      removeInboxCopy(uri.split('?')[0]);
      // The document has its own copy now.
      try {
        const f = new File(staged);
        if (f.exists) f.delete();
      } catch {
        // Cache; cleared by the system eventually.
      }
      router.replace({ pathname: '/viewer', params: { id } });
    })();
  }, [uri, saveFiles, router]);

  const goHome = () => router.replace('/');

  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ headerShown: false, animation: 'fade', gestureEnabled: false }} />
      {status.state === 'working' ? (
        <View style={styles.center} accessibilityLiveRegion="polite">
          <ActivityIndicator color={colors.muted} />
          <Text style={[Type.headline, styles.text, { color: colors.text }]}>Importing</Text>
          <Text style={[Type.footnote, styles.text, { color: colors.muted }]} numberOfLines={2}>{fileName}</Text>
        </View>
      ) : (
        <View style={styles.center}>
          <Ionicons name="document-outline" size={44} color={colors.muted} />
          <Text style={[Type.headline, styles.text, { color: colors.text }]}>{status.title}</Text>
          <Text style={[Type.footnote, styles.text, { color: colors.muted }]}>{status.body}</Text>
          <PrimaryButton title="Go to Home" onPress={goHome} style={styles.btn} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, padding: Spacing.xxl },
  text: { textAlign: 'center' },
  btn: { alignSelf: 'stretch', marginTop: Spacing.lg },
});
