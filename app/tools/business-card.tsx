// app/tools/business-card.tsx
// Business card → contact. Scan a card (or choose a photo of one); the text is
// recognized on the device, phone numbers, emails, links and the address are
// found by data detection, and the name, company and title by layout and
// keywords (lib/business-card.ts). The system New Contact form opens
// prefilled, with the card as the contact photo, for the user to check and
// save. The card can also go out as a contact card (.vcf), and the scan is
// kept as a document named "Business card – <name>".
import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useTheme } from '@/contexts/theme-context';
import { useScan } from '@/contexts/scan-context';
import { useToast } from '@/components/toast';
import { PrimaryButton } from '@/components/primary-button';
import { HeaderIconButton } from '@/components/screen-header';
import { ToolIntro, ToolScreen, useImageAspect, useToolDocuments } from '@/components/tool-ui';
import { ToolDocPicker } from '@/components/tool-doc';
import { documentReadPages, docReadErrorText } from '@/lib/doc-read';
import type { Document } from '@/types/document';
import { SectionLabel } from '@/components/section-label';
import { VisionOcr } from '@/modules/vision-ocr/src';
import { businessCardDocName, hasContactData, parseBusinessCard, type ParsedCard } from '@/lib/business-card';
import { canAddContact, canWriteVCard, detectData, presentNewContact, type ContactFields } from '@/lib/text-actions';
import { ocrAvailable, recognizeLines } from '@/lib/ocr';
import { indexDocText, saveScan } from '@/lib/save-scan';
import { getScanSettings } from '@/lib/storage';
import { autoName } from '@/lib/auto-name';
import { notifyError, notifySuccess, tapLight } from '@/lib/haptics';
import { alertScanError, deleteTempFiles, pickPhotos, renderSourcePage, scanPagesWithCamera } from '@/lib/tool-scan';
import { isSourceInput, type ScanPageInput } from '@/lib/page-source';
import { exportFileName, makeExportDir, shareFile, ShareError } from '@/lib/share';
import { HIT, Radius, Spacing, Type } from '@/lib/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

const QUALITY = { low: 0.5, medium: 0.75, high: 0.9 } as const;

/** Every saved document can hold a card: scans, and imported PDFs (rendered). */
const anyDoc = (d: Document) => d.pages.length > 0 || !!d.pdfUri;

type Result = ParsedCard & { image: string; docId: string | null; docName: string };

/** The rows the review card lists, in contact-form order. */
function fieldRows(f: ContactFields): { icon: IconName; label: string; value: string }[] {
  const rows: { icon: IconName; label: string; value: string }[] = [];
  const name = [f.namePrefix, f.givenName, f.middleName, f.familyName, f.nameSuffix].filter(Boolean).join(' ');
  if (name) rows.push({ icon: 'person-outline', label: 'Name', value: name });
  if (f.jobTitle) rows.push({ icon: 'briefcase-outline', label: 'Job title', value: f.jobTitle });
  if (f.organizationName) rows.push({ icon: 'business-outline', label: 'Company', value: f.organizationName });
  for (const p of f.phones ?? []) {
    rows.push({ icon: 'call-outline', label: p.label === 'mobile' ? 'Mobile' : p.label === 'fax' ? 'Fax' : 'Phone', value: p.number });
  }
  for (const e of f.emails ?? []) rows.push({ icon: 'mail-outline', label: 'Email', value: e });
  for (const u of f.urls ?? []) rows.push({ icon: 'globe-outline', label: 'Website', value: u.replace(/^https?:\/\//i, '').replace(/\/$/, '') });
  for (const a of f.addresses ?? []) {
    const value = [a.street, [a.postalCode, a.city].filter(Boolean).join(' '), a.state, a.country].filter(Boolean).join(', ');
    if (value) rows.push({ icon: 'location-outline', label: 'Address', value });
  }
  return rows;
}

export default function BusinessCardScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { show } = useToast();
  const { bumpLastSaved } = useScan();
  const { width: windowW } = useWindowDimensions();
  const [busy, setBusy] = useState<'camera' | 'photos' | 'doc' | null>(null);
  // A card already scanned: read from its document, which is kept as it is.
  const { docs } = useToolDocuments(anyDoc);
  const [result, setResult] = useState<Result | null>(null);
  const [sharing, setSharing] = useState(false);
  // Added to Contacts: leaving loses nothing, so Android's back doesn't ask.
  const [contactSaved, setContactSaved] = useState(false);
  const busyRef = useRef(false);
  const available = ocrAvailable();
  const cardAspect = useImageAspect(result?.image);

  const read = async (page: ScanPageInput, existing?: Document): Promise<Result | null> => {
    // The finished card image to read: rendered from a camera photo, or the picked image.
    const image = isSourceInput(page) ? await renderSourcePage(page, 0.9) : page;
    const temp = image !== page && !existing ? image : null;
    try {
      const { text, lines } = await recognizeLines(image);
      const found = await detectData(text);
      let entities: { people?: string[]; organizations?: string[] } = {};
      try {
        if (typeof VisionOcr?.nameEntities === 'function') entities = await VisionOcr.nameEntities(text);
      } catch {
        // names are a hint only
      }
      const parsed = parseBusinessCard(lines, found, entities);
      if (!hasContactData(parsed.fields)) return null;
      // A saved document: it already is the scan, so nothing new is kept.
      if (existing) return { ...parsed, image, docId: existing.id, docName: existing.name };

      // Keep the card as a document (camera captures keep their photo, so the crop can be widened later).
      const settings = await getScanSettings();
      const docName = businessCardDocName(parsed.displayName, autoName(new Date(), 'Business card'));
      let docId: string | null = null;
      let stored = image;
      try {
        const saved = await saveScan({ pages: [page], name: docName, quality: QUALITY[settings.quality] });
        docId = saved.id;
        stored = saved.pages[0] ?? image;
        bumpLastSaved();
        indexDocText(saved.id, saved.pages).catch(() => {});
      } catch (err) {
        console.error('Business card save failed', err);
      }
      return { ...parsed, image: stored, docId, docName };
    } finally {
      // Once the card is stored, the rendered copy is no longer needed.
      if (temp) deleteTempFiles([temp]);
    }
  };

  const run = async (source: 'camera' | 'photos' | Document) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const existing = typeof source === 'object' ? source : undefined;
    setBusy(existing ? 'doc' : (source as 'camera' | 'photos'));
    let picked: string[] = [];
    try {
      let pages: ScanPageInput[] | null;
      if (existing) {
        // Its first page (a card is one page), read where it is.
        try {
          pages = (await documentReadPages(existing)).slice(0, 1);
        } catch (err) {
          notifyError();
          const [title, message] = docReadErrorText(err);
          Alert.alert(title, message);
          return;
        }
      } else {
        try {
          pages =
            source === 'camera'
              ? await scanPagesWithCamera({ title: 'Business card', maxPages: 1, doneLabel: 'Read card', guidance: 'Fit the whole card in the frame' })
              : await pickPhotos(false);
        } catch (err) {
          alertScanError(err);
          return;
        }
      }
      if (!pages?.length) return;
      if (source === 'photos') picked = pages as string[];
      let next: Result | null = null;
      try {
        next = await read(pages[0], existing);
      } catch (err) {
        console.error('Business card read failed', err);
      }
      if (!next) {
        notifyError();
        Alert.alert('Couldn’t read the card', 'Make sure the whole card is in focus and well lit, then try again.');
        return;
      }
      notifySuccess();
      setResult(next);
      setContactSaved(false);
      const { docId, docName } = next;
      if (existing) {
        // Nothing was saved: the card was already a document.
      } else if (docId) {
        show(`Saved as “${docName}”`, {
          action: { label: 'Open', onPress: () => router.push({ pathname: '/viewer', params: { id: docId } }) },
        });
      } else {
        show('Couldn’t keep the scan, but the contact is ready');
      }
    } finally {
      deleteTempFiles(picked);
      busyRef.current = false;
      setBusy(null);
    }
  };

  const addContact = async () => {
    if (!result) return;
    tapLight();
    const outcome = await presentNewContact({ ...result.fields, imageUri: result.image });
    if (outcome === 'saved') {
      notifySuccess();
      setContactSaved(true);
      show('Contact saved');
    } else if (outcome === 'unavailable' || outcome === 'denied') {
      Alert.alert('Couldn’t open Contacts', 'Share the contact card instead, then open it in Contacts.');
    }
  };

  const shareCard = async () => {
    if (!result || sharing) return;
    const write = VisionOcr?.writeVCard;
    if (typeof write !== 'function') return;
    setSharing(true);
    try {
      const dir = await makeExportDir();
      const name = exportFileName(result.displayName ?? 'Contact', 'vcf');
      const uri = await write({ ...result.fields, imageUri: result.image }, `${dir}${encodeURIComponent(name)}`);
      await shareFile(uri, { mimeType: 'text/vcard', UTI: 'public.vcard', dialogTitle: result.displayName ?? 'Contact' });
    } catch (err) {
      notifyError();
      Alert.alert(
        'Couldn’t share the contact card',
        err instanceof ShareError ? err.message : 'Try again in a moment.',
      );
    } finally {
      setSharing(false);
    }
  };

  // ── Result ───────────────────────────────────────────────────────────────
  if (result) {
    const rows = fieldRows(result.fields);
    // The card at the width of the list under it (ToolScreen pads the body), never taller than wide.
    const imageW = Math.min(windowW - Spacing.gutter * 2, 440) - Spacing.sm * 2;
    const imageH = imageW * Math.min(cardAspect, 1);
    return (
      <ToolScreen
        title="Business card"
        confirmBack={contactSaved ? null : { title: 'Discard this card?', message: 'Its details haven’t been added to Contacts.' }}
        right={<HeaderIconButton icon="refresh-outline" label="Scan another card" onPress={() => setResult(null)} />}
        footer={
          <>
            <PrimaryButton
              title="Add to contacts"
              icon="person-add-outline"
              onPress={addContact}
              disabled={!canAddContact()}
            />
            <PrimaryButton
              title="Share contact card"
              icon="share-outline"
              variant="secondary"
              onPress={shareCard}
              loading={sharing}
              disabled={!canWriteVCard() || sharing}
            />
          </>
        }
      >
        <View style={styles.body}>
          <View style={[styles.cardFrame, { backgroundColor: colors.input }]}>
            <Image
              source={{ uri: result.image }}
              style={{ width: imageW, height: imageH, borderRadius: Radius.sm }}
              resizeMode="contain"
              accessibilityLabel="The scanned card"
            />
          </View>
          <SectionLabel style={styles.label}>Found on the card</SectionLabel>
          <View style={[styles.group, { backgroundColor: colors.card }]}>
            {rows.map((r, i) => (
              <View key={`${r.label}-${i}`} style={styles.row}>
                <View style={[styles.rowIcon, { backgroundColor: colors.accentLight }]}>
                  <Ionicons name={r.icon} size={18} color={colors.accent} />
                </View>
                <View
                  style={[
                    styles.rowBody,
                    i < rows.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
                  ]}
                >
                  <Text style={[Type.caption, { color: colors.muted }]}>{r.label}</Text>
                  <Text style={[Type.body, { color: colors.text }]} selectable>
                    {r.value}
                  </Text>
                </View>
              </View>
            ))}
          </View>
          <Text style={[Type.footnote, styles.note, { color: colors.muted }]}>
            Check the details in the contact form before saving. Nothing is added to Contacts until you tap Done.
          </Text>
        </View>
      </ToolScreen>
    );
  }

  // ── Start ────────────────────────────────────────────────────────────────
  return (
    <ToolScreen
      title="Business card"
      footer={
        <>
          <PrimaryButton
            title="Scan card"
            icon="camera-outline"
            onPress={() => run('camera')}
            disabled={!available || busy !== null}
            loading={busy === 'camera'}
          />
          <PrimaryButton
            title="Choose photo"
            icon="images-outline"
            variant="secondary"
            onPress={() => run('photos')}
            disabled={!available || busy !== null}
            loading={busy === 'photos'}
          />
        </>
      }
    >
      <ToolIntro
        icon="person-add-outline"
        title="Turn a card into a contact"
        text={
          available
            ? 'Scan a business card and Scan Kit fills in a new contact for you to check and save.'
            : 'Text recognition isn’t available on this device.'
        }
        points={
          available
            ? [
                { icon: 'lock-closed-outline', text: 'The card is read on this device. Nothing is uploaded.' },
                { icon: 'create-outline', text: 'Review every detail in the contact form before it’s saved.' },
                { icon: 'document-outline', text: 'The scan is kept in Files, named after the person.' },
              ]
            : undefined
        }
      />
      {available && docs.length ? (
        <>
          {/* A card scanned before: read from its document, which stays as it is. */}
          <ToolDocPicker
            docs={docs}
            doc={null}
            disabled={busy !== null}
            label="Or read a saved card"
            pickAfterClose
            onPick={d => { void run(d); }}
            note="Its first page is read. The document stays as it is."
          />
          {busy === 'doc' ? (
            <View style={styles.reading} accessibilityLiveRegion="polite">
              <ActivityIndicator color={colors.muted} />
              <Text style={[Type.footnote, { color: colors.muted }]}>Reading the card…</Text>
            </View>
          ) : null}
        </>
      ) : null}
    </ToolScreen>
  );
}

const styles = StyleSheet.create({
  body: { paddingTop: Spacing.md },
  cardFrame: { alignSelf: 'center', padding: Spacing.sm, borderRadius: Radius.md },
  label: { marginTop: Spacing.xl, marginHorizontal: Spacing.xs },
  group: { borderRadius: Radius.lg, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingLeft: Spacing.lg, minHeight: HIT + 12 },
  rowIcon: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1, marginLeft: Spacing.md, paddingVertical: Spacing.sm + 2, paddingRight: Spacing.lg, gap: 1 },
  note: { marginTop: Spacing.md, marginHorizontal: Spacing.xs, lineHeight: 18 },
  reading: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.md, marginHorizontal: Spacing.xs },
});
