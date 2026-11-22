// app/tools/unrestrict.tsx
// Unlock PDF: removes what an imported PDF's author restricts (printing,
// copying, page changes, comments, forms…) and, when it has one, its
// password to open, on the device (lib/pdf-unrestrict.ts). The screen first
// says, in plain words, what the chosen PDF restricts; a PDF with nothing to
// remove is said to be so and offers nothing. The result is a new document
// "<name> (unrestricted)" by default, the original kept (opened with Undo,
// lib/copy-undo.ts); or the original replaced in place, with Undo in the viewer.
// A PDF opened in Scan Kit this session (lib/pdf-session.ts; the viewer's
// "Remove password" leads here) uses that session's password, not asked again.
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useTheme } from '@/contexts/theme-context';
import { useScan } from '@/contexts/scan-context';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import { OptionList, ToolIntro, ToolNote, ToolScreen, useToolDocuments } from '@/components/tool-ui';
import { isPdfDoc, ToolDocPicker, useToolDoc } from '@/components/tool-doc';
import {
  canUnrestrictPdf,
  checkPdfPassword,
  PdfUnrestrictError,
  readPdfRestrictions,
  RESTRICTION_LABELS,
  saveUnrestrictedCopy,
  unrestrictedName,
  unrestrictStoredPdf,
  type PdfRestrictionState,
  type Restriction,
} from '@/lib/pdf-unrestrict';
import { discardPdfEditUndo, holdPdfEditUndo, PdfEditError, undoPdfEdit } from '@/lib/pdf-edit';
import { postViewerNotice } from '@/lib/viewer-notice';
import { openNewCopy } from '@/lib/copy-undo';
import { useToast } from '@/components/toast';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { sessionPassword, useSessionUnlocked } from '@/lib/pdf-session';
import { Radius, Spacing, Type } from '@/lib/theme';
import type { Document } from '@/types/document';
import type { IoniconName } from '@/components/app-icon';
import { showTextPrompt } from '@/components/text-prompt';

/** A build older than the feature (iOS and Android alike). */
const UNAVAILABLE = { title: 'Update Scan Kit to unlock PDFs', text: 'This version of Scan Kit can’t remove a PDF’s restrictions. Install the latest version, then try again.' };

type Output = 'copy' | 'replace';

const RESTRICTION_ICONS: Record<Restriction, IoniconName> = {
  print: 'print-outline',
  printQuality: 'print-outline',
  copy: 'copy-outline',
  pages: 'documents-outline',
  edit: 'create-outline',
  comment: 'chatbox-ellipses-outline',
  forms: 'list-outline',
  accessibility: 'accessibility-outline',
};

/** The chosen PDF's restrictions, for the document (and file version) they were read from. */
type Read =
  | { key: string; status: 'loading' }
  | { key: string; status: 'ready'; state: PdfRestrictionState }
  | { key: string; status: 'unreadable' };

const keyOf = (d: Document) => `${d.id}:${d.updatedAt}`;

export default function UnrestrictScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { bumpLastSaved } = useScan();
  const toast = useToast();
  const available = canUnrestrictPdf();
  const { docs, loaded, reload } = useToolDocuments(isPdfDoc);
  const { doc, setDocId, fixed, fromViewer } = useToolDoc(docs);
  const [output, setOutput] = useState<Output>('copy');
  // Read when the work starts, whichever render's handler started it.
  const outputRef = useRef<Output>('copy');
  const chooseOutput = (v: Output) => {
    outputRef.current = v;
    setOutput(v);
  };
  const [read, setRead] = useState<Read | null>(null);
  const [working, setWorking] = useState(false);
  const workingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const docKey = doc ? keyOf(doc) : null;
  const unlockedForSession = useSessionUnlocked(doc?.id);
  useEffect(() => {
    if (!doc || !docKey || !available) return;
    let cancelled = false;
    setRead({ key: docKey, status: 'loading' });
    readPdfRestrictions(doc)
      .then(({ state }) => { if (!cancelled) setRead({ key: docKey, status: 'ready', state }); })
      .catch(() => { if (!cancelled) setRead({ key: docKey, status: 'unreadable' }); });
    return () => { cancelled = true; };
    // `doc` is read through docKey (its id and version).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, available]);

  const current = read && read.key === docKey ? read : null;
  const state = current?.status === 'ready' ? current.state : null;
  const actionable = !!state && state.kind !== 'unrestricted';

  const explain = (err: unknown, retry: () => void) => {
    const kind = err instanceof PdfUnrestrictError ? err.kind : err instanceof PdfEditError ? err.kind : 'failed';
    notifyError();
    if (kind === 'wrong-password') {
      Alert.alert('That password isn’t right', 'Check it and try again. Passwords are case-sensitive.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Try again', onPress: retry },
      ]);
    } else if (kind === 'locked') {
      retry();
    } else if (kind === 'missing' || kind === 'changed') {
      reload();
      Alert.alert('Couldn’t unlock the PDF', 'The document changed in the meantime. Try again.');
    } else if (kind === 'unreadable') {
      Alert.alert('Couldn’t read this PDF', 'The file may be damaged. Try importing it again.');
    } else if (kind === 'partial') {
      Alert.alert('Your PDF was changed', 'Scan Kit couldn’t finish saving the change, so it can’t be undone. It’s finished the next time Scan Kit opens. Check that there’s free space.');
    } else {
      console.error('Unlock PDF failed', err);
      Alert.alert('Couldn’t unlock the PDF', 'Your PDF is unchanged. Check that there’s free space, then try again.');
    }
  };

  const run = async (target: Document, password: string | null, hadPassword: boolean) => {
    if (workingRef.current) return;
    workingRef.current = true;
    setWorking(true);
    const retry = () => askPassword(target, true);
    try {
      if (password !== null) await checkPdfPassword(target, password);
      const message = hadPassword ? 'PDF unlocked' : 'Restrictions removed';
      if (outputRef.current === 'copy') {
        const copy = await saveUnrestrictedCopy(target.id, password);
        bumpLastSaved();
        notifySuccess();
        // Opened with Undo, like Protect and Flatten PDF's copies (lib/copy-undo.ts).
        openNewCopy({
          copy,
          message: `${message}. The original is kept.`,
          what: 'unrestricted',
          sourceId: target.id,
          fromViewer,
          router,
          toast,
          bumpLastSaved,
        });
        return;
      }
      const { undo } = await unrestrictStoredPdf(target.id, password);
      bumpLastSaved();
      notifySuccess();
      // The viewer offers Undo (its toast and "…" menu) until it is used or expires.
      const held = undo ? holdPdfEditUndo(target.id) ?? undo : null;
      const id = target.id;
      postViewerNotice({
        docId: id,
        message,
        action: held
          ? {
              label: 'Undo',
              onPress: () => {
                undoPdfEdit(held)
                  .then(() => {
                    bumpLastSaved();
                    notifySuccess();
                    postViewerNotice({ docId: id, message: hadPassword ? 'Password put back' : 'Restrictions put back' });
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
      if (mounted.current) explain(err, retry);
    } finally {
      workingRef.current = false;
      if (mounted.current) setWorking(false);
    }
  };

  /** The same prompt the viewer uses for a locked PDF. */
  const askPassword = (target: Document, again = false) => {
    // Alert.prompt on iOS; Scan Kit's own prompt on Android (Alert.prompt is iOS-only).
    showTextPrompt(
      {
        title: again ? 'Enter the password again' : 'Enter the PDF’s password',
        message: `“${target.name}” needs a password to open. The unlocked PDF won’t.`,
        secure: true,
        confirmLabel: 'Unlock',
      },
      value => { run(target, value, true); },
    );
  };

  const start = () => {
    if (!doc || !state || workingRef.current) return;
    // Opened in Scan Kit this session (lib/pdf-session.ts): its password is
    // already known, so it isn't asked again.
    const known = state.kind === 'password' ? sessionPassword(doc.id) : null;
    if (known) run(doc, known, true);
    else if (state.kind === 'password') askPassword(doc);
    else if (state.kind === 'restricted') run(doc, null, false);
  };

  if (!available) {
    return (
      <ToolScreen title="Unlock PDF">
        <ToolIntro
          icon="lock-open-outline"
          title={UNAVAILABLE.title}
          text={UNAVAILABLE.text}
        />
      </ToolScreen>
    );
  }

  if (loaded && docs.length === 0) {
    return (
      <ToolScreen
        title="Unlock PDF"
        footer={
          <PrimaryButton
            title="Import a PDF"
            icon="document-outline"
            onPress={() => router.navigate({ pathname: '/(tabs)/files', params: { action: 'importFiles' } } as never)}
          />
        }
      >
        <ToolIntro
          icon="lock-open-outline"
          title="No PDFs yet"
          text="Unlock PDF removes a PDF’s password and restrictions, such as on printing or copying. Import a PDF first, then come back."
        />
      </ToolScreen>
    );
  }

  const buttonTitle = state?.kind === 'password'
    ? unlockedForSession ? 'Remove password' : 'Unlock with password'
    : 'Remove restrictions';

  return (
    <ToolScreen
      title="Unlock PDF"
      busy={working}
      footer={
        <PrimaryButton
          title={buttonTitle}
          icon="lock-open-outline"
          onPress={start}
          disabled={!actionable}
          loading={working}
        />
      }
    >
      <ToolDocPicker
        docs={docs}
        doc={doc}
        fixed={fixed}
        disabled={working}
        autoOpen
        note="Imported PDFs."
        onPick={d => setDocId(d.id)}
      />

      {doc ? (
        <>
          <SectionLabel>Protection</SectionLabel>
          {!current || current.status === 'loading' ? (
            <View style={[styles.card, styles.loading, { backgroundColor: colors.card }]}>
              <ActivityIndicator color={colors.muted} />
            </View>
          ) : current.status === 'unreadable' ? (
            <StatusCard
              icon="alert-circle-outline"
              title="Couldn’t read this PDF"
              detail="The file may be damaged. Try importing it again."
            />
          ) : current.state.kind === 'unrestricted' ? (
            <StatusCard
              icon="checkmark-circle-outline"
              title="No restrictions"
              detail="This PDF has no password and you can already print, copy, change and fill it in. There’s nothing to remove."
            />
          ) : current.state.kind === 'password' ? (
            <StatusCard
              icon="lock-closed-outline"
              title="Needs a password to open"
              detail={
                unlockedForSession
                  ? 'You entered its password in Scan Kit. The unlocked PDF opens without one, and anything else it restricts is removed too.'
                  : 'Enter it once. The unlocked PDF opens without one, and anything else it restricts is removed too.'
              }
            />
          ) : (
            <RestrictionList restrictions={current.state.restrictions} />
          )}

          {actionable ? (
            <>
              <SectionLabel>Save</SectionLabel>
              <OptionList
                options={[
                  { value: 'copy', label: 'Save as a new document', detail: `“${unrestrictedName(doc.name)}”. The original is kept.` },
                  { value: 'replace', label: 'Replace the original', detail: 'You can undo this right after.' },
                ]}
                value={output}
                onChange={chooseOutput}
              />
              <ToolNote>
                Pages aren’t redrawn: text stays selectable, and forms, comments and bookmarks are kept. Only use this for PDFs you’re allowed to change.
              </ToolNote>
            </>
          ) : null}
        </>
      ) : null}
    </ToolScreen>
  );
}

function StatusCard({ icon, title, detail }: { icon: IoniconName; title: string; detail: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, styles.status, { backgroundColor: colors.card }]} accessible accessibilityLabel={`${title}. ${detail}`}>
      <View style={[styles.tile, { backgroundColor: colors.accentLight }]}>
        <Ionicons name={icon} size={18} color={colors.accent} />
      </View>
      <View style={styles.flex}>
        <Text style={[Type.body, styles.title, { color: colors.text }]}>{title}</Text>
        <Text style={[Type.footnote, styles.detail, { color: colors.muted }]}>{detail}</Text>
      </View>
    </View>
  );
}

/** "Not allowed by its author:" and each restriction on its own row. */
function RestrictionList({ restrictions }: { restrictions: Restriction[] }) {
  const { colors } = useTheme();
  if (!restrictions.length) {
    // Opened with a password that restricted nothing else.
    return (
      <StatusCard
        icon="lock-closed-outline"
        title="Needs a password to open"
        detail="The unlocked PDF opens without one."
      />
    );
  }
  return (
    <View style={[styles.card, { backgroundColor: colors.card }]}>
      <Text
        style={[Type.footnote, styles.listHead, { color: colors.muted }]}
        accessibilityRole="header"
      >
        Its author doesn’t allow:
      </Text>
      {restrictions.map((r, i) => (
        <View key={r} style={styles.item}>
          <View style={[styles.tile, { backgroundColor: colors.accentLight }]}>
            <Ionicons name={RESTRICTION_ICONS[r]} size={18} color={colors.accent} />
          </View>
          <View
            style={[
              styles.itemBody,
              i < restrictions.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
            ]}
          >
            <Text style={[Type.body, { color: colors.text }]}>{RESTRICTION_LABELS[r]}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: { borderRadius: Radius.md, overflow: 'hidden' },
  loading: { paddingVertical: Spacing.xxl, alignItems: 'center' },
  status: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    paddingVertical: Spacing.md + 2,
    paddingHorizontal: Spacing.lg,
  },
  tile: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  title: { fontWeight: '600', marginTop: 4 },
  detail: { marginTop: Spacing.xs, lineHeight: 18 },
  listHead: { paddingTop: Spacing.md, paddingHorizontal: Spacing.lg, paddingBottom: Spacing.xs },
  item: { flexDirection: 'row', alignItems: 'center', paddingLeft: Spacing.lg },
  itemBody: { flex: 1, minHeight: 48, justifyContent: 'center', paddingRight: Spacing.lg, marginLeft: Spacing.md },
});
