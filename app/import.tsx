// app/import.tsx
// Landing screen for "Open in Scan Kit" (see app/+native-intent.tsx): saves the
// incoming PDF or image as a new document and replaces itself with the viewer.
// Images are auto-cropped like any other photo import. iOS hands over either
// a copy in Documents/Inbox or (open in place) the user's original file; it is
// copied into our cache first (stageCopy) and only an Inbox copy is removed.
// Android hands over content:// URLs (one, or several shared together as
// `uris`): their name and type come from the system (incomingFileInfo), and
// several images become one document (planIncomingImport). Our copy is kept until a document has been saved from it, so
// a failed save offers "Try again" instead of asking for the file again. A
// scan still being saved when the file arrives is waited for, not an error.
//
// App Lock: while the app is locked this screen shows the lock screen instead
// of the file's name, and it opens the viewer only after the user has
// unlocked — the viewer is a full-screen modal that would otherwise appear
// above the lock without any authentication. The file is saved meanwhile.
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Directory, File, Paths } from 'expo-file-system';
import { useTheme } from '@/contexts/theme-context';
import { useImportDocuments } from '@/components/use-import';
import { PrimaryButton } from '@/components/primary-button';
import { LockScreen, useAppLocked } from '@/components/lock-gate';
import {
  displayNameOf,
  documentNameFor,
  documentNameFromFileName,
  importKindOf,
  isContentUrl,
  parseIncomingUris,
  planIncomingImport,
  type ImportKind,
} from '@/lib/incoming-file';
import { abandonSystemUI } from '@/lib/system-ui';
import { indexPdfText } from '@/lib/pdf-text';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { Spacing, Type } from '@/lib/theme';
import { VisionOcr } from '@/modules/vision-ocr/src';

type Status = { state: 'working' } | { state: 'failed'; title: string; body: string; retry?: boolean };

/**
 * Where incoming files are staged: Caches/incoming/. The startup sweep clears
 * that folder (lib/files.ts TEMP_DIRS), so a copy left by an import the app
 * was killed in the middle of doesn't stay on disk, unprotected, for good.
 */
function stagingDir(): Directory {
  const dir = new Directory(Paths.cache, 'incoming');
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/**
 * Copy into our cache first: the original may live in a location iOS cleans
 * up — or, with "Open in place" (LSSupportsOpeningDocumentsInPlace), it IS the
 * user's own file, in another app's folder or iCloud Drive, handed over as a
 * security-scoped URL. VisionOcr.copyIncomingFile opens that scope and reads
 * through NSFileCoordinator (so a file still downloading or being saved is
 * read whole); a plain copy can't reach such a file at all. The original is
 * only ever read, never moved or removed (removeInboxCopy aside).
 */
async function stageCopy(uri: string, displayName: string = displayNameOf(uri)): Promise<string> {
  const name = displayName.replace(/[^\w .()-]/g, '_') || 'import';
  const dest = new File(stagingDir(), `incoming-${Date.now()}-${name}`);
  const native = VisionOcr?.copyIncomingFile;
  if (native) {
    try {
      await native(uri, dest.uri);
      if (new File(dest.uri).exists) return dest.uri;
    } catch (err) {
      console.warn('copyIncomingFile failed; trying a plain copy', err);
    }
  }
  // A dev client built before the native function existed, or a file the
  // coordinated read couldn't open (an ordinary file in our own Inbox).
  const leftover = new File(dest.uri);
  if (leftover.exists) leftover.delete();
  if (isContentUrl(uri)) throw new Error('A content URL needs the native copy');
  new File(uri).copy(new File(dest.uri));
  return dest.uri;
}

type IncomingFile = { uri: string; name: string; kind: ImportKind | null };

/**
 * Name and kind of an incoming file. A file:// URL is judged by its name; an
 * Android content:// URL has none, so the system is asked (incomingFileInfo).
 */
async function describeIncoming(uri: string): Promise<IncomingFile> {
  const info = isContentUrl(uri) && typeof VisionOcr?.incomingFileInfo === 'function'
    ? await VisionOcr.incomingFileInfo(uri).catch(() => null)
    : null;
  const name = info?.name || displayNameOf(uri);
  return { uri, name, kind: importKindOf(info?.name ?? uri, info?.mimeType) };
}

/** A fresh copy of a staged file for one import attempt, or null if it can't be made. */
function copyOf(uri: string): string | null {
  try {
    const src = new File(uri);
    const dest = new File(stagingDir(), `attempt-${Date.now()}-${src.name}`);
    src.copy(dest);
    return dest.uri;
  } catch (err) {
    console.warn('Copy staged file failed', err);
    return null;
  }
}

function deleteQuietly(uri: string) {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // Cache; cleared by the system eventually.
  }
}

/** One spelling per file: no ?query, escapes decoded, /private/var as /var. */
function fileKey(uri: string): string {
  let u = uri.split('?')[0];
  try {
    u = decodeURIComponent(u);
  } catch {}
  return u.replace(/^file:\/\/\/private\/var\//, 'file:///var/');
}

/**
 * True only for a copy iOS made for us directly in THIS app's own
 * Documents/Inbox. With open-in-place a file can come from anywhere — another
 * app's or iCloud Drive's "Documents/Inbox" folder included — and that is the
 * user's original, which must never be deleted (r11 #3).
 */
function isOwnInboxCopy(uri: string): boolean {
  try {
    const inbox = fileKey(`${Paths.document.uri.replace(/\/*$/, '/')}Inbox/`);
    const key = fileKey(uri);
    if (!key.startsWith(inbox)) return false;
    const rest = key.slice(inbox.length);
    return rest.length > 0 && !rest.includes('/') && rest !== '.' && rest !== '..';
  } catch {
    return false;
  }
}

function removeInboxCopy(uri: string) {
  // Only the copy iOS made for us in our own Documents/Inbox — never a file elsewhere.
  if (!isOwnInboxCopy(uri)) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // Left for the next import; harmless.
  }
}

export default function ImportScreen() {
  const { uri, uris } = useLocalSearchParams<{ uri?: string; uris?: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const { saveFiles } = useImportDocuments();
  const locked = useAppLocked();
  const [status, setStatus] = useState<Status>({ state: 'working' });
  // Set once the document is saved; the viewer opens when the app is unlocked.
  const [savedId, setSavedId] = useState<string | null>(null);
  const started = useRef(false);
  const mounted = useRef(true);
  // What is being imported, once known (a content:// URL's name is asked for).
  const [incoming, setIncoming] = useState<{ files: IncomingFile[]; kind: ImportKind } | null>(null);
  const sources = parseIncomingUris(uri, uris);
  const fileName = incoming
    ? (incoming.files.length > 1 ? `${incoming.files.length} files` : incoming.files[0].name)
    : sources.length > 1 ? `${sources.length} files`
    : sources.length === 1 && !isContentUrl(sources[0]) ? displayNameOf(sources[0]) : 'this file';

  useEffect(() => {
    mounted.current = true;
    // Presenting this screen closed any camera or picker that was open
    // ("Open in Scan Kit" while scanning). Their promises never settle on their
    // own; settle them as cancelled so the screens that opened them recover.
    abandonSystemUI();
    return () => { mounted.current = false; };
  }, []);

  // Our own copy of the incoming file. Kept until a document has been saved
  // from it, so a failed save can be retried without sharing the file again
  // (iOS's Inbox copy is gone by then); deleted once saved or when the user
  // leaves this screen.
  const stagedRef = useRef<string[] | null>(null);
  const planRef = useRef<{ kind: ImportKind; name: string | null } | null>(null);
  const attemptingRef = useRef(false);

  const dropStaged = () => {
    stagedRef.current?.forEach(deleteQuietly);
    stagedRef.current = null;
  };

  /** Saves the staged copy as a document; on failure keeps it for "Try again". */
  const attempt = async () => {
    const staged = stagedRef.current;
    const plan = planRef.current;
    if (!staged?.length || !plan || attemptingRef.current) return;
    attemptingRef.current = true;
    setStatus({ state: 'working' });
    // The import consumes the files it is given (auto-crop deletes its input
    // once it has a cropped copy), so each attempt works on its own copies and
    // the staged ones survive a failure.
    let work: (string | null)[] = [];
    try {
      const kind = plan.kind;
      work = staged.map(copyOf);
      const copies = work.every(Boolean) ? (work as string[]) : null;
      // Waits for a scan that is still being saved (scan-context saveAndOpen).
      const id = copies
        ? await saveFiles(copies, kind, plan.name).catch(err => {
            console.error('Import incoming file failed', err);
            return null;
          })
        : null;
      if (id) {
        // The document has its own copy now.
        dropStaged();
        // A PDF's own text goes into the search index straight away (images
        // are recognised by the import itself).
        if (kind === 'pdf') indexPdfText(id).catch(() => {});
        // A finished import that nobody is waiting for stays in Files; just don't navigate.
        if (mounted.current) setSavedId(id);
        return;
      }
      if (!mounted.current) {
        dropStaged();
        return;
      }
      setStatus({
        state: 'failed',
        title: 'Couldn’t import the file',
        body: 'Check that your device has free space, then try again.',
        retry: true,
      });
    } finally {
      work.forEach(w => { if (w) deleteQuietly(w); });
      attemptingRef.current = false;
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const list = parseIncomingUris(uri, uris).map(u => (isContentUrl(u) ? u : u.split('?')[0]));
    const cantOpen = () => setStatus({
      state: 'failed',
      title: 'Scan Kit can’t open this file',
      body: 'Only PDFs and images can be imported.',
    });
    if (!list.length) {
      cantOpen();
      return;
    }
    (async () => {
      const files = await Promise.all(list.map(describeIncoming));
      const plan = planIncomingImport(files);
      if (!plan) {
        list.forEach(removeInboxCopy);
        if (mounted.current) cantOpen();
        return;
      }
      const chosen = plan.uris.map(u => files.find(f => f.uri === u)!);
      if (mounted.current) setIncoming({ files: chosen, kind: plan.kind });
      const staged: string[] = [];
      try {
        for (const f of chosen) staged.push(await stageCopy(f.uri, f.name));
      } catch (err) {
        console.warn('Stage incoming file failed', err);
        staged.forEach(deleteQuietly);
        list.forEach(removeInboxCopy);
        if (!mounted.current) return;
        setStatus({
          state: 'failed',
          title: 'Couldn’t open the file',
          body: 'It may have been moved or deleted. Try sharing it again.',
        });
        return;
      }
      if (!mounted.current) {
        staged.forEach(deleteQuietly);
        return;
      }
      stagedRef.current = staged;
      // A file keeps its own name ("Invoice.pdf" → "Invoice"); several shared
      // photos get the usual "Scan <date>".
      planRef.current = {
        kind: plan.kind,
        name: chosen.length === 1
          ? (isContentUrl(chosen[0].uri) ? documentNameFromFileName(chosen[0].name) : documentNameFor(chosen[0].uri))
          : null,
      };
      // We have our own copies now (kept until the import succeeds); iOS's
      // Inbox copy is no longer needed whatever happens next.
      list.forEach(removeInboxCopy);
      attempt();
    })();
    // `attempt` reads refs only; this runs once per incoming file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri, uris, saveFiles]);

  // Leaving the screen with a failed import: the staged copy goes too.
  useEffect(() => () => {
    if (!attemptingRef.current) dropStaged();
  }, []);

  // Open the viewer only once the app is unlocked (and the lock screen has
  // gone); leaving the screen first cancels the held navigation.
  useEffect(() => {
    if (!savedId || locked) return;
    return navigateWhenUnlocked(() => router.replace({ pathname: '/viewer', params: { id: savedId } }));
  }, [savedId, locked, router]);

  const goHome = () => {
    dropStaged();
    router.replace('/');
  };

  if (locked) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false, animation: 'fade', gestureEnabled: false }} />
        <LockScreen />
      </>
    );
  }

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
          {status.retry ? (
            <>
              <PrimaryButton title="Try again" onPress={attempt} style={styles.btn} />
              <PrimaryButton title="Go to Home" variant="secondary" onPress={goHome} style={styles.btnNext} />
            </>
          ) : (
            <PrimaryButton title="Go to Home" onPress={goHome} style={styles.btn} />
          )}
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
  btnNext: { alignSelf: 'stretch' },
});
