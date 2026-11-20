// app/tools/protect.tsx
// Protect PDF: a password to open, added on the device (lib/pdf-protect.ts).
// Pick a document — an imported PDF, or a scanned document, which is made
// into the PDF Share would make of it — and type the password twice (show /
// hide, a strength hint that is only a hint: the one rule is 4 characters).
// The screen says plainly that Scan Kit can't recover a forgotten password.
//
// The result is a new document "<name> (protected)" in the same folder (the
// default, the original kept; Undo removes it: lib/copy-undo.ts), or, for an
// imported PDF, the original protected in place, with Undo in the viewer.
// Either way it opens in the viewer, which asks for the password as it does
// for any protected PDF. A PDF that already needs a password isn't offered:
// Unlock PDF removes it first.
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useTheme } from '@/contexts/theme-context';
import { useScan } from '@/contexts/scan-context';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import { useToast } from '@/components/toast';
import { OptionList, ToolIntro, ToolNote, ToolProgress, ToolScreen, useToolDocuments } from '@/components/tool-ui';
import { ToolDocPicker, useToolDoc } from '@/components/tool-doc';
import { StatusCard, StatusLoading } from '@/components/status-card';
import {
  canProtectDocuments,
  isProtectableDoc,
  MIN_PDF_PASSWORD,
  passwordHint,
  passwordStrength,
  PdfProtectToolError,
  protectedName,
  protectStoredPdf,
  readProtectState,
  saveProtectedCopy,
  type PasswordStrength,
  type ProtectProgress,
  type ProtectState,
} from '@/lib/pdf-protect';
import { discardPdfEditUndo, holdPdfEditUndo, PdfEditError, undoPdfEdit } from '@/lib/pdf-edit';
import { openNewCopy } from '@/lib/copy-undo';
import { postViewerNotice } from '@/lib/viewer-notice';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';
import type { Document } from '@/types/document';
import { unavailableCopy } from '@/lib/platform-support';

/** iOS: a build older than the feature; Android: not built yet (lib/platform-support.ts). */
const UNAVAILABLE = unavailableCopy(
  { title: 'Update Scan Kit to protect PDFs', text: 'This version of Scan Kit can’t add a password to a PDF. Install the latest version, then try again.' },
  'Protect PDF',
);

type Output = 'copy' | 'replace';

/** The chosen document's state, for the document (and version) it was read from. */
type Read =
  | { key: string; status: 'loading' }
  | { key: string; status: 'ready'; state: ProtectState }
  | { key: string; status: 'unreadable' };

const keyOf = (d: Document) => `${d.id}:${d.updatedAt}`;

const STRENGTH_BARS: Record<PasswordStrength, number> = { short: 0, weak: 1, fair: 2, strong: 3 };

function progressLabel(p: ProtectProgress): string {
  if (p.phase === 'enhancing') return 'Finishing enhancements';
  if (p.phase === 'protecting') return 'Adding the password';
  return `Preparing page ${Math.min(p.done + 1, p.total)} of ${p.total}`;
}

export default function ProtectScreen() {
  const router = useRouter();
  const toast = useToast();
  const { colors, isDark } = useTheme();
  const { bumpLastSaved } = useScan();
  const available = canProtectDocuments();
  const { docs, loaded, reload } = useToolDocuments(isProtectableDoc);
  const { doc, setDocId, fixed, fromViewer } = useToolDoc(docs);
  const [output, setOutput] = useState<Output>('copy');
  // Read when the work starts, whichever render's handler started it.
  const outputRef = useRef<Output>('copy');
  const chooseOutput = (v: Output) => {
    outputRef.current = v;
    setOutput(v);
  };
  const [read, setRead] = useState<Read | null>(null);
  // The password lives only here, and only until the PDF is protected.
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [shown, setShown] = useState(false);
  const confirmRef = useRef<TextInput>(null);
  const [progress, setProgress] = useState<ProtectProgress | null>(null);
  const [working, setWorking] = useState(false);
  const workingRef = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
    abort.current?.abort();
  }, []);

  const docKey = doc ? keyOf(doc) : null;
  useEffect(() => {
    if (!doc || !docKey || !available) return;
    let cancelled = false;
    setRead({ key: docKey, status: 'loading' });
    readProtectState(doc)
      .then(state => { if (!cancelled) setRead({ key: docKey, status: 'ready', state }); })
      .catch(() => { if (!cancelled) setRead({ key: docKey, status: 'unreadable' }); });
    return () => { cancelled = true; };
    // `doc` is read through docKey (its id and version).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, available]);

  const current = read && read.key === docKey ? read : null;
  const state = current?.status === 'ready' ? current.state : null;
  const protectable = !!state && state.kind !== 'has-password';
  const isPdf = state?.kind === 'pdf';
  const strength = passwordStrength(pw);
  const mismatch = pw2.length > 0 && pw2 !== pw;
  const ready = protectable && strength !== 'short' && pw2 === pw;

  const explain = (err: unknown) => {
    const kind = err instanceof PdfProtectToolError ? err.kind : 'failed';
    if (kind === 'cancelled') return;
    notifyError();
    if (kind === 'missing' || kind === 'changed') {
      reload();
      Alert.alert('Couldn’t protect the PDF', 'The document changed in the meantime. Try again.');
    } else if (kind === 'has-password') {
      reload();
      Alert.alert('This PDF already has a password', 'Remove it with Unlock PDF first, then add a new one.');
    } else if (kind === 'unreadable') {
      Alert.alert('Couldn’t read this PDF', 'The file may be damaged. Try importing it again.');
    } else if (kind === 'partial') {
      Alert.alert('Your PDF was changed', 'Scan Kit couldn’t finish saving the change, so it can’t be undone. It’s finished the next time Scan Kit opens. Check that there’s free space.');
    } else {
      console.error('Protect PDF failed', err);
      Alert.alert('Couldn’t protect the PDF', 'Your document is unchanged. Check that there’s free space, then try again.');
    }
  };

  const start = async () => {
    if (!doc || !ready || workingRef.current) return;
    workingRef.current = true;
    setWorking(true);
    const target = doc;
    const password = pw;
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      if (outputRef.current === 'copy' || !isPdf) {
        const copy = await saveProtectedCopy(target.id, password, {
          signal: ctl.signal,
          onProgress: p => { if (mounted.current) setProgress(p); },
        });
        bumpLastSaved();
        notifySuccess();
        setPw('');
        setPw2('');
        openNewCopy({
          copy,
          message: 'PDF protected. The original is kept.',
          what: 'protected',
          sourceId: target.id,
          fromViewer,
          router,
          toast,
          bumpLastSaved,
        });
        return;
      }
      const { undo } = await protectStoredPdf(target.id, password);
      bumpLastSaved();
      notifySuccess();
      setPw('');
      setPw2('');
      // The viewer offers Undo (its toast and "…" menu) until it is used or expires.
      const held = undo ? holdPdfEditUndo(target.id) ?? undo : null;
      const id = target.id;
      postViewerNotice({
        docId: id,
        message: 'PDF protected',
        action: held
          ? {
              label: 'Undo',
              onPress: () => {
                undoPdfEdit(held)
                  .then(() => {
                    bumpLastSaved();
                    notifySuccess();
                    postViewerNotice({ docId: id, message: 'Password removed' });
                  })
                  .catch(err => {
                    notifyError();
                    const changed = err instanceof PdfEditError && err.kind === 'changed';
                    Alert.alert('Couldn’t undo', changed ? 'The PDF has changed since.' : 'Your PDF is unchanged. Try again.');
                  });
              },
            }
          : undefined,
        onExpire: held ? () => discardPdfEditUndo(held) : undefined,
      });
      navigateWhenUnlocked(() => {
        if (fromViewer) router.back();
        else router.replace({ pathname: '/viewer', params: { id } });
      });
    } catch (err) {
      if (mounted.current) explain(err);
    } finally {
      abort.current = null;
      workingRef.current = false;
      if (mounted.current) {
        setWorking(false);
        setProgress(null);
      }
    }
  };

  if (!available) {
    return (
      <ToolScreen title="Protect PDF">
        <ToolIntro
          icon="lock-closed-outline"
          title={UNAVAILABLE.title}
          text={UNAVAILABLE.text}
        />
      </ToolScreen>
    );
  }

  if (loaded && docs.length === 0) {
    return (
      <ToolScreen
        title="Protect PDF"
        footer={
          <PrimaryButton
            title="Import a PDF"
            icon="document-outline"
            onPress={() => router.navigate({ pathname: '/(tabs)/files', params: { action: 'importFiles' } } as never)}
          />
        }
      >
        <ToolIntro
          icon="lock-closed-outline"
          title="No documents yet"
          text="Protect PDF adds a password that’s needed to open a PDF. Scan or import a document first, then come back."
        />
      </ToolScreen>
    );
  }

  const bars = STRENGTH_BARS[strength];
  const barColor = strength === 'weak' ? colors.danger : colors.accentFill;
  const hint = mismatch ? 'The passwords don’t match.' : pw.length === 0 ? `At least ${MIN_PDF_PASSWORD} characters.` : passwordHint(strength);
  const hintColor = mismatch ? colors.danger : colors.muted;
  const inputStyle = [Type.body, styles.input, { color: colors.text }];

  return (
    <ToolScreen
      title="Protect PDF"
      busy={working}
      footer={
        <>
          {progress && !isPdf ? (
            <ToolProgress
              label={progressLabel(progress)}
              current={progress.phase === 'protecting' ? 1 : progress.phase === 'building' ? progress.done / Math.max(1, progress.total) : 0}
              total={1}
            />
          ) : null}
          <PrimaryButton title="Protect PDF" icon="lock-closed-outline" onPress={start} disabled={!ready} loading={working} />
        </>
      }
    >
      <ToolDocPicker
        docs={docs}
        doc={doc}
        fixed={fixed}
        disabled={working}
        autoOpen
        note="Imported PDFs and scanned documents."
        onPick={d => setDocId(d.id)}
      />

      {doc ? (
        !current || current.status === 'loading' ? (
          <>
            <SectionLabel>Password</SectionLabel>
            <StatusLoading />
          </>
        ) : current.status === 'unreadable' ? (
          <>
            <SectionLabel>Password</SectionLabel>
            <StatusCard
              icon="alert-circle-outline"
              title="Couldn’t read this PDF"
              detail="The file may be damaged. Try importing it again."
            />
          </>
        ) : current.state.kind === 'has-password' ? (
          <>
            <SectionLabel>Password</SectionLabel>
            <StatusCard
              icon="lock-closed-outline"
              title="Already needs a password"
              detail="This PDF is already protected. To change its password, remove it with Unlock PDF first, then protect the unlocked copy."
            />
          </>
        ) : (
          <>
            <SectionLabel>Password</SectionLabel>
            <View style={[styles.card, { backgroundColor: colors.card }]}>
              <View style={[styles.row, styles.divider, { borderBottomColor: colors.border }]}>
                <TextInput
                  style={inputStyle}
                  value={pw}
                  onChangeText={setPw}
                  placeholder="Password"
                  placeholderTextColor={colors.muted}
                  secureTextEntry={!shown}
                  editable={!working}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  textContentType="none"
                  spellCheck={false}
                  keyboardAppearance={isDark ? 'dark' : 'light'}
                  returnKeyType="next"
                  submitBehavior="submit"
                  onSubmitEditing={() => confirmRef.current?.focus()}
                  accessibilityLabel="Password"
                  accessibilityHint={passwordHint(strength)}
                />
                <Pressable
                  onPress={() => setShown(v => !v)}
                  style={({ pressed }) => [styles.eye, pressed && { opacity: 0.5 }]}
                  hitSlop={4}
                  accessibilityRole="button"
                  accessibilityLabel={shown ? 'Hide password' : 'Show password'}
                >
                  <Ionicons name={shown ? 'eye-off-outline' : 'eye-outline'} size={22} color={colors.muted} />
                </Pressable>
              </View>
              <View style={styles.row}>
                <TextInput
                  ref={confirmRef}
                  style={inputStyle}
                  value={pw2}
                  onChangeText={setPw2}
                  placeholder="Enter it again"
                  placeholderTextColor={colors.muted}
                  secureTextEntry={!shown}
                  editable={!working}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  textContentType="none"
                  spellCheck={false}
                  keyboardAppearance={isDark ? 'dark' : 'light'}
                  returnKeyType="done"
                  onSubmitEditing={start}
                  accessibilityLabel="Enter the password again"
                />
              </View>
            </View>
            <View style={styles.hintRow} accessibilityLiveRegion="polite">
              <View style={styles.meter} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                {[1, 2, 3].map(i => (
                  <View key={i} style={[styles.bar, { backgroundColor: i <= bars ? barColor : colors.border }]} />
                ))}
              </View>
              <Text style={[Type.footnote, styles.hint, { color: hintColor }]}>{hint}</Text>
            </View>

            <View style={styles.gap} />
            <StatusCard
              icon="key-outline"
              title="Scan Kit can’t recover a forgotten password"
              detail="It isn’t kept anywhere. Without it, nobody can open the protected PDF — you included. Keep it somewhere safe, like a password manager."
            />

            <SectionLabel>Save</SectionLabel>
            {isPdf ? (
              <OptionList
                options={[
                  { value: 'copy', label: 'Save as a new document', detail: `“${protectedName(doc.name)}”. The original is kept.` },
                  { value: 'replace', label: 'Protect the original', detail: 'You can undo this right after.' },
                ]}
                value={output}
                onChange={chooseOutput}
              />
            ) : (
              <StatusCard
                icon="document-outline"
                title="Saved as a new PDF"
                detail={`“${protectedName(doc.name)}”. The scanned document is kept.`}
              />
            )}
            <ToolNote>
              {state?.kind === 'pdf' && state.signed
                ? 'Its digital signature won’t be valid in the protected PDF. It stays protected in Scan Kit too: you’ll enter the password to open it, and it goes out protected when you share it.'
                : 'It stays protected in Scan Kit too: you’ll enter the password to open it, and it goes out protected when you share it.'}
            </ToolNote>
          </>
        )
      ) : null}
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: Radius.md, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center' },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, minHeight: 50, paddingHorizontal: Spacing.lg },
  eye: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center', marginRight: Spacing.xs },
  hintRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm, marginTop: Spacing.sm, marginHorizontal: Spacing.xs, minHeight: 36 },
  meter: { flexDirection: 'row', gap: 3, marginTop: 6 },
  bar: { width: 14, height: 4, borderRadius: 2 },
  hint: { flex: 1, lineHeight: 18 },
  gap: { height: Spacing.md },
});
