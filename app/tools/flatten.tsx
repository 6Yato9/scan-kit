// app/tools/flatten.tsx
// Flatten PDF: an imported PDF's form-field values, signatures, added text,
// stamps and comments drawn into its pages, so they can't be changed or moved
// and every app shows them alike (lib/pdf-flatten.ts; the same native flatten
// as Share's "Flattened PDF"). The screen first says what the chosen PDF holds
// to flatten; a PDF with nothing to flatten (or one that can't be: locked,
// digitally signed, restricted) is said to be so and offers nothing.
//
// The result is a new document "<name> (flattened)" in the same folder (the
// default, the original kept; Undo removes it: lib/copy-undo.ts), or the
// original flattened in place, with Undo in the viewer.
import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { useScan } from '@/contexts/scan-context';
import { PrimaryButton } from '@/components/primary-button';
import { SectionLabel } from '@/components/section-label';
import { useToast } from '@/components/toast';
import { OptionList, ToolIntro, ToolNote, ToolScreen, useToolDocuments } from '@/components/tool-ui';
import { isPdfDoc, ToolDocPicker, useToolDoc } from '@/components/tool-doc';
import { StatusCard, StatusLoading } from '@/components/status-card';
import {
  canFlattenDocuments,
  flattenedName,
  flattenStoredPdf,
  flattenSummary,
  PdfFlattenError,
  readFlattenState,
  saveFlattenedCopy,
  type FlattenState,
} from '@/lib/pdf-flatten';
import { discardPdfEditUndo, holdPdfEditUndo, PdfEditError, undoPdfEdit } from '@/lib/pdf-edit';
import { openNewCopy } from '@/lib/copy-undo';
import { postViewerNotice } from '@/lib/viewer-notice';
import { notifyError, notifySuccess } from '@/lib/haptics';
import { navigateWhenUnlocked } from '@/lib/nav-guard';
import { protectedEditRefusal, withNoPasswordNote } from '@/lib/pdf-session';
import type { Document } from '@/types/document';
import { unavailableCopy } from '@/lib/platform-support';

/** iOS: a build older than the feature; Android: not built yet (lib/platform-support.ts). */
const UNAVAILABLE = unavailableCopy(
  { title: 'Update Scan Kit to flatten PDFs', text: 'This version of Scan Kit can’t flatten a PDF. Install the latest version, then try again.' },
  'Flatten PDF',
);

type Output = 'copy' | 'replace';

/** The chosen PDF's state, for the document (and file version) it was read from. */
type Read =
  | { key: string; status: 'loading' }
  | { key: string; status: 'ready'; state: FlattenState }
  | { key: string; status: 'unreadable' };

const keyOf = (d: Document) => `${d.id}:${d.updatedAt}`;

export default function FlattenScreen() {
  const router = useRouter();
  const toast = useToast();
  const { bumpLastSaved } = useScan();
  const available = canFlattenDocuments();
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
  useEffect(() => {
    if (!doc || !docKey || !available) return;
    let cancelled = false;
    setRead({ key: docKey, status: 'loading' });
    readFlattenState(doc)
      .then(state => { if (!cancelled) setRead({ key: docKey, status: 'ready', state }); })
      .catch(() => { if (!cancelled) setRead({ key: docKey, status: 'unreadable' }); });
    return () => { cancelled = true; };
    // `doc` is read through docKey (its id and version).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, available]);

  const current = read && read.key === docKey ? read : null;
  const state = current?.status === 'ready' ? current.state : null;
  const actionable = state?.kind === 'ready';

  const explain = (err: unknown) => {
    const kind = err instanceof PdfFlattenError ? err.kind : err instanceof PdfEditError ? err.kind : 'failed';
    notifyError();
    if (kind === 'missing' || kind === 'changed') {
      reload();
      Alert.alert('Couldn’t flatten the PDF', 'The document changed in the meantime. Try again.');
    } else if (kind === 'locked') {
      reload();
      Alert.alert('This PDF needs its password', 'Open it in the viewer and enter its password, then flatten it.');
    } else if (protectedEditRefusal(err)) {
      // A protected PDF unlocked this session that can't be written back as protected (lib/pdf-session.ts).
      const r = protectedEditRefusal(err)!;
      Alert.alert(r.title, r.body);
    } else if (kind === 'restricted') {
      Alert.alert('This PDF can’t be flattened', 'Its author doesn’t allow changing it. Unlock PDF can remove that restriction if you’re allowed to.');
    } else if (kind === 'unreadable') {
      Alert.alert('Couldn’t read this PDF', 'The file may be damaged. Try importing it again.');
    } else if (kind === 'partial') {
      Alert.alert('Your PDF was changed', 'Scan Kit couldn’t finish saving the change, so it can’t be undone. It’s finished the next time Scan Kit opens. Check that there’s free space.');
    } else {
      console.error('Flatten PDF failed', err);
      Alert.alert('Couldn’t flatten the PDF', 'Your PDF is unchanged. Check that there’s free space, then try again.');
    }
  };

  const start = async () => {
    if (!doc || !actionable || workingRef.current) return;
    workingRef.current = true;
    setWorking(true);
    const target = doc;
    try {
      if (outputRef.current === 'copy') {
        const copy = await saveFlattenedCopy(target.id);
        bumpLastSaved();
        notifySuccess();
        openNewCopy({
          copy,
          message: withNoPasswordNote('PDF flattened. The original is kept.', [target.id]),
          what: 'flattened',
          sourceId: target.id,
          fromViewer,
          router,
          toast,
          bumpLastSaved,
        });
        return;
      }
      const { undo } = await flattenStoredPdf(target.id);
      bumpLastSaved();
      notifySuccess();
      // The viewer offers Undo (its toast and "…" menu) until it is used or expires.
      const held = undo ? holdPdfEditUndo(target.id) ?? undo : null;
      const id = target.id;
      postViewerNotice({
        docId: id,
        message: 'PDF flattened',
        action: held
          ? {
              label: 'Undo',
              onPress: () => {
                undoPdfEdit(held)
                  .then(() => {
                    bumpLastSaved();
                    notifySuccess();
                    postViewerNotice({ docId: id, message: 'Form fields and comments put back' });
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
      workingRef.current = false;
      if (mounted.current) setWorking(false);
    }
  };

  if (!available) {
    return (
      <ToolScreen title="Flatten PDF">
        <ToolIntro
          icon="layers-outline"
          title={UNAVAILABLE.title}
          text={UNAVAILABLE.text}
        />
      </ToolScreen>
    );
  }

  if (loaded && docs.length === 0) {
    return (
      <ToolScreen
        title="Flatten PDF"
        footer={
          <PrimaryButton
            title="Import a PDF"
            icon="document-outline"
            onPress={() => router.navigate({ pathname: '/(tabs)/files', params: { action: 'importFiles' } } as never)}
          />
        }
      >
        <ToolIntro
          icon="layers-outline"
          title="No PDFs yet"
          text="Flatten PDF makes a filled-in form’s answers, signatures and comments part of the page, so they can’t be changed. Import a PDF first, then come back."
        />
      </ToolScreen>
    );
  }

  return (
    <ToolScreen
      title="Flatten PDF"
      busy={working}
      footer={<PrimaryButton title="Flatten PDF" icon="layers-outline" onPress={start} disabled={!actionable} loading={working} />}
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
          <SectionLabel>To flatten</SectionLabel>
          {!current || current.status === 'loading' ? (
            <StatusLoading />
          ) : current.status === 'unreadable' ? (
            <StatusCard icon="alert-circle-outline" title="Couldn’t read this PDF" detail="The file may be damaged. Try importing it again." />
          ) : (
            <FlattenStatus state={current.state} />
          )}

          {actionable ? (
            <>
              <SectionLabel>Save</SectionLabel>
              <OptionList
                options={[
                  { value: 'copy', label: 'Save as a new document', detail: `“${flattenedName(doc.name)}”. The original is kept.` },
                  { value: 'replace', label: 'Flatten the original', detail: 'You can undo this right after.' },
                ]}
                value={output}
                onChange={chooseOutput}
              />
              <ToolNote>
                What’s filled in and added becomes part of the page: it can’t be edited or moved afterwards. The text stays selectable and links keep working.
              </ToolNote>
            </>
          ) : null}
        </>
      ) : null}
    </ToolScreen>
  );
}

function FlattenStatus({ state }: { state: FlattenState }) {
  switch (state.kind) {
    case 'ready':
      return (
        <StatusCard
          icon="layers-outline"
          title={flattenSummary(state.formFields, state.annotations).replace(/^./, c => c.toUpperCase())}
          detail={
            state.formFields > 0 && state.annotations > 0
              ? 'The form’s answers, and its signatures, added text and comments, become part of the pages.'
              : state.formFields > 0
                ? 'The form’s answers become part of the pages. Empty fields stay empty.'
                : 'Its signatures, added text, stamps and comments become part of the pages.'
          }
        />
      );
    case 'nothing':
      return (
        <StatusCard
          icon="checkmark-circle-outline"
          title="Nothing to flatten"
          detail="This PDF has no form fields, signatures or comments. It’s already flat, so there’s nothing to do."
        />
      );
    case 'locked':
      return (
        <StatusCard
          icon="lock-closed-outline"
          title="Needs a password to open"
          detail="Open it in the viewer and enter its password first, then flatten it."
        />
      );
    case 'signed':
      return (
        <StatusCard
          icon="ribbon-outline"
          title="Digitally signed"
          detail="Flattening would break its digital signature, so Scan Kit won’t change it. You can still share it unchanged."
        />
      );
    case 'restricted':
      return (
        <StatusCard
          icon="hand-left-outline"
          title="Its author doesn’t allow changes"
          detail="This PDF can’t be filled in or commented on, so it can’t be flattened. Unlock PDF can remove that restriction if you’re allowed to."
        />
      );
  }
}
